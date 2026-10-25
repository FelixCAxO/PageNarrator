import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { compilePdfFunction } from '../../src/pdf/pdf-functions.js';

const oracle = JSON.parse(await readFile(new URL('../fixtures/pdf-functions-independent.json', import.meta.url), 'utf8'));
const descriptor = value => ({ ...value, samples: new Uint8Array(Buffer.from(value.samplesBase64, 'base64')) });
const bits = value => { const buffer = new ArrayBuffer(8); new DataView(buffer).setFloat64(0, value, true); return Buffer.from(buffer).toString('hex'); };

describe('sampled PDF function independent numerical controls', () => {
  it('matches every independently generated binary64 result, including multidimensional fallback and clamped boundaries', () => {
    expect(oracle.caseCount).toBe(121); expect(oracle.vectorCount).toBe(3025);
    for (const item of oracle.cases) {
      const fn = compilePdfFunction(descriptor(item.descriptor));
      for (const vector of item.vectors) expect(fn(vector.input).map(bits), `case${item.id} input${vector.input}`).toEqual(vector.binary64);
    }
  });
  it('preserves caller-owned buffers and independent returned arrays across subsequent evaluations', () => {
    const item = oracle.cases.find(item => item.descriptor.size[0] === 17 && item.descriptor.outputs === 3), fn = compilePdfFunction(descriptor(item.descriptor));
    const first = fn(item.vectors[5].input), saved = first.slice(), second = fn(item.vectors[7].input);
    expect(second).not.toBe(first); expect(first).toEqual(saved);
    const output = new Float64Array(5).fill(1234);
    expect(fn(new Float64Array(item.vectors[7].input), output)).toBe(output);
    expect([...output.subarray(0, 3)].map(bits)).toEqual(item.vectors[7].binary64);
    expect([...output.subarray(3)]).toEqual([1234, 1234]);
  });
  it('preserves rounding after each write to a caller-owned Float32 output, including cancellation around zero', () => {
    const fn = compilePdfFunction({ type: 0, domain: [0, 1], range: [-1, 1], inputs: 1, outputs: 1, size: [2], bits: 32,
      encode: [0, 1], decode: [-1, 1], samples: Uint8Array.of(127, 255, 255, 255, 127, 255, 255, 255) });
    const target = new Float32Array(1);
    expect(fn([.5], target)).toBe(target);
    expect(target[0]).toBe(Math.fround(-1 + 2147483648 / 4294967295 * 2));
    expect(fn([.5])[0]).toBe(-1 + 2147483647 / 4294967295 * 2);
  });
  it('rejects nonnumeric, nonfinite, sparse and dimensionally wrong inputs without partially writing output', () => {
    const fn = compilePdfFunction(descriptor(oracle.cases[0].descriptor));
    for (const input of [[NaN], [Infinity], ['0'], [], [0, 1], new Array(1), null, { 0: 0, length: 1 }]) {
      const output = [1234]; expect(() => fn(input, output)).toThrow(/inputs/); expect(output).toEqual([1234]);
    }
  });
});
