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

// tanh rounds to +/-1 in float32 by |x|=10. Bounded input prevents the
// sinh/cosh overflow permitted for the WGSL builtin at larger finite values.
export const BOUNDED_TANH_SHADER = `
fn pn_tanh(x: f32) -> f32 {
  if (x == 0.0) { return x; }
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
  var ai = index; var bi = index;
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
