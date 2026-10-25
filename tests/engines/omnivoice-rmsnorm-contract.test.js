import { readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyOmniVoiceRmsNormCorrection } from '../../src/tts/omnivoice/rmsnorm-correction.js';
import { rmsNormFixture, rmsNormHalfBoundaryFixture, matmulFixture, float32MatmulReference } from '../../scripts/lib/onnx-debug-outputs.mjs';
import { binary64ToHalf } from '../../scripts/lib/binary16-oracle.mjs';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { floatToHalf, halfToFloat } from '../../src/engines/tensor-format.js';

it('rejects unpinned graph bytes and preserves half rounding before learned-weight multiplication', async () => {
  await expect(applyOmniVoiceRmsNormCorrection(rmsNormFixture(1))).rejects.toThrow('exact pinned');
  const mutated = rmsNormFixture(1); mutated[mutated.length - 1] ^= 1;
  await expect(applyOmniVoiceRmsNormCorrection(mutated)).rejects.toThrow('exact pinned');
  expect(() => rmsNormFixture(0)).toThrow();
  const graph = decodeOnnxModel(rmsNormFixture(4)).graph;
  const [cast, multiply] = graph.nodes.slice(-2);
  expect(cast.opType).toBe('Cast');
  expect(cast.inputs).toEqual(['normalized']);
  expect(cast.attributes.get('to').value).toBe(10);
  expect(multiply.inputs).toEqual(['half', 'weight']);
  expect(graph.outputs.find(value => value.name === 'normalized').dataType).toBe(1);
  expect(graph.outputs.find(value => value.name === 'y').dataType).toBe(10);
});

it('retains finite float32 RMS normalization for actual overflow-sized controls in the original C++ engine', async () => {
  const data = Float32Array.of(0, 0, 0, 0, 1, -2, 3, -4, 300, -300, 600, -600, 65504, -65504, 65504, -65504);
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const session = await WebGpuOnnxSession.create(rmsNormFixture(4), { engine });
  try {
    const result = await session.run({ x: { shape: [4, 4], data } }, ['variance', 'normalized']);
    for (let row = 0; row < 4; row++) {
      const values = Array.from(data.subarray(row * 4, row * 4 + 4));
      const variance = values.reduce((sum, x) => sum + x * x, 0) / 4;
      expect(Math.abs(result.variance.data[row] - variance)).toBeLessThanOrEqual(1e-7 + 1e-6 * variance);
      for (let col = 0; col < 4; col++) {
        const expected = values[col] / Math.sqrt(variance + 1e-6);
        expect(Math.abs(result.normalized.data[row * 4 + col] - expected)).toBeLessThanOrEqual(1e-7 + 1e-6 * Math.abs(expected));
      }
      if (row >= 2) {
        expect(halfToFloat(floatToHalf(variance))).toBe(Infinity);
        expect(result.normalized.data[row * 4]).toBeGreaterThan(0);
      }
    }
    const boundary = await WebGpuOnnxSession.create(rmsNormHalfBoundaryFixture(result.normalized.data), { engine });
    try {
      const output = (await boundary.run({})).y.data;
      for (let index = 0; index < output.length; index++) {
        const rounded = halfToFloat(binary64ToHalf(result.normalized.data[index]));
        expect(output[index]).toBe(binary64ToHalf(rounded * [1, 2, .5, 3][index % 4]));
      }
    } finally { await boundary.dispose(); }
  } finally { await session.dispose(); await engine.dispose(); }
});

const model = '.cache/engine-models/MarkShark2/omnivoice-onnx-kv-b1-fp16/omnivoice-main-kv-fp16-b1.onnx';
it('keeps the independent MatMul precision control separate and rounds its result to the original half interface', () => {
  const original = matmulFixture(10, [2, 2], [2, 2]), reference = float32MatmulReference(original);
  const before = decodeOnnxModel(original).graph, after = decodeOnnxModel(reference.bytes).graph;
  expect(reference.promotedMatmuls).toBe(1);
  expect(after.inputs).toEqual(before.inputs); expect(after.outputs).toEqual(before.outputs);
  expect(after.nodes.map(node => node.opType)).toEqual(['Cast', 'Cast', 'MatMul', 'Cast']);
  expect(after.nodes.filter(node => node.opType === 'Cast').map(node => node.attributes.get('to').value)).toEqual([1, 1, 10]);
  expect(float32MatmulReference(matmulFixture(1, [2, 2], [2, 2])).promotedMatmuls).toBe(0);
  expect(() => float32MatmulReference(reference.bytes)).toThrow('already exist');
});

it.skipIf(!existsSync(model))('checks all 113 actual pinned signatures, derived bytes, public inputs and learned tensors', async () => {
  const original = new Uint8Array(readFileSync(model)), corrected = await applyOmniVoiceRmsNormCorrection(original);
  expect(corrected).toMatchObject({ norms: 113, modifiedSha256: '4ace0df24c6b611fd19f47bc5c44b482ef0e20acd868d81e4f2a2f24f807a0e0' });
  const before = decodeOnnxModel(original).graph, after = decodeOnnxModel(corrected.bytes).graph;
  expect(after.inputs).toEqual(before.inputs); expect(after.outputs).toEqual(before.outputs);
  expect(after.initializers).toEqual(before.initializers);
  const corrupt = original.slice(); corrupt[corrupt.length - 1] ^= 1;
  await expect(applyOmniVoiceRmsNormCorrection(corrupt)).rejects.toThrow('exact pinned');
  await expect(applyOmniVoiceRmsNormCorrection(corrected.bytes)).rejects.toThrow('exact pinned');
});
