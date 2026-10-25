import { describe, expect, it } from 'vitest';
import { batchedMatmulPlan, reshapeShape, slicePlan, squeezeShape, transposePlan, unsqueezeShape } from '../../src/engines/index-shape.js';
import { executeIndexNode, metadataTensor } from '../../src/engines/onnx-metadata.js';
import { constantIntegers, constantNumbers } from '../../src/engines/onnx-tensor.js';

describe('ONNX indexing semantics', () => {
  it('infers a reshape dimension and implements zero as a copied dimension', () => {
    expect(reshapeShape([2, 3, 4], [0, -1])).toEqual([2, 12]);
    expect(reshapeShape([0, 3], [0, 3], true)).toEqual([0, 3]);
    for (const target of [[-1, -1], [3, 9], [0, 0, 0, 0]]) expect(() => reshapeShape([2, 3, 4], target)).toThrow();
    expect(() => reshapeShape([0, 3], [0, -1])).toThrow(/ambiguous/);
  });
  it('handles negative squeeze axes and unsqueeze axes relative to output rank', () => {
    expect(squeezeShape([1, 3, 1], [-3, -1])).toEqual([3]);
    expect(squeezeShape([1, 3, 1])).toEqual([3]);
    expect(unsqueezeShape([3, 4], [0, -1])).toEqual([1, 3, 4, 1]);
    expect(() => squeezeShape([1, 3], [1])).toThrow();
    expect(() => unsqueezeShape([3], [0, -3])).toThrow(/distinct/);
  });
  it('creates transpose strides for irregular multidimensional tensors', () => {
    expect(transposePlan([2, 3, 5], [1, 2, 0])).toEqual({ shape: [3, 5, 2], strides: [5, 1, 15], offset: 0 });
    expect(() => transposePlan([2, 3], [0, 0])).toThrow();
  });
  it('clamps slice bounds while preserving reversed axes and stride', () => {
    expect(slicePlan([2, 7], [1], [6], [1], [2])).toEqual({ shape: [2, 3], strides: [7, 2], offset: 1 });
    expect(slicePlan([7], [-1], [-100], [0], [-2])).toEqual({ shape: [4], strides: [-2], offset: 6 });
    expect(slicePlan([7], [8], [2])).toEqual({ shape: [0], strides: [1], offset: 7 });
    expect(() => slicePlan([7], [0], [3], [0], [0])).toThrow();
  });
  it('keeps full-width int64 end sentinels exact until clamping to a real axis', () => {
    const maximum = (1n << 63n) - 1n, minimum = -(1n << 63n);
    expect(slicePlan([7], [0n], [maximum])).toEqual({ shape: [7], strides: [1], offset: 0 });
    expect(slicePlan([7], [maximum], [minimum], [0], [-1])).toEqual({ shape: [7], strides: [-1], offset: 6 });
    expect(() => slicePlan([7], [0n], [1n << 63n])).toThrow(/exact/);
  });
  it('broadcasts batch dimensions without repeating shared matrix weights', () => {
    expect(batchedMatmulPlan([2, 1, 3, 5], [4, 5, 7])).toEqual({ shape: [2, 4, 3, 7], batch: [2, 4], aStrides: [1, 0], bStrides: [0, 1] });
    expect(() => batchedMatmulPlan([2, 3, 5], [3, 5, 7])).toThrow(/broadcast/);
  });
  it('evaluates bounded shape metadata without inference or GPU readback', () => {
    const values = { x: { shape: [2, 3, 5] }, starts: metadataTensor([1], [1]), ends: metadataTensor([3], [1]) };
    const context = { value: name => values[name], descriptor: name => values[name], numbers: name => values[name].data };
    values.shape = executeIndexNode({ opType: 'Shape', attrs: {}, inputs: ['x'] }, context);
    expect(values.shape.data).toEqual([2, 3, 5]);
    values.slice = executeIndexNode({ opType: 'Slice', attrs: {}, inputs: ['shape', 'starts', 'ends'] }, context);
    expect(values.slice).toEqual(metadataTensor([3, 5], [2]));
    values.result = executeIndexNode({ opType: 'Concat', attrs: { axis: 0 }, inputs: ['slice', 'starts'] }, context);
    expect(values.result).toEqual(metadataTensor([3, 5, 1], [3]));
  });
  it('selects multidimensional metadata and accepts the pinned older Slice attribute schema', () => {
    const values = { x: metadataTensor([1, 2, 3, 4, 5, 6], [2, 3]), indices: metadataTensor([-1, 0], [2]) };
    const context = { value: name => values[name], descriptor: name => values[name], numbers: name => values[name].data };
    expect(executeIndexNode({ opType: 'Gather', attrs: { axis: 1 }, inputs: ['x', 'indices'] }, context))
      .toEqual(metadataTensor([3, 1, 6, 4], [2, 2]));
    expect(executeIndexNode({ opType: 'Slice', attrs: { starts: [1], ends: [3], axes: [1] }, inputs: ['x'] }, context))
      .toEqual(metadataTensor([2, 3, 5, 6], [2, 2]));
  });
});

describe('ONNX integer shape constants', () => {
  const tensor = (rawData, count) => ({ name: 'dimensions', dataType: 7, dims: [count], rawData, typedData: new Map(), externalData: new Map(), dataLocation: 0 });
  it('reads unaligned little-endian signed int64 values exactly', () => {
    const data = new Uint8Array(17), view = new DataView(data.buffer);
    view.setBigInt64(1, -3n, true); view.setBigInt64(9, 17n, true);
    expect(constantNumbers(tensor(data.subarray(1), 2))).toEqual([-3, 17]);
  });
  it('rejects values beyond exact integer range and malformed packed varints', () => {
    expect(() => constantNumbers(tensor(new Uint8Array(BigInt64Array.of(9007199254740993n).buffer), 1))).toThrow(/exact/);
    const broken = tensor(null, 1); broken.typedData.set(7, [{ wire: 2, value: Uint8Array.of(128) }]);
    expect(() => constantNumbers(broken)).toThrow(/Truncated/);
    broken.typedData.set(7, [{ wire: 2, value: Uint8Array.of(3, 5) }]);
    expect(() => constantNumbers(broken)).toThrow(/Too many/);
  });
  it('exposes exact integers separately from arithmetic metadata', () => {
    const maximum = (1n << 63n) - 1n;
    expect(constantIntegers(tensor(new Uint8Array(BigInt64Array.of(maximum).buffer), 1))).toEqual([maximum]);
  });
});
