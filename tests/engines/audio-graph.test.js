import { expect, it } from 'vitest';
import { integerAddRange, integerRange, modelFeed } from '../../src/engines/bounded-integers.js';
import { liftConvolution, convolutionPlan } from '../../src/engines/cnn-shape.js';
import { fuseSnakeActivations } from '../../src/engines/onnx-optimize.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';

it('preserves exact integer boundaries and rejects silent int64 truncation or overflow', () => {
  const data = BigInt64Array.of(-2147483648n, 2147483647n, 0n);
  const converted = modelFeed({ name: 'codes', dataType: 7, dims: [3] }, { data, shape: [3] });
  expect(converted.data).toEqual(Int32Array.of(-2147483648, 2147483647, 0));
  expect(integerRange(data)).toEqual({ min: -2147483648, max: 2147483647 });
  expect(() => modelFeed({ name: 'codes', dataType: 7 }, { data: BigInt64Array.of(2147483648n), shape: [1] })).toThrow(/exact/);
  expect(() => integerAddRange(converted.bounds, { min: 1, max: 1 })).toThrow(/overflow/);
  expect(integerAddRange({ min: 0, max: 1023 }, { min: 0, max: 7168 })).toEqual({ min: 0, max: 8191 });
});

it('rejects mismatched feed shapes and types before allocating GPU storage', () => {
  const info = { name: 'audio_codes', dataType: 7, dims: [1, 8, 'frames'] };
  expect(() => modelFeed(info, { data: new BigInt64Array(8), shape: [2, 4, 1] })).toThrow(/shape/);
  expect(() => modelFeed(info, { data: new Float32Array(8), shape: [1, 8, 1] })).toThrow(/type/);
  expect(() => modelFeed(info, { data: new BigInt64Array(7), shape: [1, 8, 1] })).toThrow(/count/);
});

it('lifts grouped dilated 1-D convolution and transposed padding without expanding data', () => {
  const lifted = liftConvolution([2, 4, 7], [6, 2, 3], { group: 2, dilations: [2], pads: [1, 2], strides: [2] });
  expect(convolutionPlan(lifted.input, lifted.weights, lifted.options).shape).toEqual([2, 6, 1, 3]);
  const transpose = liftConvolution([1, 4, 5], [4, 3, 3], { group: 2, transpose: true, strides: [2], pads: [1, 0], outputPadding: [1] });
  expect(convolutionPlan(transpose.input, transpose.weights, transpose.options).shape).toEqual([1, 6, 1, 11]);
  expect(() => liftConvolution([1, 4, 7], [4, 4, 1, 3], {})).toThrow(/ranks/);
  expect(() => liftConvolution([1, 4, 7], [4, 4, 3], { pads: [1] })).toThrow(/padding/);
});

function snakeFixture() {
  const node = (opType, inputs, output) => ({ opType, inputs, outputs: [output], attrs: {} });
  const nodes = [node('Mul', ['alpha', 'x'], 'phase'), node('Sin', ['phase'], 'sine'), node('Pow', ['sine', 'two'], 'square'),
    node('Mul', ['scale', 'square'], 'scaled'), node('Add', ['x', 'scaled'], 'result')];
  const two = { name: 'two', dataType: 1, dims: [], rawData: new Uint8Array(Float32Array.of(2).buffer), typedData: new Map(), externalData: new Map(), dataLocation: 0 };
  return { nodes, initializers: new Map([['two', two]]) };
}

it('fuses a private snake chain while preserving a separate scale input', () => {
  const { nodes, initializers } = snakeFixture();
  expect(fuseSnakeActivations(nodes, initializers, ['result'])).toEqual([{ ...nodes[4], opType: 'FusedSnake', inputs: ['x', 'alpha', 'scale'] }]);
  expect(nodes).toHaveLength(5);
});

it('does not remove observable or shared intermediate values', () => {
  const { nodes, initializers } = snakeFixture();
  expect(fuseSnakeActivations(nodes, initializers, ['result', 'sine'])).toEqual(nodes);
  const extra = { opType: 'Identity', inputs: ['square'], outputs: ['extra'], attrs: {} };
  expect(fuseSnakeActivations([...nodes, extra], initializers, ['result', 'extra'])).toEqual([...nodes, extra]);
});

it('refuses a changed exponent, broadcast-altering exponent rank or changed activation input', () => {
  const { nodes, initializers } = snakeFixture();
  nodes[4].inputs[0] = 'other';
  expect(fuseSnakeActivations(nodes, initializers, ['result'])).toEqual(nodes);
  nodes[4].inputs[0] = 'x'; initializers.get('two').dims = [1];
  expect(fuseSnakeActivations(nodes, initializers, ['result'])).toEqual(nodes);
  initializers.get('two').dims = []; initializers.get('two').rawData = new Uint8Array(Float32Array.of(3).buffer);
  expect(fuseSnakeActivations(nodes, initializers, ['result'])).toEqual(nodes);
});

it('refuses ambiguous model interfaces and mismatched declared outputs', async () => {
  const graph = { initializers: [], inputs: [{ name: 'x', dataType: 1, dims: [1] }], outputs: [{ name: 'y', dataType: 1, dims: [1] }],
    nodes: [{ opType: 'Identity', inputs: ['x'], outputs: ['y'], attributes: new Map() }] };
  const create = () => new WebGpuOnnxSession({ graph, opsets: [{ version: 17 }], functions: [] }, {}, false, 0);
  const session = create();
  await expect(session.readOutputs(new Map([['y', { cpu: true, data: [1], shape: [1], dataType: 7 }]]))).rejects.toThrow(/declared/);
  graph.inputs.push(graph.inputs[0]); expect(create).toThrow(/duplicate/); graph.inputs.pop();
  graph.outputs[0].dataType = 16; expect(create).toThrow(/type/);
});
