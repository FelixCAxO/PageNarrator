import { describe, expect, it } from 'vitest';
import { cumulativeSumPlan, scatterNdPlan, referenceCumulativeSum, referenceScatterNd, referenceKokoroUnary, createKokoroDurationKernels } from '../../src/engines/kokoro-kernels-duration.js';

describe('Kokoro duration and reconstruction helpers', () => {
  it('plans inclusive scans over the actual duration and interleaved oscillator layouts', () => {
    expect(cumulativeSumPlan([511], 0)).toMatchObject({ blocks: 2, lanes: 1, inner: 1, outer: 1 });
    expect(cumulativeSumPlan([1, 24000, 9], 1)).toMatchObject({ blocks: 94, lanes: 9, inner: 9, outer: 1 });
    expect(cumulativeSumPlan([2, 0, 9], -2)).toMatchObject({ blocks: 0, lanes: 18 });
    expect(() => cumulativeSumPlan([2, 3], 2)).toThrow();
    expect(() => cumulativeSumPlan([2, 3], 1, { exclusive: 1 })).toThrow();
  });
  it('scans independent inner/outer lanes and exact integer durations', () => {
    expect(referenceCumulativeSum(Int32Array.of(2, 3, 4), [3], 0)).toEqual(Int32Array.of(2, 5, 9));
    expect(referenceCumulativeSum(Float32Array.of(1, 10, 2, 20, 3, 30), [1, 3, 2], 1)).toEqual(Float32Array.of(1, 10, 3, 30, 6, 60));
    expect(referenceCumulativeSum(Float32Array.of(1, 2, 3, 4), [2, 2], 0)).toEqual(Float32Array.of(1, 2, 4, 6));
    expect(() => referenceCumulativeSum(Float32Array.of(1), [2], 0)).toThrow();
  });
  it('normalizes negative scatter indices and keeps untouched signal samples', () => {
    const input = Float32Array.of(0, 1, 2, 3, 4, 5);
    const output = referenceScatterNd(input, [2, 3], [0, 1, -1, -1], [2, 2], Float32Array.of(10, 50), [2]);
    expect(output).toEqual(Float32Array.of(0, 10, 2, 3, 4, 50)); expect(input[1]).toBe(1);
    expect(scatterNdPlan([2, 3, 4], [1], [1, 1], [1, 3, 4])).toMatchObject({ offsets: [12], blockSize: 12 });
  });
  it('rejects out of range, duplicate and oversized scatter indices before GPU work', () => {
    expect(() => scatterNdPlan([2, 3], [2, 0], [1, 2], [1])).toThrow('range');
    expect(() => scatterNdPlan([2, 3], [0, 1, -2, -2], [2, 2], [2])).toThrow('duplicate');
    expect(() => scatterNdPlan([2, 3], [0, .5], [1, 2], [1])).toThrow('range');
    expect(() => scatterNdPlan([2, 3], new Array(4097).fill(0), [4097, 1], [4097, 3])).toThrow('4096');
  });
  it('rounds ties to even including negative zero and preserves supported unary semantics', () => {
    expect(referenceKokoroUnary(Float32Array.of(-2.5, -1.5, -.5, .5, 1.5, 2.5, 3.5), 'Round')).toEqual(Float32Array.of(-2, -2, -0, 0, 2, 2, 4));
    expect(referenceKokoroUnary(Float32Array.of(-1.5, .5), 'Floor')).toEqual(Float32Array.of(-2, 0));
    expect(referenceKokoroUnary(Float32Array.of(-2, 2), 'LeakyRelu', { alpha: .5 })).toEqual(Float32Array.of(-1, 2));
    expect(referenceKokoroUnary(Float32Array.of(-2, 2), 'Clip', { min: -1, max: 1 })).toEqual(Float32Array.of(-1, 1));
    expect(referenceKokoroUnary(Float32Array.of(1), 'Atan')[0]).toBeCloseTo(Math.PI / 4, 6);
    expect(() => referenceKokoroUnary(Float32Array.of(1), 'unknown')).toThrow();
  });
});

it('encodes hierarchical cross-block carries and refuses unproven integer overflow', async () => {
  const calls = [], recycled = [];
  const engine = { pipeline: async (_, label) => label, device: { limits: { maxComputeWorkgroupsPerDimension: 65535 } } };
  const kernels = await createKokoroDurationKernels(engine);
  const tensor = (shape, dataType = 'float32', bounds = null) => ({ shape, dataType, bounds, length: shape.reduce((a, b) => a * b, 1) });
  const batch = { output: tensor, checkOwnership: () => {}, dispatchTensors: (...args) => calls.push(args),
    grid: groups => [Math.min(groups, 65535), Math.ceil(groups / 65535)], recycle: value => recycled.push(value) };
  const result = kernels.cumsum(batch, tensor([1025]), 0);
  expect(result.shape).toEqual([1025]); expect(calls).toHaveLength(3);
  expect(calls[0][2][3]).toBe(5); expect(calls[1][2][0]).toBe(5); expect(calls[2][0]).toContain('offsets');
  expect(recycled).toHaveLength(3); expect(recycled).not.toContain(result);
  expect(() => kernels.cumsum(batch, tensor([3], 'int32'), 0)).toThrow('proven');
  expect(() => kernels.cumsum(batch, tensor([3], 'int32', { min: 0, max: 2147483647 }), 0)).toThrow('overflow');
  const integer = kernels.cumsum(batch, tensor([3], 'int32', { min: 1, max: 100 }), 0);
  expect(integer.bounds).toEqual({ min: 0, max: 300 });
});
