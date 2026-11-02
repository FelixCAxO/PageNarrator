import { expect, it } from 'vitest';
import { fuseHalfRmsNorms, fuseHalfRmsNormTransposes } from '../../src/engines/onnx-rmsnorm.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';
import { halfToFloat } from '../../src/engines/tensor-format.js';

it('keeps every finite half input square exact in float32 before RMS accumulation', () => {
  let checked = 0;
  for (let bits = 0; bits < 65536; bits += 1) {
    if ((bits & 0x7c00) === 0x7c00) continue;
    const value = halfToFloat(bits), square = value * value;
    expect(Math.fround(square)).toBe(square);
    checked += 1;
  }
  expect(checked).toBe(63488);
});

function transposeFixture() {
  const nodes = [{ opType: 'FusedHalfRmsNorm', inputs: ['x', 'weight'], outputs: ['normal'], attrs: {} },
    { opType: 'Transpose', inputs: ['normal'], outputs: ['y'], attrs: { perm: [0, 2, 1, 3] } }];
  const weights = new Map([['weight', { dataType: 10, dims: [128] }]]);
  const types = new Map(['x', 'weight', 'normal', 'y'].map(name => [name, 10]));
  return { nodes, weights, types, fuse: () => fuseHalfRmsNormTransposes(nodes, weights, types) };
}

it('combines half head normalization and transpose while preserving named normalization outputs', () => {
  const f = transposeFixture(), fused = f.fuse();
  expect(fused[0]).toBe(f.nodes[0]);
  expect(fused[1]).toEqual({ opType: 'FusedHalfRmsNormTranspose', inputs: ['x', 'weight'], outputs: ['y'], attrs: {} });
  expect(selectExecutionPlan(fused, ['y']).nodes).toEqual([fused[1]]);
  expect(selectExecutionPlan(fused, ['y', 'normal']).nodes).toEqual(fused);
  expect(f.nodes[1].opType).toBe('Transpose');
});

it.each(['different permutation', 'unsupported width', 'float input', 'float weight', 'float normalization', 'float output',
  'transpose domain', 'normalization domain', 'transpose attribute', 'normalization attribute', 'transpose arity',
  'normalization arity', 'multiple outputs', 'implicit permutation', 'malformed permutation', 'unfused source'])('retains the original head-layout graph for %s', variant => {
  const f = transposeFixture(), [norm, transpose] = f.nodes;
  if (variant === 'different permutation') transpose.attrs.perm = [0, 1, 3, 2];
  if (variant === 'unsupported width') f.weights.get('weight').dims = [1024];
  if (variant === 'float input') f.types.set('x', 1);
  if (variant === 'float weight') f.weights.get('weight').dataType = 1;
  if (variant === 'float normalization') f.types.set('normal', 1);
  if (variant === 'float output') f.types.set('y', 1);
  if (variant === 'transpose domain') transpose.domain = 'custom';
  if (variant === 'normalization domain') norm.domain = 'custom';
  if (variant === 'transpose attribute') transpose.attrs.extra = 1;
  if (variant === 'normalization attribute') norm.attrs.extra = 1;
  if (variant === 'transpose arity') transpose.inputs.push('extra');
  if (variant === 'normalization arity') norm.inputs.pop();
  if (variant === 'multiple outputs') transpose.outputs.push('extra');
  if (variant === 'implicit permutation') delete transpose.attrs.perm;
  if (variant === 'malformed permutation') transpose.attrs.perm = '0,2,1,3';
  if (variant === 'unfused source') norm.opType = 'Mul';
  expect(f.fuse()).toEqual(f.nodes);
});

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
