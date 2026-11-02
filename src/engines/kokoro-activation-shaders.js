import{KOKORO_TRIG_SHADER}from'./kokoro-trigonometry-shader.js';
// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { BOUNDED_TANH_SHADER, ELEMENTWISE_SHADER } from './webgpu-shaders.js';
import { kokoroFloatShader } from './kokoro-float-shaders.js';
export const KOKORO_ELEMENTWISE_SHADER = ELEMENTWISE_SHADER.replace(BOUNDED_TANH_SHADER,kokoroFloatShader(32)+KOKORO_TRIG_SHADER)
  .replace('result = x / rhs[bi];','result = pn_div(x,rhs[bi]);')
  .replace('result = 1.0 / (1.0 + exp(-x));','result = pn_sigmoid(x);')
  .replace('result = sqrt(x);','result = pn_sqrt(x);')
  .replace('result = 1.0 / x;','result = pn_div(1.0,x);')
  .replace('result = sin(x);','result = pn_trig(x,false);')
  .replace('result = cos(x);','result = pn_trig(x,true);');
export const KOKORO_SOFTMAX_SHADER = `
${kokoroFloatShader(3)}
@group(0) @binding(0) var<storage,read> src:array<f32>;
@group(0) @binding(1) var<storage,read_write> dst:array<f32>;
@group(0) @binding(2) var<storage,read> cfg:array<u32>;
var<workgroup> maximums:array<f32,64>;
var<workgroup> sums:array<f32,8>;
var<workgroup> maximum:f32;
var<workgroup> inverse:f32;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let row=group.x+group.y*cfg[2u];if(row>=cfg[0u]){return;}let at=row*cfg[1u];
  var m=-3.4028234663852886e38;for(var j=lane;j<cfg[1u];j+=64u){m=max(m,src[at+j]);}maximums[lane]=m;workgroupBarrier();
  for(var step=32u;step>0u;step/=2u){if(lane<step){maximums[lane]=max(maximums[lane],maximums[lane+step]);}workgroupBarrier();}
  if(lane==0u){maximum=maximums[0u];}workgroupBarrier();
  if(lane<8u){var sum=0.0;for(var j=lane;j<cfg[1u];j+=8u){let e=pn_sum_exp(pn_sub(src[at+j],maximum));sum=pn_add(sum,e);dst[at+j]=e;}sums[lane]=sum;}
  workgroupBarrier();
  if(lane==0u){let sum=pn_add(pn_add(pn_add(sums[0u],sums[1u]),pn_add(sums[2u],sums[3u])),pn_add(pn_add(sums[4u],sums[5u]),pn_add(sums[6u],sums[7u])));inverse=pn_div(1.0,sum);}
  workgroupBarrier();
  if(lane<8u){for(var j=lane;j<cfg[1u];j+=8u){dst[at+j]=pn_mul(dst[at+j],inverse);}}
}
`;
