import { readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyOmniVoiceRmsNormCorrection, prepareOmniVoiceGraph } from '../../src/tts/omnivoice/rmsnorm-correction.js';
import { rmsNormFixture, rmsNormHalfBoundaryFixture, matmulFixture, float32MatmulReference } from '../../tooling/scripts/lib/onnx-debug-outputs.mjs';
import { binary64ToHalf } from '../../tooling/scripts/lib/binary16-oracle.mjs';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { floatToHalf, halfToFloat } from '../../src/engines/tensor-format.js';
import { metadataInputNames } from '../../src/engines/onnx-metadata-inputs.js';
import { constantNumbers } from '../../src/engines/onnx-tensor.js';

const model = '.cache/engine-models/MarkShark2/omnivoice-onnx-kv-b1-fp16/omnivoice-main-kv-fp16-b1.onnx';

it('rejects unpinned graph bytes and preserves half rounding before learned-weight multiplication', async () => {
  await expect(applyOmniVoiceRmsNormCorrection(rmsNormFixture(1))).rejects.toThrow('exact pinned');
  await expect(prepareOmniVoiceGraph(rmsNormFixture(1))).rejects.toThrow('exact pinned');
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

it.skipIf(!existsSync(model))('selects generated head rows and broadcasts grouped attention while preserving learned tensors and other calculations', async () => {
  const original = new Uint8Array(readFileSync(model));
  const normalized = await applyOmniVoiceRmsNormCorrection(original), selected = await prepareOmniVoiceGraph(original);
  expect(selected.modifiedSha256).toBe('8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb');
  const before = decodeOnnxModel(normalized.bytes), after = decodeOnnxModel(selected.bytes);
  expect(after.graph.initializers).toEqual(before.graph.initializers);
  expect(after.graph.inputs.slice(0, -1)).toEqual(before.graph.inputs);
  expect(after.graph.inputs.at(-1)).toEqual({ name: 'pn_audio_start', dataType: 7, dims: [1] });
  expect(metadataInputNames(after.graph.nodes, after.graph.inputs.map(input => input.name)).has('pn_audio_start')).toBe(true);
  expect(after.graph.outputs.slice(1)).toEqual(before.graph.outputs.slice(1));
  expect(after.graph.outputs[0]).toEqual({ name: 'audio_logits', dataType: 10, dims: ['batch', 8, 'generated_frames', 1025] });
  expect(after.opsets).toEqual(before.opsets);
  const changed = new Set(['/Shape', '/Shape_1', '/audio_heads/MatMul']);
  const replacements = new Map(), removedValues = new Set(), named = new Map(after.graph.nodes.map(node => [node.name, node]));
  const producers = new Map(before.graph.nodes.flatMap(node => node.outputs.map(output => [output, node])));
  for (let layer = 0; layer < 28; layer++) {
    const prefix = `/llm/layers.${layer}/self_attn/`, stem = `pn_gqa_${layer}_`;
    for (const suffix of ['Expand', 'Expand_1', 'Reshape_4', 'Reshape_6']) {
      const node = before.graph.nodes.find(node => node.name === prefix + suffix);
      replacements.set(node.name, { ...node, opType: 'Identity', inputs: [node.inputs[0]], attributes: new Map() }); removedValues.add(node.outputs[0]);
    }
    const transpose = before.graph.nodes.find(node => node.name === prefix + 'Transpose_3');
    replacements.set(transpose.name, { ...transpose, attributes: new Map([['perm', { ...transpose.attributes.get('perm'), value: [0, 1, 2, 4, 3] }]]) });
    removedValues.add(transpose.outputs[0]);
    for (const [suffix, operation] of [['MatMul', 'qk'], ['MatMul_1', 'pv']]) {
      const node = before.graph.nodes.find(node => node.name === prefix + suffix);
      replacements.set(node.name, { ...node, inputs: [stem + operation + '_input', node.inputs[1]], outputs: [stem + operation + '_output'] });
      expect(named.get(stem + operation + '_restore')).toMatchObject({ opType: 'Reshape', outputs: node.outputs });
      expect(named.get(stem + operation + '_input')).toMatchObject({ opType: 'Reshape', inputs: [node.inputs[0], operation === 'qk' ? 'pn_gqa_query_shape' : stem + 'grouped'] });
      if (operation === 'qk') removedValues.add(producers.get(node.inputs[1]).outputs[0]);
    }
    expect(named.get(stem + 'length')).toMatchObject({ opType: 'Gather', inputs: [stem + 'shape', 'pn_gqa_sequence_axis'] });
    expect(named.get(stem + 'flat')).toMatchObject({ opType: 'Concat', inputs: ['pn_gqa_flat_prefix', stem + 'length'] });
    expect(named.get(stem + 'grouped')).toMatchObject({ opType: 'Concat', inputs: ['pn_gqa_group_prefix', stem + 'length'] });
  }
  const nodes = after.graph.nodes.filter(node => !node.name.startsWith('pn_'));
  expect(nodes).toEqual(before.graph.nodes.map(node => replacements.get(node.name) ?? (changed.has(node.name) ? { ...node, inputs: ['pn_audio_hidden', ...node.inputs.slice(1)] } : node)));
  expect(after.graph.values).toEqual(before.graph.values.filter(info => !removedValues.has(info.name)));
  for (const [name, values] of [['sequence_axis', [3]], ['query_shape', [1, 8, 2, -1, 128]], ['output_shape', [1, 16, -1, 128]], ['flat_prefix', [1, 16, -1]], ['group_prefix', [1, 8, 2, -1]]]) {
    expect(constantNumbers(named.get('pn_gqa_' + name).attributes.get('value').value)).toEqual(values);
  }
  expect(after.graph.nodes.find(node => node.name === 'pn_audio_hidden')).toMatchObject({ opType: 'Slice',
    inputs: ['/llm/norm/Mul_1_output_0', 'pn_audio_start', 'pn_audio_end', 'pn_audio_axis'] });
  expect(selected.normalizationSha256).toBe(normalized.modifiedSha256);
  await expect(prepareOmniVoiceGraph(normalized.bytes)).rejects.toThrow('exact pinned');
  await expect(prepareOmniVoiceGraph(selected.bytes)).rejects.toThrow('exact pinned');
});

it('retains finite float32 RMS normalization for actual overflow-sized controls in the original C++ engine', async () => {
  const data = Float32Array.of(0, 0, 0, 0, 1, -2, 3, -4, 300, -300, 600, -600, 65504, -65504, 65504, -65504);
  const engine = await WasmKokoroCompute.create(readFileSync('extension/public/native/kokoro-engine.wasm'));
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
