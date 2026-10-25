import { expect, it } from 'vitest';
import { debugOutputModel, debugOverrideModel, matmulFixture, spatialMeanFixture, halfIntermediateFixture } from '../../scripts/lib/onnx-debug-outputs.mjs';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

it('adds a tensor checkpoint without changing original node or weight fields', () => {
  // Independent wire fields from the existing minimal Relu fixture.
  const relu = Uint8Array.from([58, 17, 10, 12, 10, 1, 120, 18, 1, 121, 34, 4, 82, 101, 108, 117, 18, 1, 103, 66, 2, 16, 17]);
  // This deliberately lacks input ValueInfo, so an unknown type is rejected.
  expect(() => debugOutputModel(relu, ['y'])).toThrow(/Unknown/);
  const typed = Uint8Array.from([58, 34, ...relu.slice(2, 19), 90, 15, 10, 1, 120, 18, 10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1]);
  const changed = debugOutputModel(typed, ['y']);
  expect(decodeOnnxModel(changed).graph.nodes).toEqual(decodeOnnxModel(typed).graph.nodes);
  expect(decodeOnnxModel(changed).graph.outputs).toEqual([{ name: 'y', dataType: 1, dims: null }]);
});

it('builds an explicit standard float16 MatMul fixture with typed dimensions', () => {
  const model = decodeOnnxModel(matmulFixture(10, [4, 1024], [1024, 96]));
  expect(model.graph.nodes[0]).toMatchObject({ opType: 'MatMul', inputs: ['a', 'b'], outputs: ['y'] });
  expect(model.graph.inputs.map(info => [info.dataType, info.dims])).toEqual([[10, [4, 1024]], [10, [1024, 96]]]);
  expect(model.graph.outputs[0]).toMatchObject({ dataType: 10, dims: [4, 96] });
});

it('exercises half negotiation without public half values or intermediate declarations', () => {
  const { graph } = decodeOnnxModel(halfIntermediateFixture(11));
  expect(graph.inputs).toEqual([{ name: 'x', dataType: 1, dims: [11] }]);
  expect(graph.outputs).toEqual([{ name: 'y', dataType: 1, dims: [11] }]);
  expect(graph.values).toEqual([]); expect(graph.initializers).toEqual([]);
  expect(graph.nodes.map(node => [node.opType, node.inputs, node.outputs, node.attributes.get('to').value]))
    .toEqual([['Cast', ['x'], ['half'], 10], ['Cast', ['half'], ['y'], 1]]);
  for (const length of [0, 4097, 1.5]) expect(() => halfIntermediateFixture(length)).toThrow(/length/);
});

it('declares a bounded float32 spatial mean without changing batch or channels', () => {
  const model = decodeOnnxModel(spatialMeanFixture([1, 32, 192, 320]));
  expect(model.graph.inputs[0]).toMatchObject({ name: 'x', dataType: 1, dims: [1, 32, 192, 320] });
  expect(model.graph.outputs[0]).toMatchObject({ name: 'y', dataType: 1, dims: [1, 32, 1, 1] });
  const node = model.graph.nodes[0];
  expect(node).toMatchObject({ opType: 'ReduceMean', inputs: ['x'], outputs: ['y'] });
  expect(node.attributes.get('axes').value).toEqual([2, 3]);
  expect(node.attributes.get('keepdims').value).toBe(1);
  expect(() => spatialMeanFixture([1, 32, 192])).toThrow();
  expect(() => spatialMeanFixture([1, 32, 192, 3200])).toThrow();
});

it('preserves exact declared types before guessing from operator inputs', () => {
  const original = kokoroOperatorFixture('DeclaredTypeChange', [{ name: 'x', type: 1, shape: [2] }], [{ name: 'y', type: 10, shape: [2] }]);
  const changed = decodeOnnxModel(debugOutputModel(original, ['y']));
  expect(changed.graph.outputs[0].dataType).toBe(10);
  expect(changed.graph.nodes).toEqual(decodeOnnxModel(original).graph.nodes);
});

it('infers distinct quantization output slots when intermediate declarations are absent', () => {
  const original = kokoroOperatorFixture('DynamicQuantizeLinear', [{ name: 'x', type: 1, shape: [2] }],
    ['q', 'scale', 'zero'].map(name => ({ name, type: 0, shape: null })));
  expect(decodeOnnxModel(debugOutputModel(original, ['q', 'scale', 'zero'])).graph.outputs.map(info => info.dataType)).toEqual([2, 1, 2]);
});

it('creates an explicit diagnostic float input without modifying retained original input or output metadata', () => {
  const bytes = matmulFixture(1, [2, 3], [3, 4]), original = decodeOnnxModel(bytes);
  const override = debugOverrideModel(bytes, 'y', [2, 4]), changed = decodeOnnxModel(override.bytes);
  expect(changed.graph.inputs.slice(0, 2)).toEqual(original.graph.inputs); expect(changed.graph.outputs).toEqual(original.graph.outputs);
  expect(changed.graph.nodes[0]).toMatchObject({ opType: 'Add', inputs: [override.inputName, 'pn_debug_zero'], outputs: ['y'] });
  expect(changed.graph.initializers[0]).toMatchObject({ name: 'pn_debug_zero', dataType: 1, dims: [] });
  expect([...changed.graph.initializers[0].rawData]).toEqual([0, 0, 0, 0]);
  expect(() => debugOverrideModel(bytes, 'absent', [2, 4])).toThrow();
  expect(() => debugOverrideModel(matmulFixture(10, [2, 3], [3, 4]), 'y', [2, 4])).toThrow();
  expect(() => debugOverrideModel(bytes, 'y', [2147483648])).toThrow();
});
