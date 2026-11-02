import { expect, it, vi } from 'vitest';
import { executeHalfRotary, fuseHalfRotaryEmbeddings } from '../../src/engines/onnx-rotary.js';
import { metadataInputNames, metadataParameters } from '../../src/engines/onnx-metadata-inputs.js';

const node = (opType, inputs, output, attrs = {}) => ({ opType, inputs, outputs: [output], attrs });
function fixture() {
  const nodes = [node('Mul', ['x', 'cos'], 'direct'), node('Slice', ['x', 'startA', 'endA', 'axis', 'stepA'], 'left'),
    node('Slice', ['x', 'startB', 'endB', 'axis', 'stepB'], 'right'), node('Neg', ['right'], 'negative'),
    node('Concat', ['negative', 'left'], 'rotated', { axis: -1 }), node('Mul', ['rotated', 'sin'], 'product'), node('Add', ['direct', 'product'], 'out')];
  const types = new Map(['x', 'cos', 'sin', 'direct', 'left', 'right', 'negative', 'rotated', 'product', 'out'].map(name => [name, 10]));
  return { nodes, types };
}
it('fuses the exact half rotary chain and keeps every original intermediate producer', () => {
  const { nodes, types } = fixture(), result = fuseHalfRotaryEmbeddings(nodes, types);
  expect(result).toHaveLength(nodes.length); nodes.slice(0, -1).forEach((n, i) => expect(result[i]).toBe(n));
  expect(result.at(-1)).toMatchObject({ opType: 'FusedHalfRotary', outputs: ['out'], attrs: {},
    inputs: ['x', 'cos', 'sin', 'startA', 'endA', 'axis', 'stepA', 'startB', 'endB', 'axis', 'stepB'] });
});
it.each(['foreign', 'multiply-attribute', 'concat-axis', 'slice-attribute', 'neg-inputs', 'different-source', 'unknown-type'])('keeps unsupported %s chains unchanged', reason => {
  const { nodes, types } = fixture();
  if (reason === 'foreign') nodes[6].domain = 'custom';
  if (reason === 'multiply-attribute') nodes[0].attrs.extra = 1;
  if (reason === 'concat-axis') nodes[4].attrs.axis = 0;
  if (reason === 'slice-attribute') nodes[1].attrs.extra = 1;
  if (reason === 'neg-inputs') nodes[3].inputs.push('extra');
  if (reason === 'different-source') nodes[2].inputs[0] = 'other';
  if (reason === 'unknown-type') types.delete('cos');
  expect(fuseHalfRotaryEmbeddings(nodes, types)).toEqual(nodes);
});
it('leaves float32 arithmetic on its original path', () => {
  const { nodes, types } = fixture(); for (const name of types.keys()) types.set(name, 1);
  expect(fuseHalfRotaryEmbeddings(nodes, types)).toEqual(nodes);
});

function execution() {
  const { nodes, types } = fixture(), fused = fuseHalfRotaryEmbeddings(nodes, types).at(-1);
  const input = { shape: [1, 2, 3, 6], dataType: 'float16' }, cosine = {}, sine = {}, calls = [];
  const params = { startA: [0], endA: [3], axis: [3], stepA: [1], startB: [3], endB: [(1n << 63n) - 1n], stepB: [1] };
  const batch = { rotary: vi.fn(() => 'fused'), binary: vi.fn((op, a, b) => { calls.push(op); return { a, b }; }),
    index: vi.fn(() => ({})), unary: vi.fn(() => ({})), concat: vi.fn(() => ({})), recycle: vi.fn() };
  const numbers = vi.fn(name => params[name]);
  const run = () => executeHalfRotary(fused, { input, batch, numbers, value: name => name === 'cos' ? cosine : sine, asGpu: x => x });
  return { fused, input, cosine, sine, params, batch, calls, numbers, run };
}
it('uses the fast path only for complete contiguous last-axis partitions, including empty halves', () => {
  for (const split of [0, 3, 6]) {
    const e = execution(); e.params.endA = e.params.startB = [split];
    expect(e.run()).toBe('fused'); expect(e.batch.rotary).toHaveBeenCalledWith(e.input, e.cosine, e.sine, split);
    expect(e.batch.index).not.toHaveBeenCalled();
    expect(e.numbers).toHaveBeenCalledWith('endB', true);
  }
});
it('retains original operations and retires all temporary tensors for overlapping slices', () => {
  const e = execution(); e.params.startB = [2]; e.params.endB = [5];
  e.run(); expect(e.batch.rotary).not.toHaveBeenCalled(); expect(e.calls).toEqual(['Mul', 'Mul', 'Add']);
  expect(e.batch.index).toHaveBeenCalledTimes(2); expect(e.batch.unary).toHaveBeenCalledWith('Neg', expect.anything());
  expect(e.batch.concat).toHaveBeenCalledWith(expect.any(Array), -1); expect(e.batch.recycle).toHaveBeenCalledTimes(6);
});
it('rejects invalid Slice controls before encoding numerical work', () => {
  const e = execution(); e.params.stepA = [0]; expect(e.run).toThrow(/nonzero steps/);
  expect(e.batch.rotary).not.toHaveBeenCalled(); expect(e.batch.binary).not.toHaveBeenCalled();
});
it('keeps all Slice controls in metadata materialization and captured-plan keys', () => {
  const { fused } = execution(), inputs = ['x', 'cos', 'sin', 'startA', 'endA', 'axis', 'stepA', 'startB', 'endB', 'stepB'];
  expect(metadataParameters(fused)).toEqual(fused.inputs.slice(3));
  expect([...metadataInputNames([fused], inputs)].sort()).toEqual(inputs.slice(3).sort());
});
