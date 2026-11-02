// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { SOFTMAX_SHADER } from './webgpu-index-shaders.js';
import { halfStorageShader } from './webgpu-precision-shaders.js';

// Keep both half-rounding steps before the unchanged float32 softmax reduction.
export const HALF_SCALED_MASKED_SOFTMAX_SHADER = halfStorageShader(SOFTMAX_SHADER)
  .replace('@binding(1)', '@binding(3)').replace('@binding(2)', '@binding(4)')
  .replace('var<workgroup> reduction:', `@group(0) @binding(1) var<storage, read> scale: array<f16>;
@group(0) @binding(2) var<storage, read> mask: array<f16>;
fn load_value(index: u32) -> f32 {
  let scaled = f16(f32(src[index]) * f32(scale[0u]));
  return f32(f16(f32(scaled) + f32(mask[index % cfg[3u]])));
}
var<workgroup> reduction:`)
  .replaceAll('f32(src[row * cfg[1u] + i])', 'load_value(row * cfg[1u] + i)');

export const HALF_ROTARY_SHADER=`enable f16;
@group(0) @binding(0) var<storage,read> src: array<f16>;
@group(0) @binding(1) var<storage,read> cosine: array<f16>;
@group(0) @binding(2) var<storage,read> sine: array<f16>;
@group(0) @binding(3) var<storage,read_write> dst: array<f16>;
@group(0) @binding(4) var<storage,read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i=p.x+p.y*cfg[2u]*64u;
  if(i>=cfg[0u]) {return;}
  var remaining=i; var xi=0u; var ci=0u; var si=0u;
  for(var axis=i32(cfg[1u])-1;axis>=0;axis-=1) {
    let a=u32(axis);let coordinate=remaining%cfg[8u+a];remaining/=cfg[8u+a];
    xi+=coordinate*cfg[16u+a];ci+=coordinate*cfg[24u+a];si+=coordinate*cfg[32u+a];
  }
  let negativeWidth=cfg[3u]-cfg[4u];let column=xi%cfg[3u];
  var rotatedIndex=xi;var negative=false;
  if(column<negativeWidth) {rotatedIndex+=cfg[4u];negative=true;} else {rotatedIndex-=negativeWidth;}
  var rotated=f32(src[rotatedIndex]);if(negative) {rotated=-rotated;}
  let rotatedHalf=f16(rotated);
  let first=f16(f32(src[xi])*f32(cosine[ci]));
  let second=f16(f32(rotatedHalf)*f32(sine[si]));
  dst[i]=f16(f32(first)+f32(second));
}`;
