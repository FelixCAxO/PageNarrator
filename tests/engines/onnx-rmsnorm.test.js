import { expect, it } from 'vitest';
import { fuseHalfRmsNorms } from '../../src/engines/onnx-rmsnorm.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';

function fixture() {
  const scalar = value => ({ dataType: 1, dims: [], rawData: new Uint8Array(Float32Array.of(value).buffer), typedData: new Map(), externalData: new Map() });
  const initializers = new Map([['weight', { dataType: 10, dims: [128] }], ['two', scalar(2)], ['one', scalar(1)], ['epsilon', scalar(1e-6)]]);
  const node = (opType, inputs, output, attrs = {}) => ({ opType, inputs, outputs: [output], attrs });
  const nodes = [node('Cast', ['x'], 'source', { to: 1 }), node('Cast', ['two'], 'exponent', { to: 1 }),
    node('Pow', ['source', 'exponent'], 'square'), node('ReduceMean', ['square'], 'mean', { axes: [-1], keepdims: 1 }),
    node('Cast', ['mean'], 'variance', { to: 1 }), node('Add', ['variance', 'epsilon'], 'adjusted'),
    node('Sqrt', ['adjusted'], 'root'), node('Div', ['one', 'root'], 'inverse'),
    node('Cast', ['source'], 'input', { to: 1 }), node('Mul', ['input', 'inverse'], 'normalized'),
    node('Cast', ['normalized'], 'output', { to: 1 }), node('Cast', ['output'], 'half', { to: 10 }),
    node('Mul', ['weight', 'half'], 'y')];
  const types = new Map([['x', 10]]);
  return { nodes, initializers, types, fuse: () => fuseHalfRmsNorms(nodes, initializers, types) };
}

it('fuses half RMSNorm while retaining observable normalization intermediates', () => {
  const f = fixture(), fused = f.fuse();
  expect(fused.at(-1)).toMatchObject({ opType: 'FusedHalfRmsNorm', inputs: ['x', 'weight'], outputs: ['y'] });
  expect(selectExecutionPlan(fused, ['y']).nodes.map(node => node.opType)).toEqual(['FusedHalfRmsNorm']);
  const observable = selectExecutionPlan(fused, ['y', 'mean']).nodes;
  expect(observable).toContain(f.nodes[3]);
  expect(observable.at(-1).opType).toBe('FusedHalfRmsNorm');
  expect(f.nodes.at(-1).opType).toBe('Mul');
});

it.each(['half variance', 'float input', 'different epsilon', 'different axis', 'unknown attribute', 'missing half boundary', 'unsupported width'])('preserves the original graph for %s', variant => {
  const f = fixture();
  if (variant === 'half variance') f.nodes[4].attrs.to = 10;
  if (variant === 'float input') f.types.set('x', 1);
  if (variant === 'different epsilon') f.initializers.get('epsilon').rawData = new Uint8Array(Float32Array.of(1e-5).buffer);
  if (variant === 'different axis') f.nodes[3].attrs.axes = [0];
  if (variant === 'unknown attribute') f.nodes[2].attrs.unknown = 1;
  if (variant === 'missing half boundary') f.nodes[11].attrs.to = 1;
  if (variant === 'unsupported width') f.initializers.get('weight').dims = [256];
  expect(f.fuse()).toEqual(f.nodes);
});
