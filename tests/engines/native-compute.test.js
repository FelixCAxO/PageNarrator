import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { NativeCompute } from '../../src/engines/native-compute.js';
import { broadcastShape, matrixShape, tensorSize } from '../../src/engines/tensor-shape.js';

let engine;
beforeAll(async () => { engine = await NativeCompute.create(readFileSync(new URL('../../public/native/engine.wasm', import.meta.url))); });

function referenceMatmul(a, b, m, n, k) {
  const out = new Float32Array(m * n);
  for (let row = 0; row < m; row += 1) for (let col = 0; col < n; col += 1) {
    let value = 0;
    for (let j = 0; j < k; j += 1) value = Math.fround(value + Math.fround(a[row * k + j] * b[j * n + col]));
    out[row * n + col] = value;
  }
  return out;
}

describe('first-party C++/WebAssembly math', () => {
  it.each([[1, 1, 1], [3, 7, 5], [17, 19, 33], [32, 64, 16], [3, 5, 0], [0, 4, 3]])('multiplies %ix%ix%i matrices, including SIMD tails', (m, n, k) => {
    const a = Float32Array.from({ length: m * k }, (_, i) => Math.sin(i * 0.37));
    const b = Float32Array.from({ length: k * n }, (_, i) => Math.cos(i * 0.19));
    const result = engine.matmul(a, [m, k], b, [k, n]);
    expect(result.shape).toEqual([m, n]);
    expect(result.data).toEqual(referenceMatmul(a, b, m, n, k));
  });

  it('survives linear-memory growth without retaining detached output views', () => {
    const first = engine.unary('Relu', Float32Array.of(-3, 7));
    const large = new Float32Array(200_000).fill(2);
    const result = engine.binary('Mul', large, large);
    expect(result[199_999]).toBe(4);
    expect(first).toEqual(Float32Array.of(0, 7));
  });

  it.each(['Exp', 'Sigmoid', 'Tanh'])('keeps %s within float32 numerical tolerance', operation => {
    const values = Float32Array.from({ length: 2001 }, (_, i) => (i - 1000) / 16);
    const result = engine.unary(operation, values);
    for (let i = 0; i < values.length; i += 1) {
      const x = values[i];
      const expected = operation === 'Exp' ? Math.exp(x) : operation === 'Tanh' ? Math.tanh(x) : 1 / (1 + Math.exp(-x));
      expect(Math.abs(result[i] - expected)).toBeLessThanOrEqual(Math.max(3e-7, Math.abs(expected) * 2e-6));
    }
  });

  it('computes the error function against tabulated independent values', () => {
    const values = Float32Array.of(-2, -1, 0, 0.5, 1, 2);
    const expected = [-0.9953222650189527, -0.8427007929497149, 0, 0.5204998778130465, 0.8427007929497149, 0.9953222650189527];
    const result = engine.unary('Erf', values);
    expected.forEach((value, i) => expect(Math.abs(result[i] - value)).toBeLessThan(3e-7));
  });

  it('rejects malformed tensor data and unsupported operations', () => {
    expect(() => engine.matmul(Float32Array.of(1), [2, 2], Float32Array.of(1), [2, 2])).toThrow('shape');
    expect(() => engine.unary('MadeUp', Float32Array.of(1))).toThrow('Unsupported');
    expect(() => engine.binary('Add', Float32Array.of(1), new Float32Array())).toThrow('equal lengths');
  });
});

describe('tensor dimensions', () => {
  it('implements multidirectional broadcasting, including empty dimensions', () => {
    expect(broadcastShape([2, 1, 4], [3, 4])).toEqual([2, 3, 4]);
    expect(broadcastShape([0, 3], [1, 3])).toEqual([0, 3]);
    expect(broadcastShape([], [2, 3])).toEqual([2, 3]);
    expect(() => broadcastShape([2, 3], [2])).toThrow('broadcast');
    expect(() => matrixShape([2, 3], [2, 3])).toThrow('compatible');
  });

  it.each([[-1], [0.5], [Infinity], Array(9).fill(1), [0xffffffff, 0xffffffff]])('rejects unsafe dimensions %j', shape => {
    expect(() => tensorSize(shape)).toThrow(RangeError);
  });
});
