// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { broadcastShape, broadcastStrides, tensorSize } from './tensor-shape.js';

export function contiguousStrides(shape) {
  let stride = 1;
  return shape.map((_, i) => shape.length - i - 1).reduce((result, axis) => {
    result[axis] = stride; stride *= shape[axis]; return result;
  }, []);
}

export function axisIndex(axis, rank) {
  if (!Number.isSafeInteger(axis) || axis < -rank || axis >= rank) throw new RangeError('Tensor axis is out of range.');
  return (axis + rank) % rank;
}

export function reshapeShape(input, target, allowZero = false) {
  tensorSize(input);
  if (!Array.isArray(target) || target.length > 8 || target.some(dim => !Number.isSafeInteger(dim) || dim < -1)) throw new RangeError('Invalid reshape dimensions.');
  const shape = target.map((dim, i) => dim === 0 && !allowZero ? input[i] : dim);
  const infer = shape.indexOf(-1);
  if (shape.lastIndexOf(-1) !== infer) throw new RangeError('Reshape can infer only one dimension.');
  if (infer !== -1) {
    const known = shape.reduce((size, dim) => dim === -1 ? size : size * dim, 1);
    if (!known || !Number.isSafeInteger(known) || tensorSize(input) % known) throw new RangeError('Reshape inferred dimension is ambiguous.');
    shape[infer] = tensorSize(input) / known;
  }
  if (tensorSize(shape) !== tensorSize(input)) throw new RangeError('Reshape changes the tensor element count.');
  return shape;
}

export function squeezeShape(input, axes = null) {
  tensorSize(input);
  const normalized = axes?.map(axis => axisIndex(axis, input.length)) ?? input.flatMap((dim, i) => dim === 1 ? [i] : []);
  if (new Set(normalized).size !== normalized.length || normalized.some(axis => input[axis] !== 1)) throw new RangeError('Squeeze requires distinct unit dimensions.');
  return input.filter((_, i) => !normalized.includes(i));
}

export function unsqueezeShape(input, axes) {
  tensorSize(input);
  if (!Array.isArray(axes)) throw new RangeError('Unsqueeze requires axes.');
  const rank = input.length + axes.length;
  const normalized = axes.map(axis => axisIndex(axis, rank));
  if (new Set(normalized).size !== normalized.length) throw new RangeError('Unsqueeze axes must be distinct.');
  let at = 0;
  const shape = Array.from({ length: rank }, (_, axis) => normalized.includes(axis) ? 1 : input[at++]);
  tensorSize(shape);
  return shape;
}

export function transposePlan(input, permutation = null) {
  tensorSize(input);
  permutation ??= input.map((_, i) => input.length - i - 1);
  if (permutation.length !== input.length || new Set(permutation).size !== input.length || permutation.some(axis => !Number.isSafeInteger(axis) || axis < 0 || axis >= input.length)) throw new RangeError('Invalid transpose permutation.');
  const strides = contiguousStrides(input);
  return { shape: permutation.map(axis => input[axis]), strides: permutation.map(axis => strides[axis]), offset: 0 };
}

export function slicePlan(input, starts, ends, axes = null, steps = null) {
  tensorSize(input);
  if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length !== ends.length) throw new RangeError('Slice starts and ends must have equal lengths.');
  axes ??= starts.map((_, i) => i);
  steps ??= starts.map(() => 1);
  if (axes.length !== starts.length || steps.length !== starts.length) throw new RangeError('Slice parameter lengths do not match.');
  axes = axes.map(axis => axisIndex(axis, input.length));
  if (new Set(axes).size !== axes.length) throw new RangeError('Slice axes must be distinct.');
  const shape = [...input], strides = contiguousStrides(input);
  let offset = 0;
  for (let i = 0; i < axes.length; i += 1) {
    const axis = axes[i], dim = input[axis], step = steps[i];
    const exactBound = value => Number.isSafeInteger(value) || (typeof value === 'bigint' && value >= -(1n << 63n) && value < 1n << 63n);
    if (![starts[i], ends[i]].every(exactBound) || !Number.isSafeInteger(step) || !step) throw new RangeError('Slice requires exact integer bounds and nonzero steps.');
    const low = step < 0 ? -1 : 0, high = step < 0 ? dim - 1 : dim;
    const clamp = (value, minimum) => {
      if (typeof value !== 'bigint') return Math.max(minimum, Math.min(high, value < 0 ? value + dim : value));
      const normalized = value < 0n ? value + BigInt(dim) : value;
      return Number(normalized < BigInt(minimum) ? BigInt(minimum) : normalized > BigInt(high) ? BigInt(high) : normalized);
    };
    const start = clamp(starts[i], step < 0 ? 0 : low), end = clamp(ends[i], low);
    shape[axis] = Math.max(0, Math.ceil((end - start) / step));
    offset += start * strides[axis]; strides[axis] *= step;
  }
  return { shape, strides, offset };
}

export function batchedMatmulPlan(a, b) {
  tensorSize(a); tensorSize(b);
  if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-2)) throw new RangeError('MatMul requires matching inner matrix dimensions.');
  const batch = broadcastShape(a.slice(0, -2), b.slice(0, -2));
  const shape = [...batch, a.at(-2), b.at(-1)];
  tensorSize(shape);
  return { shape, batch, aStrides: broadcastStrides(a.slice(0, -2), batch), bStrides: broadcastStrides(b.slice(0, -2), batch) };
}
