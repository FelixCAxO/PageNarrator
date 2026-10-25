import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import * as oracle from 'onnxruntime-node';
import { kokoroProbeModelMode, prepareKokoroProbeModel, requireNewKokoroProbeReport } from '../../scripts/lib/kokoro-probe-model.mjs';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';

it('defaults both comparison paths to production and keeps explicit unmodified reproduction', async () => {
  expect(kokoroProbeModelMode([])).toBe('production');
  expect(kokoroProbeModelMode(['--phase-correction'])).toBe('production');
  expect(kokoroProbeModelMode(['--unmodified-model'])).toBe('unmodified-model');
  expect(() => kokoroProbeModelMode(['--unmodified-model', '--phase-correction'])).toThrow('not both');
  const bytes = Uint8Array.of(1, 2, 3);
  expect(await prepareKokoroProbeModel(bytes, 'unmodified-model')).toEqual({ bytes, mode: 'unmodified-model', phaseCorrection: null });
  expect((await prepareKokoroProbeModel(bytes, 'unmodified-model')).bytes).toBe(bytes);
  await expect(prepareKokoroProbeModel(bytes)).rejects.toThrow('exact pinned');
  await expect(prepareKokoroProbeModel(bytes, 'other')).rejects.toThrow('Unknown');
});

const graphs = [
  ['q8', 'model_quantized.onnx', 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', '20eea6d93cb15cd62102caa419192d64860acdc5fa112dbfbef828048bf76ac4'],
  ['fp32', 'model.onnx', '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb', 'c9b6ab36e923c2a9b8922f05771738b7aeb08653db38e52d871df243b0086880'],
];
for (const [dtype, file, originalSha256, modifiedSha256] of graphs) {
  const graphPath = `.cache/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/${file}`;
  it.skipIf(!existsSync(graphPath))(`keeps the pinned ${dtype} production graph valid for independent ORT without synthesis`, async () => {
    const bytes = new Uint8Array(readFileSync(graphPath)), hash = value => createHash('sha256').update(value).digest('hex');
    const original = hash(bytes), prepared = await prepareKokoroProbeModel(bytes);
    expect(original).toBe(originalSha256);
    expect(hash(bytes)).toBe(original);
    expect(prepared.mode).toBe('production');
    expect(hash(prepared.bytes)).toBe(modifiedSha256);
    expect(prepared.phaseCorrection).toMatchObject({ version: 'kokoro-exact-zero-phase-v2', originalSha256: original,
      serializationRevision: 'unique-node-names-v1', modifiedSha256 });
    expect(prepared.phaseCorrection.source).toContain('#L121-L124');
    expect(prepared.phaseCorrection.scope).toContain('not full signed-zero IEEE/Torch atan2');
    const names = decodeOnnxModel(prepared.bytes).graph.nodes.map(node => node.name).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
    const session = await oracle.InferenceSession.create(prepared.bytes, { executionProviders: ['cpu'],
      intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
    try { expect(session.inputNames).toEqual(['input_ids', 'style', 'speed']); expect(session.outputNames).toEqual(['waveform']); }
    finally { await session.release(); }
  }, 30_000);
}

it('wires the same prepared graph into each full-model candidate and independent reference', () => {
  const cpu = readFileSync('scripts/probe-kokoro-model-cpu.mjs', 'utf8');
  expect(cpu).toContain('WebGpuOnnxSession.create(probeModel, { engine })');
  expect(cpu).toContain('oracle.InferenceSession.create(probeModel,');
  expect(cpu).toContain('model${modelMode === \'production\' ? \'-production\' : \'\'}.json');
  const gpu = readFileSync('scripts/probe-kokoro-model-gpu.mjs', 'utf8');
  expect(gpu).toContain('oracle.InferenceSession.create(probeModel,');
  expect(gpu).toContain('response.end(probeModel)');
  const semantic = readFileSync('scripts/probe-kokoro-semantics.mjs', 'utf8');
  expect(semantic).toContain('createKokoroBrowserSession(probeModel, root)');
  expect(semantic).toContain('WebGpuOnnxSession.create(probeModel, { engine })');
  expect(semantic).toContain('oracle.InferenceSession.create(probeModel,');
  expect(semantic).not.toContain('Candidate applies a separately recorded');
});

it.each(['scripts/probe-kokoro-model-cpu.mjs', 'scripts/probe-kokoro-model-gpu.mjs', 'scripts/probe-kokoro-semantics.mjs'])('rejects conflicting model modes before inference in %s', script => {
  const result = spawnSync(process.execPath, [script, '--unmodified-model', '--phase-correction'], { encoding: 'utf8', windowsHide: true });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('not both');
});

it('preserves existing evidence instead of overwriting a historical report', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'pagenarrator-probe-model-'));
  try {
    const report = path.join(folder, 'new', 'report.json');
    await requireNewKokoroProbeReport(report);
    await writeFile(report, 'historical failure', { flag: 'wx' });
    await expect(requireNewKokoroProbeReport(report)).rejects.toThrow('Preserving existing');
    expect(await readFile(report, 'utf8')).toBe('historical failure');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
