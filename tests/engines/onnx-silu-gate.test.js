import { expect, it } from 'vitest';
import { fuseHalfSiluGates } from '../../src/engines/onnx-optimize.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';

function fixture(reverseActivation = false, reverseGate = false) {
  const node = (opType, inputs, output) => ({ opType, inputs, outputs: [output], attrs: {} });
  return [node('Sigmoid', ['gate'], 'sigmoid'), node('Mul', reverseGate ? ['sigmoid', 'gate'] : ['gate', 'sigmoid'], 'activation'),
    node('Mul', reverseActivation ? ['up', 'activation'] : ['activation', 'up'], 'out')];
}
const types = new Map(['gate', 'up', 'sigmoid', 'activation', 'out'].map(name => [name, 10]));

it.each([[false, false], [false, true], [true, false], [true, true]])('fuses half SiLU gates with operand orders %s/%s', (a, b) => {
  const nodes = fixture(a, b), result = fuseHalfSiluGates(nodes, types);
  expect(result[2]).toMatchObject({ opType: 'FusedHalfSiluGate', inputs: ['gate', 'up'], outputs: ['out'] });
  expect(selectExecutionPlan(result, ['out']).nodes).toHaveLength(1);
  expect(nodes[2].opType).toBe('Mul');
});

it('retains intermediate computations when they are requested outputs', () => {
  const nodes = fuseHalfSiluGates(fixture(), types);
  expect(selectExecutionPlan(nodes, ['sigmoid', 'activation', 'out']).nodes.map(node => node.opType)).toEqual(['Sigmoid', 'Mul', 'FusedHalfSiluGate']);
});

it('does not fuse different precisions, attributes or activation inputs', () => {
  for (const name of types.keys()) {
    const mixed = new Map(types); mixed.set(name, 1);
    expect(fuseHalfSiluGates(fixture(), mixed)[2].opType).toBe('Mul');
  }
  const attrs = fixture(); attrs[0].attrs = { unsupported: 1 };
  expect(fuseHalfSiluGates(attrs, types)[2].opType).toBe('Mul');
  const other = fixture(); other[0].inputs = ['other'];
  expect(fuseHalfSiluGates(other, types)[2].opType).toBe('Mul');
});
