import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createNodeOcrReference } from '../../scripts/lib/ocr-node-reference.mjs';

function fixture() {
  const inputDispose = vi.fn(), outputDispose = vi.fn(), release = vi.fn();
  const session = { inputNames: ['image'], outputNames: ['probability'], release,
    run: vi.fn(async ({ image }) => ({ probability: { type: 'float32', data: image.data, dims: image.dims, dispose: outputDispose } })) };
  const runtime = { InferenceSession: { create: vi.fn(async () => session) },
    Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims, dispose: inputDispose }); } } };
  const bytes = Buffer.from(new Float32Array([Math.PI, -0, -2.5]).buffer);
  return { runtime, session, inputDispose, outputDispose, release, payload: { shape: [1, 3, 1, 1], base64: bytes.toString('base64') }, bytes };
}

it('transfers exact float32 bytes and fixes the independent CPU reference configuration', async () => {
  const test = fixture(), reference = await createNodeOcrReference(new Uint8Array([1]), { runtime: test.runtime });
  expect(test.runtime.InferenceSession.create).toHaveBeenCalledWith(new Uint8Array([1]), {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled', logSeverityLevel: 3,
  });
  const result = await reference.run(test.payload), sha256 = createHash('sha256').update(test.bytes).digest('hex');
  expect(result).toEqual({ inputSha256: sha256, outputs: { probability: { shape: test.payload.shape, base64: test.payload.base64, sha256 } } });
  expect(test.inputDispose).toHaveBeenCalledOnce(); expect(test.outputDispose).toHaveBeenCalledOnce();
  await reference.release(); expect(test.release).toHaveBeenCalledOnce();
});

it('rejects malformed transfer shapes and releases tensors after a bad reference result', async () => {
  const test = fixture(), reference = await createNodeOcrReference(new Uint8Array([1]), { runtime: test.runtime });
  for (const payload of [{ ...test.payload, shape: [1, 3, 0, 1] }, { ...test.payload, base64: 'garbage' }, { ...test.payload, shape: [1, 3, 1, 2] }]) {
    await expect(reference.run(payload)).rejects.toThrow(/shape/);
  }
  expect(test.session.run).not.toHaveBeenCalled();
  test.session.run.mockResolvedValue({ probability: { type: 'float32', data: new Float32Array([1]), dims: [2], dispose: test.outputDispose } });
  await expect(reference.run(test.payload)).rejects.toThrow('invalid float32 output');
  expect(test.inputDispose).toHaveBeenCalledOnce(); expect(test.outputDispose).toHaveBeenCalledOnce();
  test.session.run.mockRejectedValue(new Error('reference execution failed'));
  await expect(reference.run(test.payload)).rejects.toThrow('reference execution failed');
  expect(test.inputDispose).toHaveBeenCalledTimes(2);
  await reference.release(); expect(test.release).toHaveBeenCalledOnce();
});

it('releases a reference with an incompatible model interface before rejecting it', async () => {
  const test = fixture(); test.session.inputNames.push('unexpected');
  await expect(createNodeOcrReference(new Uint8Array([1]), { runtime: test.runtime })).rejects.toThrow('one detector input');
  expect(test.release).toHaveBeenCalledOnce();
});

it.each(['--benchmark', '--recognizer', '--unwarp', '--reduction-accuracy', '--checkpoint-index=12'])('rejects unsupported Node comparator combination %s before starting a browser', flag => {
  const result = spawnSync(process.execPath, ['scripts/probe-ocr-engine.mjs', '--node-reference', flag], { encoding: 'utf8', windowsHide: true });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('Node reference supports full detector parity only');
});
