// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const INDEX_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[3u] * 64u;
  if (index >= cfg[0u]) { return; }
  var source = i32(cfg[2u]); var remaining = index;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    source += i32(coord) * bitcast<i32>(cfg[16u + u32(axis)]);
  }
  dst[index] = src[u32(source)];
}
`;

export const GATHER_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[4u] * 64u;
  if (index >= cfg[0u]) { return; }
  let inner = index % cfg[1u]; let outer = index / (cfg[1u] * cfg[2u]);
  let selected = (index / cfg[1u]) % cfg[2u];
  dst[index] = src[(outer * cfg[3u] + cfg[8u + selected]) * cfg[1u] + inner];
}
`;

export const BATCH_NORM_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> scale: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read> mean: array<f32>;
@group(0) @binding(4) var<storage, read> variance: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst: array<f32>;
@group(0) @binding(6) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[4u] * 64u;
  if (index >= cfg[0u]) { return; }
  let channel = (index / cfg[2u]) % cfg[1u];
  dst[index] = (src[index] - mean[channel]) * inverseSqrt(variance[channel] + bitcast<f32>(cfg[3u])) * scale[channel] + bias[channel];
}
`;

export const SOFTMAX_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
var<workgroup> reduction: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let row = group.x + group.y * cfg[2u]; if (row >= cfg[0u]) { return; }
  var maximum = -3.4028234663852886e38;
  for (var i = lane; i < cfg[1u]; i += 64u) { maximum = max(maximum, src[row * cfg[1u] + i]); }
  reduction[lane] = maximum; workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) { if (lane < step) { reduction[lane] = max(reduction[lane], reduction[lane + step]); } workgroupBarrier(); }
  maximum = reduction[0u]; workgroupBarrier();
  var sum = 0.0;
  for (var i = lane; i < cfg[1u]; i += 64u) { sum += exp(src[row * cfg[1u] + i] - maximum); }
  reduction[lane] = sum; workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) { if (lane < step) { reduction[lane] += reduction[lane + step]; } workgroupBarrier(); }
  sum = reduction[0u];
  for (var i = lane; i < cfg[1u]; i += 64u) { dst[row * cfg[1u] + i] = exp(src[row * cfg[1u] + i] - maximum) / sum; }
}
`;

export const ARGMAX_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<i32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
var<workgroup> values: array<f32, 64>;
var<workgroup> indices: array<u32, 64>;
fn prefer(a: f32, ai: u32, b: f32, bi: u32) -> bool {
  return b > a || (b == a && select((bi < ai), (bi > ai), cfg[4u] != 0u));
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let row = group.x + group.y * cfg[3u]; if (row >= cfg[0u]) { return; }
  let base = row / cfg[2u] * cfg[1u] * cfg[2u] + row % cfg[2u];
  var best = -3.4028234663852886e38; var selected = select(0xffffffffu, 0u, cfg[4u] != 0u);
  for (var i = lane; i < cfg[1u]; i += 64u) { let value = src[base + i * cfg[2u]]; if (prefer(best, selected, value, i)) { best = value; selected = i; } }
  values[lane] = best; indices[lane] = selected; workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) {
    if (lane < step && prefer(values[lane], indices[lane], values[lane + step], indices[lane + step])) { values[lane] = values[lane + step]; indices[lane] = indices[lane + step]; }
    workgroupBarrier();
  }
  if (lane == 0u) { dst[row] = i32(indices[0u]); }
}
`;
