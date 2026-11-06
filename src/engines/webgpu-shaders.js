// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const MATMUL_SHADER = `
@group(0) @binding(0) var<storage, read> lhs: array<f32>;
@group(0) @binding(1) var<storage, read> rhs: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
var<workgroup> tileL: array<f32, 256>;
var<workgroup> tileR: array<f32, 256>;

@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.y * 8u + local.x;
  var ai = 0u; var bi = 0u; var remaining = group.z;
  for (var axis = i32(cfg[3u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    ai += coord * cfg[16u + u32(axis)]; bi += coord * cfg[24u + u32(axis)];
  }
  let baseA = ai * cfg[0u] * cfg[2u]; let baseB = bi * cfg[2u] * cfg[1u];
  let baseOut = group.z * cfg[0u] * cfg[1u];
  let row = group.y * 16u + local.y * 2u;
  let col = group.x * 16u + local.x * 2u;
  var sum00 = 0.0; var sum01 = 0.0; var sum10 = 0.0; var sum11 = 0.0;
  for (var block = 0u; block < cfg[2u]; block += 16u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let index = lane + chunk * 64u;
      let r = index / 16u; let c = index % 16u;
      var a = 0.0; var b = 0.0;
      if (group.y * 16u + r < cfg[0u] && block + c < cfg[2u]) { a = lhs[baseA + (group.y * 16u + r) * cfg[2u] + block + c]; }
      if (block + r < cfg[2u] && group.x * 16u + c < cfg[1u]) { b = rhs[baseB + (block + r) * cfg[1u] + group.x * 16u + c]; }
      tileL[index] = a; tileR[index] = b;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let a0 = tileL[(local.y * 2u) * 16u + j];
      let a1 = tileL[(local.y * 2u + 1u) * 16u + j];
      let b0 = tileR[j * 16u + local.x * 2u];
      let b1 = tileR[j * 16u + local.x * 2u + 1u];
      sum00 += a0 * b0; sum01 += a0 * b1;
      sum10 += a1 * b0; sum11 += a1 * b1;
    }
    workgroupBarrier();
  }
  if (row < cfg[0u] && col < cfg[1u]) { dst[baseOut + row * cfg[1u] + col] = sum00; }
  if (row < cfg[0u] && col + 1u < cfg[1u]) { dst[baseOut + row * cfg[1u] + col + 1u] = sum01; }
  if (row + 1u < cfg[0u] && col < cfg[1u]) { dst[baseOut + (row + 1u) * cfg[1u] + col] = sum10; }
  if (row + 1u < cfg[0u] && col + 1u < cfg[1u]) { dst[baseOut + (row + 1u) * cfg[1u] + col + 1u] = sum11; }
}
`;

// Even inner/output dimensions let each word load and store carry two half values.
export const PACKED_HALF_MATMUL_SHADER = `enable f16;
@group(0) @binding(0) var<storage, read> lhs: array<u32>;
@group(0) @binding(1) var<storage, read> rhs: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> cfg: array<vec4<u32>, 8>;
fn pn_config(index: u32) -> u32 { return cfg[index / 4u][index % 4u]; }
var<workgroup> tileL: array<f32, 256>;
var<workgroup> tileR: array<f32, 256>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.y * 8u + local.x;
  var ai = 0u; var bi = 0u; var remaining = group.z;
  for (var axis = i32(pn_config(3u)) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % pn_config(8u + u32(axis)); remaining /= pn_config(8u + u32(axis));
    ai += coord * pn_config(16u + u32(axis)); bi += coord * pn_config(24u + u32(axis));
  }
  let baseA = ai * pn_config(0u) * pn_config(2u); let baseB = bi * pn_config(2u) * pn_config(1u);
  let baseOut = group.z * pn_config(0u) * pn_config(1u);
  let row = group.y * 16u + local.y * 2u;
  let col = group.x * 16u + local.x * 2u;
  var sum00 = 0.0; var sum01 = 0.0; var sum10 = 0.0; var sum11 = 0.0;
  for (var block = 0u; block < pn_config(2u); block += 16u) {
    for (var chunk = 0u; chunk < 2u; chunk += 1u) {
      let pair = lane + chunk * 64u;
      let r = pair / 8u; let c = pair % 8u * 2u;
      var a = vec2<f32>(0.0); var b = vec2<f32>(0.0);
      if (group.y * 16u + r < pn_config(0u) && block + c < pn_config(2u)) { a = vec2<f32>(bitcast<vec2<f16>>(lhs[(baseA + (group.y * 16u + r) * pn_config(2u) + block + c) / 2u])); }
      if (block + r < pn_config(2u) && group.x * 16u + c < pn_config(1u)) { b = vec2<f32>(bitcast<vec2<f16>>(rhs[(baseB + (block + r) * pn_config(1u) + group.x * 16u + c) / 2u])); }
      tileL[pair * 2u] = a.x; tileL[pair * 2u + 1u] = a.y;
      tileR[pair * 2u] = b.x; tileR[pair * 2u + 1u] = b.y;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let a0 = tileL[(local.y * 2u) * 16u + j]; let a1 = tileL[(local.y * 2u + 1u) * 16u + j];
      let b0 = tileR[j * 16u + local.x * 2u]; let b1 = tileR[j * 16u + local.x * 2u + 1u];
      sum00 += a0 * b0; sum01 += a0 * b1; sum10 += a1 * b0; sum11 += a1 * b1;
    }
    workgroupBarrier();
  }
  if (row < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + row * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(vec2<f32>(sum00, sum01))); }
  if (row + 1u < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + (row + 1u) * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(vec2<f32>(sum10, sum11))); }
}
`;

// Retain each output's original ascending additions, including its 16-term tail.
// Loading 32 inner terms halves synchronization without changing output tiling.
export const PACKED_HALF_MATMUL_K32_SHADER = `enable f16;
@group(0) @binding(0) var<storage, read> lhs: array<u32>;
@group(0) @binding(1) var<storage, read> rhs: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> cfg: array<vec4<u32>, 8>;
fn pn_config(index: u32) -> u32 { return cfg[index / 4u][index % 4u]; }
var<workgroup> tileL: array<f32, 512>;
var<workgroup> tileR: array<f32, 512>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.y * 8u + local.x;
  var ai = 0u; var bi = 0u; var remaining = group.z;
  for (var axis = i32(pn_config(3u)) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % pn_config(8u + u32(axis)); remaining /= pn_config(8u + u32(axis));
    ai += coord * pn_config(16u + u32(axis)); bi += coord * pn_config(24u + u32(axis));
  }
  let baseA = ai * pn_config(0u) * pn_config(2u); let baseB = bi * pn_config(2u) * pn_config(1u);
  let baseOut = group.z * pn_config(0u) * pn_config(1u);
  let row = group.y * 16u + local.y * 2u;
  let col = group.x * 16u + local.x * 2u;
  var sum00 = 0.0; var sum01 = 0.0; var sum10 = 0.0; var sum11 = 0.0;
  for (var block = 0u; block < pn_config(2u); block += 32u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let pair = lane + chunk * 64u;
      let ar = pair / 16u; let ac = pair % 16u * 2u;
      let br = pair / 8u; let bc = pair % 8u * 2u;
      var a = vec2<f32>(0.0); var b = vec2<f32>(0.0);
      if (group.y * 16u + ar < pn_config(0u) && block + ac < pn_config(2u)) { a = vec2<f32>(bitcast<vec2<f16>>(lhs[(baseA + (group.y * 16u + ar) * pn_config(2u) + block + ac) / 2u])); }
      if (block + br < pn_config(2u) && group.x * 16u + bc < pn_config(1u)) { b = vec2<f32>(bitcast<vec2<f16>>(rhs[(baseB + (block + br) * pn_config(1u) + group.x * 16u + bc) / 2u])); }
      tileL[pair * 2u] = a.x; tileL[pair * 2u + 1u] = a.y;
      tileR[pair * 2u] = b.x; tileR[pair * 2u + 1u] = b.y;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let a0 = tileL[(local.y * 2u) * 32u + j]; let a1 = tileL[(local.y * 2u + 1u) * 32u + j];
      let b0 = tileR[j * 16u + local.x * 2u]; let b1 = tileR[j * 16u + local.x * 2u + 1u];
      sum00 += a0 * b0; sum01 += a0 * b1; sum10 += a1 * b0; sum11 += a1 * b1;
    }
    if (block + 16u < pn_config(2u)) {
      for (var j = 16u; j < 32u; j += 1u) {
        let a0 = tileL[(local.y * 2u) * 32u + j]; let a1 = tileL[(local.y * 2u + 1u) * 32u + j];
        let b0 = tileR[j * 16u + local.x * 2u]; let b1 = tileR[j * 16u + local.x * 2u + 1u];
        sum00 += a0 * b0; sum01 += a0 * b1; sum10 += a1 * b0; sum11 += a1 * b1;
      }
    }
    workgroupBarrier();
  }
  if (row < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + row * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(vec2<f32>(sum00, sum01))); }
  if (row + 1u < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + (row + 1u) * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(vec2<f32>(sum10, sum11))); }
}
`;

// Larger dense projections reuse each loaded value across a 16x32 output tile.
// K blocks and each output's sequential f32 additions match the 16x16 kernel.
export const PACKED_HALF_MATMUL_WIDE_SHADER = `enable f16;
@group(0) @binding(0) var<storage, read> lhs: array<u32>;
@group(0) @binding(1) var<storage, read> rhs: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> cfg: array<vec4<u32>, 8>;
fn pn_config(index: u32) -> u32 { return cfg[index / 4u][index % 4u]; }
var<workgroup> tileL: array<f32, 256>;
var<workgroup> tileR: array<f32, 512>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.y * 8u + local.x;
  var ai = 0u; var bi = 0u; var remaining = group.z;
  for (var axis = i32(pn_config(3u)) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % pn_config(8u + u32(axis)); remaining /= pn_config(8u + u32(axis));
    ai += coord * pn_config(16u + u32(axis)); bi += coord * pn_config(24u + u32(axis));
  }
  let baseA = ai * pn_config(0u) * pn_config(2u); let baseB = bi * pn_config(2u) * pn_config(1u);
  let baseOut = group.z * pn_config(0u) * pn_config(1u);
  let row = group.y * 16u + local.y * 2u;
  let col = group.x * 32u + local.x * 4u;
  var sum0 = vec4<f32>(0.0); var sum1 = vec4<f32>(0.0);
  for (var block = 0u; block < pn_config(2u); block += 16u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let pair = lane + chunk * 64u;
      let ar = pair / 8u; let ac = pair % 8u * 2u;
      let br = pair / 16u; let bc = pair % 16u * 2u;
      var a = vec2<f32>(0.0); var b = vec2<f32>(0.0);
      if (pair < 128u && group.y * 16u + ar < pn_config(0u) && block + ac < pn_config(2u)) { a = vec2<f32>(bitcast<vec2<f16>>(lhs[(baseA + (group.y * 16u + ar) * pn_config(2u) + block + ac) / 2u])); }
      if (block + br < pn_config(2u) && group.x * 32u + bc < pn_config(1u)) { b = vec2<f32>(bitcast<vec2<f16>>(rhs[(baseB + (block + br) * pn_config(1u) + group.x * 32u + bc) / 2u])); }
      if (pair < 128u) { tileL[pair * 2u] = a.x; tileL[pair * 2u + 1u] = a.y; }
      tileR[pair * 2u] = b.x; tileR[pair * 2u + 1u] = b.y;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let offset = j * 32u + local.x * 4u;
      let b = vec4<f32>(tileR[offset], tileR[offset + 1u], tileR[offset + 2u], tileR[offset + 3u]);
      let a0 = tileL[(local.y * 2u) * 16u + j];
      let a1 = tileL[(local.y * 2u + 1u) * 16u + j];
      sum0 += a0 * b; sum1 += a1 * b;
    }
    workgroupBarrier();
  }
  for (var r = 0u; r < 2u; r += 1u) {
    let sum = select(sum0, sum1, r == 1u);
    if (row + r < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + (row + r) * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(sum.xy)); }
    if (row + r < pn_config(0u) && col + 2u < pn_config(1u)) { dst[(baseOut + (row + r) * pn_config(1u) + col + 2u) / 2u] = bitcast<u32>(vec2<f16>(sum.zw)); }
  }
}
`;

// Larger dense projections reuse each loaded value across a 32x32 output tile.
// K blocks and each output's sequential f32 additions match the 16x16 kernel.
export const PACKED_HALF_MATMUL_32_SHADER = `enable f16;
@group(0) @binding(0) var<storage, read> lhs: array<u32>;
@group(0) @binding(1) var<storage, read> rhs: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> cfg: array<vec4<u32>, 8>;
fn pn_config(index: u32) -> u32 { return cfg[index / 4u][index % 4u]; }
var<workgroup> tileL: array<f32, 512>;
var<workgroup> tileR: array<f32, 512>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.y * 8u + local.x;
  var ai = 0u; var bi = 0u; var remaining = group.z;
  for (var axis = i32(pn_config(3u)) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % pn_config(8u + u32(axis)); remaining /= pn_config(8u + u32(axis));
    ai += coord * pn_config(16u + u32(axis)); bi += coord * pn_config(24u + u32(axis));
  }
  let baseA = ai * pn_config(0u) * pn_config(2u); let baseB = bi * pn_config(2u) * pn_config(1u);
  let baseOut = group.z * pn_config(0u) * pn_config(1u);
  let row = group.y * 32u + local.y * 4u;
  let col = group.x * 32u + local.x * 4u;
  var sums: array<vec4<f32>, 4>;
  for (var block = 0u; block < pn_config(2u); block += 16u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let pair = lane + chunk * 64u;
      let ar = pair / 8u; let ac = pair % 8u * 2u;
      let br = pair / 16u; let bc = pair % 16u * 2u;
      var a = vec2<f32>(0.0); var b = vec2<f32>(0.0);
      if (group.y * 32u + ar < pn_config(0u) && block + ac < pn_config(2u)) { a = vec2<f32>(bitcast<vec2<f16>>(lhs[(baseA + (group.y * 32u + ar) * pn_config(2u) + block + ac) / 2u])); }
      if (block + br < pn_config(2u) && group.x * 32u + bc < pn_config(1u)) { b = vec2<f32>(bitcast<vec2<f16>>(rhs[(baseB + (block + br) * pn_config(1u) + group.x * 32u + bc) / 2u])); }
      tileL[pair * 2u] = a.x; tileL[pair * 2u + 1u] = a.y;
      tileR[pair * 2u] = b.x; tileR[pair * 2u + 1u] = b.y;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let offset = j * 32u + local.x * 4u;
      let b = vec4<f32>(tileR[offset], tileR[offset + 1u], tileR[offset + 2u], tileR[offset + 3u]);
      for (var r = 0u; r < 4u; r += 1u) {
        let a = tileL[(local.y * 4u + r) * 16u + j];
        sums[r] += a * b;
      }
    }
    workgroupBarrier();
  }
  for (var r = 0u; r < 4u; r += 1u) {
    if (row + r < pn_config(0u) && col < pn_config(1u)) { dst[(baseOut + (row + r) * pn_config(1u) + col) / 2u] = bitcast<u32>(vec2<f16>(sums[r].xy)); }
    if (row + r < pn_config(0u) && col + 2u < pn_config(1u)) { dst[(baseOut + (row + r) * pn_config(1u) + col + 2u) / 2u] = bitcast<u32>(vec2<f16>(sums[r].zw)); }
  }
}
`;

// tanh rounds to +/-1 in float32 by |x|=10. Bounded input prevents the
// sinh/cosh overflow permitted for the WGSL builtin at larger finite values.
export const BOUNDED_TANH_SHADER = `
fn pn_tanh(x: f32) -> f32 {
  if (x == 0.0) { return x; }
  if (abs(x) <= 0.125) {
    let z = x * x;
    return x * (1.0 + z * (-1.0 / 3.0 + z * (2.0 / 15.0 + z * (-17.0 / 315.0 + z * (62.0 / 2835.0 + z * (-1382.0 / 155925.0 + z * (21844.0 / 6081075.0)))))));
  }
  return tanh(clamp(x, -10.0, 10.0));
}
`;

export const ELEMENTWISE_SHADER = `
${BOUNDED_TANH_SHADER}
@group(0) @binding(0) var<storage, read> lhs: array<f32>;
@group(0) @binding(1) var<storage, read> rhs: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;

fn erf_value(x: f32) -> f32 {
  let a = abs(x); let t = 1.0 / (1.0 + 0.3275911 * a);
  let p = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign(x) * (1.0 - p * exp(-a * a));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[7u] * 64u;
  if (index >= cfg[0u]) { return; }
  var ai = select(index, 0u, (cfg[6u] & 1u) != 0u);
  var bi = select(index, 0u, (cfg[6u] & 2u) != 0u);
  if (cfg[2u] == 0u) {
    ai = 0u; bi = 0u; var remaining = index;
    for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
      let coord = remaining % cfg[8u + u32(axis)];
      remaining /= cfg[8u + u32(axis)];
      ai += coord * cfg[16u + u32(axis)]; bi += coord * cfg[24u + u32(axis)];
    }
  }
  let x = lhs[ai];
  let op = cfg[3u];
  var result = x;
  switch op {
    case 0u: { result = x + rhs[bi]; }
    case 1u: { result = x * rhs[bi]; }
    case 2u: { result = x / rhs[bi]; }
    case 3u: { result = x - rhs[bi]; }
    case 4u: {
      let y = rhs[bi];
      if (y == 2.0) { result = x * x; }
      else if (y == 3.0) { result = x * x * x; }
      else if (x < 0.0 && floor(y) == y) { result = pow(-x, y) * select(1.0, -1.0, (u32(abs(y)) & 1u) != 0u); }
      else { result = pow(x, y); }
    }
    case 5u: { result = select(x, x * rhs[bi], x < 0.0); }
    case 101u: { result = max(x, 0.0); }
    case 102u: { result = 1.0 / (1.0 + exp(-x)); }
    case 103u: { result = pn_tanh(x); }
    case 104u: { result = erf_value(x); }
    case 105u: { result = sqrt(x); }
    case 106u: { result = exp(x); }
    case 107u: { result = -x; }
    case 108u: { result = 1.0 / x; }
    case 109u: { result = clamp(bitcast<f32>(cfg[4u]) * x + bitcast<f32>(cfg[5u]), 0.0, 1.0); }
    case 110u: { result = sin(x); }
    case 111u: { result = cos(x); }
    default: {}
  }
  dst[index] = result;
}
`;
