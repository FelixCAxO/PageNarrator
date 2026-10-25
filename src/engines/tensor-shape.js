// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export function tensorSize(shape) {
  if (!Array.isArray(shape) || shape.length > 8) throw new RangeError('Tensor rank must be between zero and eight.');
  let size = 1;
  for (const dim of shape) {
    if (!Number.isSafeInteger(dim) || dim < 0 || dim > 0xffffffff) throw new RangeError('Tensor dimensions must be unsigned 32-bit integers.');
    size *= dim;
    if (!Number.isSafeInteger(size)) throw new RangeError('Tensor element count exceeds the exact integer range.');
  }
  return size;
}

export function broadcastShape(a, b) {
  tensorSize(a); tensorSize(b);
  const shape = [];
  for (let i = 0, rank = Math.max(a.length, b.length); i < rank; i += 1) {
    const x = a[a.length - rank + i] ?? 1;
    const y = b[b.length - rank + i] ?? 1;
    if (x !== y && x !== 1 && y !== 1) throw new RangeError(`Cannot broadcast [${a}] with [${b}].`);
    shape.push(x === 1 ? y : x);
  }
  tensorSize(shape);
  return shape;
}

export function broadcastStrides(input, output) {
  const offset = output.length - input.length;
  const strides = new Array(output.length).fill(0);
  let stride = 1;
  for (let axis = input.length - 1; axis >= 0; axis -= 1) {
    strides[axis + offset] = input[axis] === 1 ? 0 : stride;
    stride *= input[axis];
  }
  return strides;
}

export function matrixShape(a, b) {
  tensorSize(a); tensorSize(b);
  if (a.length !== 2 || b.length !== 2 || a[1] !== b[0]) throw new RangeError('MatMul requires compatible rank-two matrices.');
  return [a[0], b[1]];
}
