import { expect, it } from 'vitest';
import { rangePlan } from '../../src/engines/webgpu-generation-shaders.js';

it('bounds increasing, decreasing and empty Range tensors before allocation', () => {
  expect(rangePlan(-4, 5, 3, 'int32')).toEqual({ shape: [3], bounds: { min: -4, max: 2 } });
  expect(rangePlan(7, -2, -2, 'int32')).toEqual({ shape: [5], bounds: { min: -1, max: 7 } });
  expect(rangePlan(0, 1, -.5, 'float32')).toEqual({ shape: [0], bounds: null });
  expect(rangePlan(0, 1, .3, 'float32').shape).toEqual([4]);
  for (const args of [[0, 1, 0, 'int32'], [0, Infinity, 1, 'float32'], [0, 2 ** 32, 1, 'float32'],
    [0, 1, .5, 'int32'], [0, 2147483648, 1, 'int32'], [0, 1, 1, 'bool']]) {
    expect(() => rangePlan(...args)).toThrow(RangeError);
  }
});
