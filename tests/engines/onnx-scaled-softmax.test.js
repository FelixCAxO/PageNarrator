import { expect, it } from 'vitest';
import { fuseHalfScaledMaskedSoftmax } from '../../src/engines/onnx-optimize.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';

const types = new Map(['x', 'scale', 'mask', 'scaled', 'masked', 'out'].map(name => [name, 10]));
const constants = new Map([['scale', { dataType: 10, dims: [] }]]);
const fixture = () => [
  { opType: 'Mul', inputs: ['x', 'scale'], outputs: ['scaled'], attrs: {} },
  { opType: 'Add', inputs: ['scaled', 'mask'], outputs: ['masked'], attrs: {} },
  { opType: 'Softmax', inputs: ['masked'], outputs: ['out'], attrs: { axis: -1 } },
];
it('fuses the half chain and preserves independently requested intermediate outputs', () => {
  const original = fixture(), nodes = fuseHalfScaledMaskedSoftmax(original, constants, types);
  expect(original[2].opType).toBe('Softmax');
  expect(nodes[2]).toMatchObject({ opType: 'FusedHalfScaledMaskedSoftmax', inputs: ['x', 'scale', 'mask'], attrs: {} });
  expect(selectExecutionPlan(nodes, ['out']).nodes).toHaveLength(1);
  expect(selectExecutionPlan(nodes, ['scaled', 'masked', 'out']).nodes.map(n => n.opType)).toEqual(['Mul', 'Add', 'FusedHalfScaledMaskedSoftmax']);
});
it('requires half precision throughout the chain', () => {
  for (const name of types.keys()) {
    const mixed = new Map(types); mixed.set(name, 1);
    expect(fuseHalfScaledMaskedSoftmax(fixture(), constants, mixed)[2].opType).toBe('Softmax');
  }
});
it('retains unsupported axes, attributes, domains, operand order and non-scalar scales', () => {
  const cases = [];
  for (const index of [0, 1, 2]) {
    const attributes = fixture(); attributes[index].attrs.extra = 1; cases.push(attributes);
    const domain = fixture(); domain[index].domain = 'other'; cases.push(domain);
  }
  const axis = fixture(); axis[2].attrs.axis = 1; cases.push(axis);
  const order = fixture(); order[1].inputs.reverse(); cases.push(order);
  for (const nodes of cases) expect(fuseHalfScaledMaskedSoftmax(nodes, constants, types)[2].opType).toBe('Softmax');
  for (const value of [undefined, { dataType: 1, dims: [] }, { dataType: 10, dims: [1] }]) {
    expect(fuseHalfScaledMaskedSoftmax(fixture(), new Map([['scale', value]]), types)[2].opType).toBe('Softmax');
  }
});
