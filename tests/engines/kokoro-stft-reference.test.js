import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

it('rounds the float32 window product before spectral accumulation', async () => {
  const signal = Float32Array.of(1 + 2 ** -23, -1), window = Float32Array.of(1 - 2 ** -24, 1);
  const model = kokoroOperatorFixture('STFT', [{ name: 'x', type: 1, shape: [1, 2] },
    { name: 'step', type: 7, shape: [] }, { name: 'window', type: 1, shape: [2] },
    { name: 'length', type: 7, shape: [] }], [{ name: 'y', type: 1, shape: [1, 1, 2, 2] }], { onesided: 1 });
  const reference = await oracle.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  try {
    const expected = (await reference.run({ x: new oracle.Tensor('float32', signal, [1, 2]),
      window: new oracle.Tensor('float32', window, [2]), step: new oracle.Tensor('int64', BigInt64Array.of(1n), []),
      length: new oracle.Tensor('int64', BigInt64Array.of(2n), []) })).y.data;
    expect(expected[0]).toBe(0);
    const batch = engine.batch(), output = engine.kokoro.stft(batch, engine.upload(signal, [1, 2]), engine.upload(window, [2]), { frameLength: 2, frameStep: 1 });
    batch.submit();
    const actual = await engine.read(output);
    expect([actual[0], actual[2]]).toEqual([expected[0], expected[2]]);
  } finally { await reference.release(); await engine.dispose(); }
});
