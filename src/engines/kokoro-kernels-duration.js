// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { axisIndex, contiguousStrides } from './index-shape.js';
import { tensorSize } from './tensor-shape.js';

export function cumulativeSumPlan(shape, axis, { exclusive = 0, reverse = 0 } = {}) {
  tensorSize(shape);
  if (exclusive !== 0 || reverse !== 0) throw new Error('This cumulative sum supports inclusive forward scans.');
  axis = axisIndex(axis, shape.length);
  const length = shape[axis], inner = tensorSize(shape.slice(axis + 1)), outer = tensorSize(shape.slice(0, axis));
  return { shape: [...shape], length, inner, outer, lanes: inner * outer, blocks: Math.ceil(length / 256) };
}

export function scatterNdPlan(shape, indices, indexShape, updates) {
  const size = tensorSize(shape);
  if (!Array.isArray(indices) || indices.length > 4096 || tensorSize(indexShape) !== indices.length || !indexShape.length) throw new RangeError('ScatterND requires at most 4096 bounded CPU indices.');
  const depth = indexShape.at(-1), count = tensorSize(indexShape.slice(0, -1));
  if (depth < 1 || depth > shape.length || updates.join(',') !== [...indexShape.slice(0, -1), ...shape.slice(depth)].join(',')) throw new RangeError('ScatterND index/update shapes differ.');
  const strides = contiguousStrides(shape), blockSize = tensorSize(shape.slice(depth)), offsets = [], seen = new Set();
  for (let row = 0; row < count; row++) {
    let offset = 0;
    for (let axis = 0; axis < depth; axis++) {
      let value = indices[row * depth + axis];
      if (!Number.isSafeInteger(value) || value < -shape[axis] || value >= shape[axis]) throw new RangeError('ScatterND index is out of range.');
      if (value < 0) value += shape[axis];
      offset += value * strides[axis];
    }
    if (seen.has(offset)) throw new Error('ScatterND duplicate update regions are unsupported.');
    seen.add(offset); offsets.push(offset);
  }
  return { shape: [...shape], size, offsets, count, blockSize };
}

export function referenceCumulativeSum(input, shape, axis, options = {}) {
  const plan = cumulativeSumPlan(shape, axis, options);
  if (input.length !== tensorSize(shape)) throw new RangeError('Cumulative sum data length differs.');
  const output = input instanceof Int32Array ? new Int32Array(input.length) : new Float32Array(input.length);
  for (let outer = 0; outer < plan.outer; outer++) for (let inner = 0; inner < plan.inner; inner++) {
    let sum = 0;
    for (let position = 0; position < plan.length; position++) {
      const index = (outer * plan.length + position) * plan.inner + inner;
      sum += input[index]; output[index] = sum;
    }
  }
  return output;
}

export function referenceScatterNd(data, shape, indices, indexShape, updates, updateShape) {
  const plan = scatterNdPlan(shape, indices, indexShape, updateShape);
  if (data.length !== plan.size || updates.length !== tensorSize(updateShape)) throw new RangeError('ScatterND data length differs.');
  const result = new Float32Array(data);
  plan.offsets.forEach((offset, row) => result.set(updates.subarray(row * plan.blockSize, (row + 1) * plan.blockSize), offset));
  return result;
}

export const KOKORO_UNARY_OPERATIONS = Object.freeze({ Round: 0, Floor: 1, Atan: 2, LeakyRelu: 3, Clip: 4 });
export function referenceKokoroUnary(input, operation, { alpha = .01, min = -Infinity, max = Infinity } = {}) {
  if (!Object.hasOwn(KOKORO_UNARY_OPERATIONS, operation) || !Number.isFinite(alpha) || Number.isNaN(min) || Number.isNaN(max) || min > max) throw new Error('Invalid Kokoro unary operation.');
  return Float32Array.from(input, value => {
    if (operation === 'Floor') return Math.floor(value);
    if (operation === 'Atan') return Math.atan(value);
    if (operation === 'LeakyRelu') return value < 0 ? value * alpha : value;
    if (operation === 'Clip') return Math.min(max, Math.max(min, value));
    const low = Math.floor(value), fraction = value - low;
    const result = fraction > .5 || (fraction === .5 && Math.abs(low % 2) === 1) ? low + 1 : low;
    return result === 0 && value < 0 ? -0 : result;
  });
}

export function cumulativeSumShader(integer = false) {
  const type = integer ? 'i32' : 'f32';
  return `
@group(0) @binding(0) var<storage, read> src: array<${type}>;
@group(0) @binding(1) var<storage, read_write> dst: array<${type}>;
@group(0) @binding(2) var<storage, read_write> sums: array<${type}>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
var<workgroup> partial: array<${type},256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) unit: u32) {
  let lane = group.y + group.z * cfg[5u];
  if (lane >= cfg[4u]) { return; }
  let position = group.x * 256u + unit;
  let index = ((lane / cfg[1u]) * cfg[0u] + position) * cfg[1u] + lane % cfg[1u];
  var value = ${type}(0); if (position < cfg[0u]) { value = src[index]; }
  partial[unit] = value; workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var next = partial[unit]; if (unit >= step) { next += partial[unit - step]; }
    workgroupBarrier(); partial[unit] = next; workgroupBarrier();
  }
  if (position < cfg[0u]) { dst[index] = partial[unit]; }
  if (unit == 255u) { sums[lane * cfg[3u] + group.x] = partial[255u]; }
}
`;
}

export function cumulativeOffsetsShader(integer = false) {
  const type = integer ? 'i32' : 'f32';
  return `
@group(0) @binding(0) var<storage, read_write> dst: array<${type}>;
@group(0) @binding(1) var<storage, read> sums: array<${type}>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[4u] * 64u;
  if (index >= cfg[0u]) { return; }
  let along = (index / cfg[2u]) % cfg[1u]; let block = along / 256u;
  let lane = index / (cfg[1u] * cfg[2u]) * cfg[2u] + index % cfg[2u];
  if (block > 0u) { dst[index] += sums[lane * cfg[3u] + block - 1u]; }
}
`;
}

export const KOKORO_SCATTER_SHADER = `
@group(0) @binding(0) var<storage, read> updates: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[2u] * 64u;
  if (index >= cfg[0u]) { return; }
  let row = index / cfg[1u]; let column = index % cfg[1u];
  dst[cfg[4u + row] + column] = updates[index];
}
`;

export const KOKORO_UNARY_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[5u] * 64u;
  if (index >= cfg[0u]) { return; }
  let value = src[index]; var result = value;
  switch (cfg[1u]) {
    case 0u: {
      if (abs(value) < 16777216.0) {
        let low = floor(value); let fraction = value - low;
        result = select(low, low + 1.0, fraction > 0.5 || (fraction == 0.5 && abs(low % 2.0) == 1.0));
        if (result == 0.0 && value < 0.0) { result = bitcast<f32>(0x80000000u); }
      }
    }
    case 1u: { result = floor(value); }
    case 2u: { result = atan(value); }
    case 3u: { result = select(value, value * bitcast<f32>(cfg[2u]), value < 0.0); }
    case 4u: { result = clamp(value, bitcast<f32>(cfg[3u]), bitcast<f32>(cfg[4u])); }
    default: {}
  }
  var bits = bitcast<u32>(result);
  // Preserve rounding's negative zero even when floating-point expressions canonicalize it.
  if (cfg[1u] == 0u && result == 0.0 && (bitcast<u32>(value) & 0x80000000u) != 0u) { bits = 0x80000000u; }
  dst[index] = bits;
}
`;

const floatBits = value => new Uint32Array(Float32Array.of(value).buffer)[0];
export async function createKokoroDurationKernels(engine) {
  const [scanFloat, scanInteger, offsetFloat, offsetInteger, scatter, unary] = await Promise.all([
    engine.pipeline(cumulativeSumShader(), 'PageNarrator Kokoro float scan'),
    engine.pipeline(cumulativeSumShader(true), 'PageNarrator Kokoro integer scan'),
    engine.pipeline(cumulativeOffsetsShader(), 'PageNarrator Kokoro float scan offsets'),
    engine.pipeline(cumulativeOffsetsShader(true), 'PageNarrator Kokoro integer scan offsets'),
    engine.pipeline(KOKORO_SCATTER_SHADER, 'PageNarrator Kokoro bounded scatter'),
    engine.pipeline(KOKORO_UNARY_SHADER, 'PageNarrator Kokoro unary'),
  ]);
  const kernels = {
    cumsum(batch, input, axis, options = {}) {
      batch.checkOwnership(input);
      if (!['float32', 'int32'].includes(input.dataType)) throw new Error('Cumulative sum requires float32 or bounded int32.');
      const plan = cumulativeSumPlan(input.shape, axis, options), integer = input.dataType === 'int32';
      const range = count => {
        if (!integer) return null;
        if (!input.bounds) throw new Error('Integer cumulative sum requires proven input bounds.');
        const min = Math.min(0, input.bounds.min * count), max = Math.max(0, input.bounds.max * count);
        if (min < -2147483648 || max > 2147483647) throw new RangeError('Integer cumulative sum may overflow int32.');
        return { min, max };
      };
      const output = batch.output(plan.shape, input.dataType, range(plan.length));
      if (!plan.length || !plan.lanes) return output;
      const sums = batch.output([plan.lanes, plan.blocks], input.dataType, range(Math.min(256, plan.length)));
      const limit = engine.device.limits.maxComputeWorkgroupsPerDimension;
      const y = Math.min(plan.lanes, limit), z = Math.ceil(plan.lanes / y);
      batch.dispatchTensors(integer ? scanInteger : scanFloat, [input, output, sums],
        Uint32Array.of(plan.length, plan.inner, plan.outer, plan.blocks, plan.lanes, y), plan.blocks, y, z);
      if (plan.blocks > 1) {
        const offsets = kernels.cumsum(batch, sums, 1);
        const [x, groupsY] = batch.grid(Math.ceil(output.length / 64));
        batch.dispatchTensors(integer ? offsetInteger : offsetFloat, [output, offsets],
          Uint32Array.of(output.length, plan.length, plan.inner, plan.blocks, x), x, groupsY);
        batch.recycle(offsets);
      }
      batch.recycle(sums);
      return output;
    },
    scatterNd(batch, input, indices, indexShape, updates) {
      batch.check(input, updates);
      const plan = scatterNdPlan(input.shape, indices, indexShape, updates.shape);
      const output = batch.index(input, { shape: plan.shape, strides: contiguousStrides(plan.shape), offset: 0 });
      const [x, y] = batch.grid(Math.ceil(updates.length / 64)), parameters = new Uint32Array(4 + plan.offsets.length);
      parameters.set([updates.length, plan.blockSize, x]); parameters.set(plan.offsets, 4);
      batch.dispatchTensors(scatter, [updates, output], parameters, x, y);
      return output;
    },
    unary(batch, input, operation, { alpha = .01, min = -Infinity, max = Infinity } = {}) {
      batch.check(input);
      if (!Object.hasOwn(KOKORO_UNARY_OPERATIONS, operation) || !Number.isFinite(alpha) || Number.isNaN(min) || Number.isNaN(max) || min > max) throw new Error('Invalid Kokoro unary operation.');
      const output = batch.output(input.shape), [x, y] = batch.grid(Math.ceil(output.length / 64));
      batch.dispatchTensors(unary, [input, output], Uint32Array.of(output.length, KOKORO_UNARY_OPERATIONS[operation], floatBits(alpha), floatBits(min), floatBits(max), x), x, y);
      return output;
    },
  };
  return kernels;
}
