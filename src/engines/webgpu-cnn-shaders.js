// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const convolutionBindings = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> weight: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
`;

// Implicit im2col: workgroup tiles gather directly from NCHW input instead of
// allocating and writing a large expanded image tensor.
export const CONV_TILED_SHADER = `${convolutionBindings}
var<workgroup> tileW: array<f32, 256>;
var<workgroup> tileX: array<f32, 256>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let batch = group.z / cfg[20u]; let g = group.z % cfg[20u];
  let channel = group.y * 16u + local.y * 2u;
  let pixel = group.x * 16u + local.x * 2u;
  let pixels = cfg[5u] * cfg[6u]; let kernel = cfg[9u] * cfg[10u];
  let kSize = cfg[7u] * kernel;
  let lane = local.y * 8u + local.x;
  var s00 = 0.0; var s01 = 0.0; var s10 = 0.0; var s11 = 0.0;
  for (var block = 0u; block < kSize; block += 16u) {
    for (var chunk = 0u; chunk < 4u; chunk += 1u) {
      let index = lane + chunk * 64u; let r = index / 16u; let c = index % 16u;
      let wc = group.y * 16u + r; let wk = block + c;
      var w = 0.0; var x = 0.0;
      if (wc < cfg[8u] && wk < kSize) { w = weight[(g * cfg[8u] + wc) * kSize + wk]; }
      let xp = group.x * 16u + c; let xk = block + r;
      if (xp < pixels && xk < kSize) {
        let h = i32((xp / cfg[6u]) * cfg[11u] + ((xk % kernel) / cfg[10u]) * cfg[13u]) - i32(cfg[15u]);
        let v = i32((xp % cfg[6u]) * cfg[12u] + (xk % cfg[10u]) * cfg[14u]) - i32(cfg[16u]);
        if (h >= 0 && h < i32(cfg[2u]) && v >= 0 && v < i32(cfg[3u])) {
          x = src[((batch * cfg[1u] + g * cfg[7u] + xk / kernel) * cfg[2u] + u32(h)) * cfg[3u] + u32(v)];
        }
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
    if (channel + row < cfg[8u] && pixel < pixels) { dst[(batch * cfg[4u] + oc) * pixels + pixel] = v0; }
    if (channel + row < cfg[8u] && pixel + 1u < pixels) { dst[(batch * cfg[4u] + oc) * pixels + pixel + 1u] = v1; }
  }
}
`;

// Direct gather handles depthwise kernels without mostly empty channel tiles,
// and transposed convolution without atomic scatter or a separate zeroing pass.
export const CONV_DIRECT_SHADER = `${convolutionBindings}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[21u] * 64u;
  let pixels = cfg[5u] * cfg[6u];
  if (index >= cfg[0u] * cfg[4u] * pixels) { return; }
  let batch = index / (cfg[4u] * pixels); let oc = (index / pixels) % cfg[4u];
  let oh = (index % pixels) / cfg[6u]; let ow = index % cfg[6u];
  let g = oc / cfg[8u]; let kernel = cfg[9u] * cfg[10u];
  var sum = 0.0;
  for (var ci = 0u; ci < cfg[7u]; ci += 1u) {
    for (var kh = 0u; kh < cfg[9u]; kh += 1u) {
      for (var kw = 0u; kw < cfg[10u]; kw += 1u) {
        var ih = i32(oh * cfg[11u] + kh * cfg[13u]) - i32(cfg[15u]);
        var iw = i32(ow * cfg[12u] + kw * cfg[14u]) - i32(cfg[16u]);
        var wi = ((oc * cfg[7u] + ci) * cfg[9u] + kh) * cfg[10u] + kw;
        if (cfg[19u] != 0u) {
          ih = i32(oh + cfg[15u]) - i32(kh * cfg[13u]); iw = i32(ow + cfg[16u]) - i32(kw * cfg[14u]);
          if (ih < 0 || iw < 0 || ih % i32(cfg[11u]) != 0 || iw % i32(cfg[12u]) != 0) { continue; }
          ih /= i32(cfg[11u]); iw /= i32(cfg[12u]);
          wi = (((g * cfg[7u] + ci) * cfg[8u] + oc % cfg[8u]) * cfg[9u] + kh) * cfg[10u] + kw;
        }
        if (ih >= 0 && ih < i32(cfg[2u]) && iw >= 0 && iw < i32(cfg[3u])) {
          let xi = ((batch * cfg[1u] + g * cfg[7u] + ci) * cfg[2u] + u32(ih)) * cfg[3u] + u32(iw);
          sum += src[xi] * weight[wi];
        }
      }
    }
  }
  if (cfg[17u] != 0u) { sum += bias[oc]; }
  if (cfg[18u] != 0u) { sum = max(sum, 0.0); }
  dst[index] = sum;
}
`;

export const REDUCE_MEAN_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
var<workgroup> sums: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let row = group.x + group.y * cfg[4u];
  if (row >= cfg[0u]) { return; }
  var offset = 0u; var remaining = row; var stride = 1u;
  for (var axis = i32(cfg[2u]) - 1; axis >= 0; axis -= 1) {
    let dim = cfg[8u + u32(axis)];
    if ((cfg[3u] & (1u << u32(axis))) == 0u) { offset += (remaining % dim) * stride; remaining /= dim; }
    stride *= dim;
  }
  var sum = select(0.0, -3.4028234663852886e38, cfg[5u] == 1u);
  for (var r = lane; r < cfg[1u]; r += 64u) {
    var index = offset; var value = r; var step = 1u;
    for (var axis = i32(cfg[2u]) - 1; axis >= 0; axis -= 1) {
      let dim = cfg[8u + u32(axis)];
      if ((cfg[3u] & (1u << u32(axis))) != 0u) { index += (value % dim) * step; value /= dim; }
      step *= dim;
    }
    sum = select(sum + src[index], max(sum, src[index]), cfg[5u] == 1u);
  }
  sums[lane] = sum; workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) {
    if (lane < step) { sums[lane] = select(sums[lane] + sums[lane + step], max(sums[lane], sums[lane + step]), cfg[5u] == 1u); } workgroupBarrier();
  }
  if (lane == 0u) { dst[row] = select(sums[0u] / f32(cfg[1u]), sums[0u], cfg[5u] != 0u); }
}
`;

export const POOL_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[15u] * 64u;
  if (index >= cfg[0u]) { return; }
  let plane = index / (cfg[3u] * cfg[4u]); let oh = (index / cfg[4u]) % cfg[3u]; let ow = index % cfg[4u];
  var result = select(-3.4028234663852886e38, 0.0, cfg[13u] == 1u); var count = 0u;
  for (var kh = 0u; kh < cfg[5u]; kh += 1u) {
    for (var kw = 0u; kw < cfg[6u]; kw += 1u) {
      let h = i32(oh * cfg[7u] + kh * cfg[9u]) - i32(cfg[11u]); let w = i32(ow * cfg[8u] + kw * cfg[10u]) - i32(cfg[12u]);
      if (h >= 0 && h < i32(cfg[1u]) && w >= 0 && w < i32(cfg[2u])) {
        let x = src[(plane * cfg[1u] + u32(h)) * cfg[2u] + u32(w)];
        result = select(max(result, x), result + x, cfg[13u] == 1u); count += 1u;
      } else if (cfg[14u] != 0u && h >= -i32(cfg[11u]) && w >= -i32(cfg[12u]) && h < i32(cfg[1u] + cfg[16u]) && w < i32(cfg[2u] + cfg[17u])) { count += 1u; }
    }
  }
  dst[index] = select(result, result / f32(count), cfg[13u] == 1u);
}
`;

export const RESIZE_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
fn coordinate(i: u32, input: u32, output: u32, scale: f32) -> f32 {
  switch cfg[8u] {
    case 1u: { if (output == 1u) { return 0.0; } return f32(i) * f32(input - 1u) / f32(output - 1u); }
    case 2u: { return f32(i) / scale; }
    case 3u: { if (output == 1u) { return 0.0; } return (f32(i) + 0.5) / scale - 0.5; }
    default: { return (f32(i) + 0.5) / scale - 0.5; }
  }
}
fn nearest(x: f32, size: u32) -> u32 {
  var value = floor(x);
  switch cfg[9u] {
    case 0u: { value = ceil(x - 0.5); }
    case 1u: { value = floor(x + 0.5); }
    case 3u: { value = ceil(x); }
    default: {}
  }
  return u32(clamp(value, 0.0, f32(size - 1u)));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[10u] * 64u;
  if (index >= cfg[0u]) { return; }
  let plane = index / (cfg[3u] * cfg[4u]); let oh = (index / cfg[4u]) % cfg[3u]; let ow = index % cfg[4u];
  let h = coordinate(oh, cfg[1u], cfg[3u], bitcast<f32>(cfg[5u])); let w = coordinate(ow, cfg[2u], cfg[4u], bitcast<f32>(cfg[6u]));
  if (cfg[7u] == 0u) { dst[index] = src[(plane * cfg[1u] + nearest(h, cfg[1u])) * cfg[2u] + nearest(w, cfg[2u])]; return; }
  let hc = clamp(h, 0.0, f32(cfg[1u] - 1u)); let wc = clamp(w, 0.0, f32(cfg[2u] - 1u));
  let h0 = u32(floor(hc)); let w0 = u32(floor(wc)); let h1 = min(h0 + 1u, cfg[1u] - 1u); let w1 = min(w0 + 1u, cfg[2u] - 1u);
  let v0 = mix(src[(plane * cfg[1u] + h0) * cfg[2u] + w0], src[(plane * cfg[1u] + h0) * cfg[2u] + w1], wc - f32(w0));
  let v1 = mix(src[(plane * cfg[1u] + h1) * cfg[2u] + w0], src[(plane * cfg[1u] + h1) * cfg[2u] + w1], wc - f32(w0));
  dst[index] = mix(v0, v1, hc - f32(h0));
}
`;

export const CONCAT_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[5u] * 64u;
  if (index >= cfg[0u]) { return; }
  let block = cfg[1u] * cfg[2u];
  let outputIndex = (index / block * cfg[3u] + cfg[4u]) * cfg[2u] + index % block;
  dst[outputIndex] = src[index];
}
`;
