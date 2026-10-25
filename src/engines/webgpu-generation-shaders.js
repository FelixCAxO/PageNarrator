// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const storage = { float32: 'f32', float16: 'f16', int32: 'i32', bool: 'u32' };

/** Generate tensors on device; parameters retain the exact scalar bit pattern. */
export function generationShader(type, range = false) {
  if (!storage[type] || (range && type === 'bool')) throw new Error('Unsupported generated tensor type.');
  const value = range
    ? type === 'int32' ? 'bitcast<i32>(cfg[2u]) + i32(i) * bitcast<i32>(cfg[3u])'
      : `${storage[type]}(bitcast<f32>(cfg[2u]) + f32(i) * bitcast<f32>(cfg[3u]))`
    : type === 'bool' ? 'cfg[2u]' : type === 'int32' ? 'bitcast<i32>(cfg[2u])' : `${storage[type]}(bitcast<f32>(cfg[2u]))`;
  return `${type === 'float16' ? 'enable f16;' : ''}
@group(0) @binding(0) var<storage, read_write> dst: array<${storage[type]}>;
@group(0) @binding(1) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i = p.x + p.y * cfg[1u] * 64u;
  if (i < cfg[0u]) { dst[i] = ${value}; }
}`;
}

export function rangePlan(start, end, step, type) {
  if (!['int32', 'float32', 'float16'].includes(type) || ![start, end, step].every(Number.isFinite) || !step) {
    throw new RangeError('Range requires finite matching numeric scalars and a nonzero step.');
  }
  const count = Math.max(0, Math.ceil((end - start) / step));
  if (!Number.isSafeInteger(count) || count > 0xffffffff) throw new RangeError('Range element count exceeds the supported tensor limit.');
  if (type === 'int32' && (![start, end, step].every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647))) {
    throw new RangeError('Integer Range scalars must fit int32.');
  }
  const last = start + Math.max(0, count - 1) * step;
  return { shape: [count], bounds: type === 'int32' && count ? { min: Math.min(start, last), max: Math.max(start, last) } : null };
}
