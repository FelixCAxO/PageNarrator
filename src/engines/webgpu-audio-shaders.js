// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// A 32 x 32 output tile gives each lane a 4 x 4 register block. Audio has no
// height coordinate, so its inner gather avoids the general image divisions.
export const CONV_1D_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> weight: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
var<workgroup> tileW: array<f32, 1024>;
var<workgroup> tileX: array<f32, 1024>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let batch = group.z / cfg[20u]; let g = group.z % cfg[20u];
  let channel = group.y * 32u + local.y * 4u; let pixel = group.x * 32u + local.x * 4u;
  let kSize = cfg[7u] * cfg[10u]; let lane = local.y * 8u + local.x;
  var sums: array<vec4<f32>, 4>;
  for (var block = 0u; block < kSize; block += 32u) {
    for (var chunk = 0u; chunk < 16u; chunk += 1u) {
      let index = lane + chunk * 64u; let wr = index / 32u; let wk = block + index % 32u;
      var w = 0.0; var x = 0.0;
      if (group.y * 32u + wr < cfg[8u] && wk < kSize) { w = weight[(g * cfg[8u] + group.y * 32u + wr) * kSize + wk]; }
      let xp = group.x * 32u + index % 32u; let xk = block + index / 32u;
      if (xp < cfg[6u] && xk < kSize) {
        let source = i32(xp * cfg[12u] + (xk % cfg[10u]) * cfg[14u]) - i32(cfg[16u]);
        if (source >= 0 && source < i32(cfg[3u])) { x = src[(batch * cfg[1u] + g * cfg[7u] + xk / cfg[10u]) * cfg[3u] + u32(source)]; }
      }
      tileW[index] = w; tileX[index] = x;
    }
    workgroupBarrier();
    for (var j = 0u; j < 32u; j += 1u) {
      let base = j * 32u + local.x * 4u;
      let x = vec4<f32>(tileX[base], tileX[base + 1u], tileX[base + 2u], tileX[base + 3u]);
      for (var row = 0u; row < 4u; row += 1u) { sums[row] += tileW[(local.y * 4u + row) * 32u + j] * x; }
    }
    workgroupBarrier();
  }
  for (var row = 0u; row < 4u; row += 1u) {
    let oc = g * cfg[8u] + channel + row;
    var b = 0.0; if (cfg[17u] != 0u && channel + row < cfg[8u]) { b = bias[oc]; }
    for (var column = 0u; column < 4u; column += 1u) {
      var value = sums[row][column] + b; if (cfg[18u] != 0u) { value = max(value, 0.0); }
      if (channel + row < cfg[8u] && pixel + column < cfg[6u]) { dst[(batch * cfg[4u] + oc) * cfg[6u] + pixel + column] = value; }
    }
  }
}
`;

// Tile each stride phase separately. Only kernel taps that can contribute to
// that phase enter the matrix product; input and weight tiles are shared.
export const CONV_TRANSPOSE_1D_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> weight: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
var<workgroup> tileW: array<f32, 256>;
var<workgroup> tileX: array<f32, 256>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let stride = cfg[12u]; let phase = group.z % stride;
  let batch = (group.z / stride) / cfg[20u]; let g = (group.z / stride) % cfg[20u];
  let channel = group.y * 16u + local.y * 2u; let column = group.x * 16u + local.x * 2u;
  let firstTap = (phase + cfg[16u]) % stride;
  var taps = 0u; if (firstTap < cfg[10u]) { taps = (cfg[10u] - firstTap + stride - 1u) / stride; }
  let kSize = cfg[7u] * taps; let lane = local.y * 8u + local.x;
  var s00 = 0.0; var s01 = 0.0; var s10 = 0.0; var s11 = 0.0;
  for (var block = 0u; block < kSize; block += 16u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let index = lane + chunk * 64u; let r = index / 16u; let c = index % 16u;
      let wc = group.y * 16u + r; let wk = block + c;
      var w = 0.0; var x = 0.0;
      if (wc < cfg[8u] && wk < kSize) {
        w = weight[((g * cfg[7u] + wk / taps) * cfg[8u] + wc) * cfg[10u] + firstTap + (wk % taps) * stride];
      }
      let xp = group.x * 16u + c; let xk = block + r;
      if (xp * stride + phase < cfg[6u] && xk < kSize) {
        let source = i32(xp + (phase + cfg[16u]) / stride) - i32(xk % taps);
        if (source >= 0 && source < i32(cfg[3u])) { x = src[(batch * cfg[1u] + g * cfg[7u] + xk / taps) * cfg[3u] + u32(source)]; }
      }
      tileW[index] = w; tileX[index] = x;
    }
    workgroupBarrier();
    for (var j = 0u; j < 16u; j += 1u) {
      let w0 = tileW[local.y * 32u + j]; let w1 = tileW[local.y * 32u + 16u + j];
      let x0 = tileX[j * 16u + local.x * 2u]; let x1 = tileX[j * 16u + local.x * 2u + 1u];
      s00 += w0 * x0; s01 += w0 * x1; s10 += w1 * x0; s11 += w1 * x1;
    }
    workgroupBarrier();
  }
  for (var row = 0u; row < 2u; row += 1u) {
    let oc = g * cfg[8u] + channel + row;
    var b = 0.0; if (cfg[17u] != 0u && channel + row < cfg[8u]) { b = bias[oc]; }
    var v0 = select(s00, s10, row == 1u) + b; var v1 = select(s01, s11, row == 1u) + b;
    if (cfg[18u] != 0u) { v0 = max(v0, 0.0); v1 = max(v1, 0.0); }
    let pixel = column * stride + phase;
    if (channel + row < cfg[8u] && pixel < cfg[6u]) { dst[(batch * cfg[4u] + oc) * cfg[6u] + pixel] = v0; }
    if (channel + row < cfg[8u] && pixel + stride < cfg[6u]) { dst[(batch * cfg[4u] + oc) * cfg[6u] + pixel + stride] = v1; }
  }
}
`;

export const SNAKE_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> alpha: array<f32>;
@group(0) @binding(2) var<storage, read> scale: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[2u] * 64u;
  if (index >= cfg[0u]) { return; }
  var ai = 0u; var si = 0u; var xi = 0u; var remaining = index;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    ai += coord * cfg[16u + u32(axis)]; si += coord * cfg[24u + u32(axis)]; xi += coord * cfg[32u + u32(axis)];
  }
  let x = src[xi]; let wave = sin(alpha[ai] * x);
  dst[index] = x + scale[si] * (wave * wave);
}
`;
