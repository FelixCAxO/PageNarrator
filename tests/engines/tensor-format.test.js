import { expect, it } from 'vitest';
import { floatToHalf, halfToFloat } from '../../src/engines/tensor-format.js';
import { bindExternalData } from '../../src/engines/onnx-external-data.js';
import { constantNumbers, tensorBytes } from '../../src/engines/onnx-tensor.js';
import { selectExecutionPlan } from '../../src/engines/onnx-execution-plan.js';
import { modelFeed } from '../../src/engines/bounded-integers.js';
import { integerMultiplyRange } from '../../src/engines/bounded-integers.js';

it('round trips every finite binary16 value and preserves infinities and signed zero', () => {
  for (let bits = 0; bits < 65536; bits += 1) {
    const value = halfToFloat(bits), back = floatToHalf(value);
    if (Number.isNaN(value)) expect(back & 0x7fff).toBe(0x7e00);
    else expect(back).toBe(bits);
  }
  expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00);
  expect(floatToHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  expect(floatToHalf(2 ** -25)).toBe(0);
  expect(floatToHalf(65520)).toBe(0x7c00);
});

const tensor = (extra = {}) => ({ name: 'weight', dataType: 10, dims: [2], rawData: null, typedData: new Map(),
  externalData: new Map([['location', 'weights.bin'], ['offset', '2'], ['length', '4']]), dataLocation: 1, ...extra });
const model = item => ({ graph: { initializers: [item], nodes: [] } });

it('binds exact explicit external ranges without copying or mutating model metadata', () => {
  const source = Uint8Array.of(99, 99, 0, 0x3c, 0, 0xc0, 88), item = tensor();
  const bound = bindExternalData(model(item), [{ path: 'weights.bin', data: source }]).graph.initializers[0];
  expect(tensorBytes(bound)).toEqual(source.subarray(2, 6));
  expect(bound.rawData.buffer).toBe(source.buffer);
  expect(constantNumbers(bound)).toEqual([1, -2]);
  expect(item.rawData).toBeNull(); expect(item.dataLocation).toBe(1);
});

it('rejects missing, conflicting, malformed, duplicate or out-of-bounds external data', () => {
  const run = (item, entries = [{ path: 'weights.bin', data: new Uint8Array(6) }]) => bindExternalData(model(item), entries);
  expect(() => run(tensor(), [])).toThrow(/missing/);
  for (const path of ['../weights.bin', '/weights.bin', 'https://bad/weights', 'a\\b', 'a//b']) {
    expect(() => run(tensor({ externalData: new Map([['location', path]]) }))).toThrow(/path/);
  }
  for (const [offset, length] of [['3', '4'], ['-1', '4'], ['2.0', '4'], ['2', '3'], ['9007199254740992', '4']]) {
    expect(() => run(tensor({ externalData: new Map([['location', 'weights.bin'], ['offset', offset], ['length', length]]) }))).toThrow();
  }
  expect(() => run(tensor({ rawData: new Uint8Array(4) }))).toThrow(/conflicting/);
  expect(() => run(tensor(), [{ path: 'weights.bin', data: new Uint8Array(6) }, { path: 'weights.bin', data: new Uint8Array(6) }])).toThrow(/Duplicate/);
});

it('selects dependencies of requested outputs without running unrelated graph branches', () => {
  const node = (inputs, outputs) => ({ inputs, outputs });
  const shared = node(['x'], ['middle']), split = node(['middle'], ['a', 'b']), unused = node(['b'], ['cache']);
  const plan = selectExecutionPlan([shared, split, unused], ['a', 'cache'], ['a']);
  expect(plan.nodes).toEqual([shared, split]);
  expect([...plan.consumers]).toEqual([['x', 1], ['middle', 1], ['a', 1]]);
  for (const requested of [[], ['a', 'a'], ['missing']]) expect(() => selectExecutionPlan([], ['a'], requested)).toThrow(/outputs/);
});

it('validates bool and half feed representations without widening fp16 storage', () => {
  const half = Uint16Array.of(0x3c00);
  expect(modelFeed({ name: 'h', dataType: 10 }, { shape: [1], data: half }).data).toBe(half);
  expect(modelFeed({ name: 'b', dataType: 9 }, { shape: [2], data: Uint8Array.of(0, 1) }).data).toEqual(Uint32Array.of(0, 1));
  expect(() => modelFeed({ name: 'b', dataType: 9 }, { shape: [1], data: Uint8Array.of(2) })).toThrow(/Boolean/);
  expect(integerMultiplyRange({ min: -7, max: 3 }, { min: -2, max: 5 })).toEqual({ min: -35, max: 15 });
  expect(() => integerMultiplyRange({ min: 0, max: 2147483647 }, { min: 0, max: 2 })).toThrow(/overflow/);
});
