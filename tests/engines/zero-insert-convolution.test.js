import { afterEach, expect, it, vi } from 'vitest';
import { fuseZeroInsertConvolutions } from '../../src/engines/onnx-optimize.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const initializers = new Map();
  const integer = (name, values) => initializers.set(name, { name, dims: [values.length], dataType: 7,
    rawData: new Uint8Array(BigInt64Array.from(values, BigInt).buffer), typedData: new Map(), externalData: new Map(), dataLocation: 0 });
  for (const [name, values] of [['unsq', [0, 0, -1, 1]], ['pads', [0, 0, 0, 0, 0, 0, 0, 2]], ['flat', [0, 0, -1]],
    ['starts', [0]], ['ends', [-2]], ['axes', [2]], ['steps', [1]]]) integer(name, values);
  initializers.set('w', { name: 'w', dims: [5, 4, 6], dataType: 1 });
  const node = (opType, inputs, output, attrs = {}) => ({ name: output, opType, inputs, outputs: [output], attrs });
  const nodes = [node('Reshape', ['x', 'unsq'], 'a'), node('Pad', ['a', 'pads'], 'b', { mode: 'constant' }),
    node('Reshape', ['b', 'flat'], 'c', { allowzero: 0 }), node('Slice', ['c', 'starts', 'ends', 'axes', 'steps'], 'd'),
    node('Conv', ['d', 'w', 'bias'], 'y', { pads: [3, 3], strides: [1], dilations: [1] })];
  const infos = new Map([['x', { name: 'x', dataType: 1, dims: [1, 4, 'n'] }]]);
  return { nodes, initializers, infos, integer, run: (outputs, zeroTail = false) => fuseZeroInsertConvolutions(nodes, initializers, outputs ?? ['y'], infos, zeroTail) };
}

function tailFixture() {
  const f = fixture();
  f.integer('tail', [0, 0, 0, 0, 0, 1]);
  f.nodes.push({ name: 'post', opType: 'Pad', inputs: ['y', 'tail'], outputs: ['z'], attrs: { mode: 'constant' } });
  return f;
}

it('writes a private positive-zero tail directly to the declared padded output', () => {
  const f = tailFixture(), original = structuredClone(f.nodes);
  expect(f.run(['z'], true)).toEqual([{ ...f.nodes[4], name: 'post', opType: 'FusedZeroInsertConv1d', inputs: ['x', 'w', 'bias'], outputs: ['z'],
    attrs: { ...f.nodes[4].attrs, zeroInsertStride: 3, zeroTail: true } }]);
  expect(f.nodes).toEqual(original);
  expect(f.run(['z'])).toHaveLength(2);
});

it('preserves public or shared pre-pad convolution outputs', () => {
  const f = tailFixture();
  expect(f.run(['y', 'z'], true).map(n => n.opType)).toEqual(['FusedZeroInsertConv1d', 'Pad']);
  f.nodes.push({ name: 'branch', opType: 'Identity', inputs: ['y'], outputs: ['branch'], attrs: {} });
  expect(f.run(['z', 'branch'], true).map(n => n.opType)).toEqual(['FusedZeroInsertConv1d', 'Pad', 'Identity']);
});

it.each([
  ['larger tail', f => f.integer('tail', [0, 0, 0, 0, 0, 2])],
  ['left padding', f => f.integer('tail', [0, 0, 1, 0, 0, 0])],
  ['channel padding', f => f.integer('tail', [0, 0, 0, 0, 1, 0])],
  ['different rank', f => f.integer('tail', [0, 0, 0, 1])],
  ['edge mode', f => { f.nodes[5].attrs.mode = 'edge'; }],
  ['unknown attribute', f => { f.nodes[5].attrs.other = 1; }],
  ['axes input', f => { f.nodes[5].inputs.push('', 'axes'); }],
  ['custom domain', f => { f.nodes[5].domain = 'custom'; }],
  ['dynamic tail', f => { f.initializers.delete('tail'); }],
])('retains the output Pad for %s', (_name, change) => {
  const f = tailFixture(); change(f);
  const nodes = f.run(['z'], true);
  expect(nodes).toHaveLength(2); expect(nodes[0].attrs.zeroTail).toBeUndefined(); expect(nodes[1]).toBe(f.nodes[5]);
});

it('only absorbs explicit scalar positive zero at the output tail', () => {
  const f = tailFixture();
  f.nodes[5].inputs.push('value');
  const value = { name: 'value', dims: [], dataType: 1, rawData: null, typedData: new Map(), externalData: new Map(), dataLocation: 0 };
  f.initializers.set('value', value);
  for (const number of [0, -0, 1, -1]) {
    value.rawData = new Uint8Array(Float32Array.of(number).buffer);
    expect(f.run(['z'], true).length).toBe(Object.is(number, 0) ? 1 : 2);
  }
  value.rawData = new Uint8Array(Float32Array.of(0).buffer); value.dims = [1];
  expect(f.run(['z'], true)).toHaveLength(2);
});

it('requires the original upstream chain before absorbing its output pad', () => {
  const f = tailFixture(); f.nodes[3].attrs.other = 1;
  expect(f.run(['z'], true)).toEqual(f.nodes);
});

it('fuses the private zero-insertion chain without changing weights, convolution order or outputs', () => {
  const f = fixture(), original = structuredClone(f.nodes), weight = f.initializers.get('w');
  expect(f.run()).toEqual([{ ...f.nodes[4], opType: 'FusedZeroInsertConv1d', inputs: ['x', 'w', 'bias'], attrs: { ...f.nodes[4].attrs, zeroInsertStride: 3 } }]);
  expect(f.nodes).toEqual(original); expect(f.initializers.get('w')).toBe(weight);
});

it.each([0, 1, 2, 3])('preserves observable or shared intermediate %i', index => {
  const f = fixture(), name = f.nodes[index].outputs[0];
  expect(f.run(['y', name])).toEqual(f.nodes);
  f.nodes.push({ name: 'branch', opType: 'Identity', inputs: [name], outputs: ['branch'], attrs: {} });
  expect(f.run(['y', 'branch'])).toEqual(f.nodes);
});

it.each([
  ['changed leading reshape', f => f.integer('unsq', [0, 0, 1, -1])],
  ['changed flatten', f => f.integer('flat', [0, -1, 0])],
  ['changed pad axis', f => f.integer('pads', [0, 0, 0, 0, 0, 0, 2, 0])],
  ['changed slice start', f => f.integer('starts', [1])],
  ['changed slice end', f => f.integer('ends', [-1])],
  ['changed slice axis', f => f.integer('axes', [1])],
  ['changed slice step', f => f.integer('steps', [2])],
  ['unknown slice attribute', f => { f.nodes[3].attrs.other = 1; }],
  ['nonconstant padding', f => { f.nodes[1].attrs.mode = 'reflect'; }],
  ['literal zero reshape', f => { f.nodes[0].attrs.allowzero = 1; }],
  ['unknown rank', f => { f.infos.get('x').dims = null; }],
  ['different rank', f => { f.infos.get('x').dims = [1, 4, 'h', 'w']; }],
  ['half precision', f => { f.infos.get('x').dataType = 10; }],
  ['single channel per group', f => { f.initializers.get('w').dims[1] = 1; }],
  ['unknown weight shape', f => { f.initializers.delete('w'); }],
  ['custom operation domain', f => { f.nodes[0].domain = 'custom'; }],
])('leaves %s unchanged', (_name, change) => {
  const f = fixture(); change(f); expect(f.run()).toEqual(f.nodes);
});

it('only fuses explicit positive zero padding and retains the following output pad', () => {
  const f = fixture();
  f.initializers.set('zero', { name: 'zero', dims: [], dataType: 1, rawData: new Uint8Array(Float32Array.of(0).buffer), typedData: new Map(), externalData: new Map(), dataLocation: 0 });
  f.nodes[1].inputs.push('zero');
  f.nodes.push({ name: 'post', opType: 'Pad', inputs: ['y', 'tail'], outputs: ['z'], attrs: { mode: 'constant' } });
  expect(f.run(['z'])).toHaveLength(2); expect(f.run(['z'])[1]).toBe(f.nodes[5]);
  for (const value of [-0, 1, -1]) {
    f.initializers.get('zero').rawData = new Uint8Array(Float32Array.of(value).buffer);
    expect(f.run(['z'])).toEqual(f.nodes);
  }
});

it('only enables fusion with a prepared compact-convolution pipeline', () => {
  const f = tailFixture(); f.nodes[4].inputs.pop();
  const attribute = value => ({ type: typeof value === 'string' ? 3 : Array.isArray(value) ? 7 : 2,
    value: typeof value === 'string' ? new TextEncoder().encode(value) : value });
  const model = { graph: { inputs: [...f.infos.values()], outputs: [{ name: 'z', dataType: 1, dims: [1, 5, 'm'] }],
    initializers: [...f.initializers.values()], values: [], nodes: f.nodes.map(({ attrs, ...node }) => ({ ...node, attributes: new Map(Object.entries(attrs).map(([key, value]) => [key, attribute(value)])) })) }, functions: [], opsets: [{ version: 17 }] };
  const prepared = Object.assign(Object.create(WebGpuCompute.prototype), { cnn: { convZeroInsert1d: {} } });
  const gpu = new WebGpuOnnxSession(structuredClone(model), prepared, false, 1024);
  prepared.cnn.convZeroTail1d = {};
  const tail = new WebGpuOnnxSession(structuredClone(model), prepared, false, 1024);
  const cpu = new WebGpuOnnxSession(structuredClone(model), {}, false, 1024);
  expect(gpu.nodes.map(n => n.opType)).toEqual(['FusedZeroInsertConv1d', 'Pad']);
  expect(tail.nodes.map(n => n.opType)).toEqual(['FusedZeroInsertConv1d']); expect(tail.nodes[0].attrs.zeroTail).toBe(true);
  expect(cpu.nodes.map(n => n.opType)).toEqual(['Reshape', 'Pad', 'Reshape', 'Slice', 'Conv', 'Pad']);
});

it('rejects invalid insertion geometry before allocating intermediates', async () => {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 });
  const gpu = new WebGpuCompute({ addEventListener() {}, removeEventListener() {}, lost: new Promise(() => {}),
    limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 }, createCommandEncoder: () => ({}),
    createBuffer: ({ size }) => ({ size, destroy() {} }), queue: { onSubmittedWorkDone: async () => {} } }, false);
  try {
    const batch = gpu.batch(), x = gpu.tensor([1, 4, 7]), weights = gpu.tensor([5, 4, 6]);
    for (const zeroInsertStride of [-1, 0, 1.5, NaN, Infinity, 2 ** 31]) expect(() => batch.convolution(x, weights, null, { zeroInsertStride })).toThrow(/zero-insert/);
    for (const zeroTail of [0, 1, 'true', {}, []]) expect(() => batch.convolution(x, weights, null, { zeroInsertStride: 3, zeroTail })).toThrow(/zero-tail/);
    expect(() => batch.convolution(x, weights, null, { zeroTail: true })).toThrow(/zero-tail/);
    expect(() => batch.convolution(x, weights, null, { zeroInsertStride: 3, transpose: true })).toThrow(/zero-insert/);
    expect(() => batch.convolution(gpu.tensor([0, 4, 7]), weights, null, { zeroInsertStride: 3 })).toThrow(/zero-insert/);
    expect(() => batch.convolution(gpu.tensor([1, 4, 1, 7]), weights, null, { zeroInsertStride: 3 })).toThrow(/zero-insert/);
    expect(batch.allocationCount).toBe(0);
  } finally { await gpu.dispose(); }
});
