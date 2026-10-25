import { describe, expect, it } from 'vitest';
import { concatPlan, convolutionPlan, poolingPlan, reductionPlan, resizePlan } from '../../src/engines/cnn-shape.js';
import { constantNumbers, floatTensorBytes } from '../../src/engines/onnx-tensor.js';

describe('CNN spatial semantics', () => {
  it('splits odd automatic padding on the specified side', () => {
    const input = [1, 3, 8, 9], weight = [8, 3, 2, 2];
    expect(convolutionPlan(input, weight, { autoPad: 'SAME_UPPER' }).pads).toEqual([0, 0, 1, 1]);
    expect(convolutionPlan(input, weight, { autoPad: 'SAME_LOWER' }).pads).toEqual([1, 1, 0, 0]);
    expect(convolutionPlan(input, weight, { autoPad: 'SAME_UPPER', strides: [2, 2] }).shape).toEqual([1, 8, 4, 5]);
  });
  it('checks grouped and transposed weight layouts', () => {
    expect(convolutionPlan([2, 4, 5, 7], [4, 1, 3, 3], { group: 4, pads: [1, 1, 1, 1] }).shape).toEqual([2, 4, 5, 7]);
    expect(convolutionPlan([1, 4, 5, 7], [4, 3, 2, 2], { group: 2, transpose: true, strides: [2, 2] }).shape).toEqual([1, 6, 10, 14]);
    expect(() => convolutionPlan([1, 3, 5, 7], [4, 2, 3, 3], { group: 2 })).toThrow(/channels/);
    expect(() => convolutionPlan([1, 4, 5, 7], [4, 3, 2, 2], { transpose: true, outputPadding: [1, 0] })).toThrow(/padding/);
  });
  it('accounts for dilation, output padding, and asymmetric pads', () => {
    expect(convolutionPlan([1, 2, 7, 9], [3, 2, 3, 2], { dilations: [2, 3], pads: [1, 2, 3, 0], strides: [2, 1] }).shape).toEqual([1, 3, 4, 8]);
    expect(convolutionPlan([1, 2, 4, 5], [2, 3, 3, 3], { transpose: true, strides: [2, 2], pads: [1, 1, 1, 1], outputPadding: [1, 0] }).shape).toEqual([1, 3, 8, 9]);
  });
  it('excludes ceiling windows starting entirely in trailing padding', () => {
    expect(poolingPlan([1, 1, 3, 3], { kernel: [2, 2], strides: [2, 2], pads: [0, 0, 1, 1], ceilMode: true }).shape).toEqual([1, 1, 2, 2]);
    expect(poolingPlan([1, 1, 4, 4], { kernel: [2, 2], strides: [2, 2], pads: [0, 0, 1, 1], ceilMode: true }).shape).toEqual([1, 1, 2, 2]);
  });
  it('normalizes reduction axes and retains scalar output shape', () => {
    expect(reductionPlan([2, 3, 4], [-1, 0], false)).toEqual({ shape: [3], mask: 5, reductionSize: 8 });
    expect(reductionPlan([2, 3], null, false).shape).toEqual([]);
    expect(() => reductionPlan([2, 3], [1, -1])).toThrow(/distinct/);
  });
  it('preserves supplied noninteger scales for resize coordinates', () => {
    const plan = resizePlan([1, 2, 5, 7], { scales: [1, 1, 1.7, 1.3], coordinateMode: 'asymmetric' });
    expect(plan.shape).toEqual([1, 2, 8, 9]); expect(plan.scales).toEqual([1.7, 1.3]);
    expect(() => resizePlan([1, 2, 5, 7], { sizes: [2, 2, 5, 7] })).toThrow(/unchanged/);
    expect(() => resizePlan([1, 2, 5, 7], { scales: [1, 1, 2, 2], mode: 'cubic' })).toThrow(/mode/);
  });
  it('concatenates along a negative axis with exact nonaxis dimensions', () => {
    expect(concatPlan([[2, 3, 4], [2, 7, 4]], -2)).toEqual({ shape: [2, 10, 4], axis: 1, innerSize: 4 });
    expect(() => concatPlan([[2, 3, 4], [1, 7, 4]], 1)).toThrow(/match/);
  });
});

describe('ONNX float tensor payloads', () => {
  const tensor = values => ({ name: 'constant', dataType: 1, dims: [values.length], rawData: new Uint8Array(Float32Array.from(values).buffer), typedData: new Map(), externalData: new Map(), dataLocation: 0 });
  it('keeps unaligned payload bytes without making a second weight copy', () => {
    const original = tensor([2, -4, 0.25]);
    const bytes = new Uint8Array(13); bytes.set(original.rawData, 1); original.rawData = bytes.subarray(1);
    expect(floatTensorBytes(original)).toBe(original.rawData);
    expect(constantNumbers(original)).toEqual([2, -4, 0.25]);
  });
  it('rejects missing, external, ambiguous, and oversized metadata payloads', () => {
    const missing = tensor([1]); missing.rawData = null; expect(() => floatTensorBytes(missing)).toThrow(/incomplete/);
    const external = tensor([1]); external.externalData.set('location', 'weights.bin'); expect(() => floatTensorBytes(external)).toThrow(/External/);
    const ambiguous = tensor([1]); ambiguous.typedData.set(4, []); expect(() => floatTensorBytes(ambiguous)).toThrow(/invalid/);
    expect(() => constantNumbers(tensor([1, 2]), 1)).toThrow(/limit/);
  });
});
