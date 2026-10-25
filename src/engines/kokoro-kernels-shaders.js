// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { BOUNDED_TANH_SHADER } from './webgpu-shaders.js';

export const KOKORO_LAYER_NORM_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> scale: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
var<workgroup> partial: array<f32,64>;
var<workgroup> average: f32;
var<workgroup> inverse: f32;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let row = group.x + group.y * cfg[3u];
  if (row >= cfg[0u]) { return; }
  let width = cfg[1u]; let offset = row * width;
  var sum = 0.0;
  for (var column = lane; column < width; column += 64u) { sum += src[offset + column]; }
  partial[lane] = sum; workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) { partial[lane] += partial[lane + stride]; } workgroupBarrier();
  }
  if (lane == 0u) { average = partial[0u] / f32(width); } workgroupBarrier();
  var variance = 0.0;
  for (var column = lane; column < width; column += 64u) { let centered = src[offset + column] - average; variance += centered * centered; }
  partial[lane] = variance; workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) { partial[lane] += partial[lane + stride]; } workgroupBarrier();
  }
  if (lane == 0u) { inverse = inverseSqrt(partial[0u] / f32(width) + bitcast<f32>(cfg[2u])); } workgroupBarrier();
  for (var column = lane; column < width; column += 64u) {
    var shift = 0.0; if (cfg[4u] != 0u) { shift = bias[column]; }
    dst[offset + column] = (src[offset + column] - average) * inverse * scale[column] + shift;
  }
}
`;

export const KOKORO_LSTM_SHADER = `
${BOUNDED_TANH_SHADER}
@group(0) @binding(0) var<storage, read> projected: array<f32>;
@group(0) @binding(1) var<storage, read> recurrent: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read> initialH: array<f32>;
@group(0) @binding(4) var<storage, read> initialC: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst: array<f32>;
@group(0) @binding(6) var<storage, read_write> states: array<f32>;
@group(0) @binding(7) var<storage, read> cfg: array<u32>;
var<workgroup> previousH: array<f32,256>;
fn sigmoid(value: f32) -> f32 { return 1.0 / (1.0 + exp(-value)); }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) unit: u32) {
  let direction = group.x; let batch = group.y; let steps = cfg[0u]; let batches = cfg[1u]; let hidden = cfg[2u]; let directions = cfg[3u];
  let stateOffset = (direction * batches + batch) * hidden;
  var cell = 0.0;
  if (unit < hidden) { previousH[unit] = initialH[stateOffset + unit]; cell = initialC[stateOffset + unit]; }
  workgroupBarrier();
  for (var step = 0u; step < steps; step += 1u) {
    let time = select(step, steps - step - 1u, direction == 1u || cfg[4u] != 0u);
    var nextHidden = 0.0;
    if (unit < hidden) {
      let projection = ((direction * steps + time) * batches + batch) * 4u * hidden + unit;
      let b = direction * 8u * hidden + unit;
      var gates = vec4<f32>(projected[projection], projected[projection + hidden], projected[projection + 2u * hidden], projected[projection + 3u * hidden]);
      gates += vec4<f32>(bias[b] + bias[b + 4u * hidden], bias[b + hidden] + bias[b + 5u * hidden], bias[b + 2u * hidden] + bias[b + 6u * hidden], bias[b + 3u * hidden] + bias[b + 7u * hidden]);
      for (var column = 0u; column < hidden; column += 1u) {
        let r = (direction * hidden + column) * 4u * hidden + unit;
        gates += previousH[column] * vec4<f32>(recurrent[r], recurrent[r + hidden], recurrent[r + 2u * hidden], recurrent[r + 3u * hidden]);
      }
      cell = sigmoid(gates.z) * cell + sigmoid(gates.x) * pn_tanh(gates.w);
      nextHidden = sigmoid(gates.y) * pn_tanh(cell);
      dst[((time * directions + direction) * batches + batch) * hidden + unit] = nextHidden;
    }
    workgroupBarrier();
    if (unit < hidden) { previousH[unit] = nextHidden; }
    workgroupBarrier();
  }
  if (unit < hidden) {
    states[stateOffset + unit] = previousH[unit];
    states[directions * batches * hidden + stateOffset + unit] = cell;
  }
}
`;

export const KOKORO_STFT_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> window: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position: vec3<u32>) {
  let index = position.x + position.y * cfg[7u] * 64u;
  if (index >= cfg[6u]) { return; }
  let bin = index % cfg[5u]; let frame = (index / cfg[5u]) % cfg[4u]; let batch = index / (cfg[5u] * cfg[4u]);
  let realBin = bin == 0u || (cfg[2u] % 2u == 0u && bin == cfg[2u] / 2u);
  var real = 0.0; var imaginary = 0.0;
  for (var sample = 0u; sample < cfg[2u]; sample += 1u) {
    let angle = -6.283185307179586 * f32(bin * sample) / f32(cfg[2u]);
    let value = src[batch * cfg[1u] + frame * cfg[3u] + sample] * window[sample];
    if (realBin) { real += value * select(-1.0, 1.0, bin == 0u || sample % 2u == 0u); }
    else { real += value * cos(angle); imaginary += value * sin(angle); }
  }
  dst[index * 2u] = real; dst[index * 2u + 1u] = imaginary;
}
`;
