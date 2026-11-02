// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import {kokoroFloatShader}from'./kokoro-float-shaders.js';

export const KOKORO_LAYER_NORM_SHADER = `
${kokoroFloatShader(6)}
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> scale: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
var<workgroup> sums:array<vec2<f32>,4>;
var<workgroup> squares:array<f32,8>;
var<workgroup> average:f32;
var<workgroup> inverse:f32;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let row=group.x+group.y*cfg[3u];if(row>=cfg[0u]){return;}let width=cfg[1u];let at=row*width;
  if(lane<4u){var sum=vec2<f32>(0.0);for(var j=lane;j<width/4u*4u;j+=4u){sum=pn_pair_add(sum,vec2<f32>(src[at+j],0.0));}sums[lane]=sum;}
  workgroupBarrier();
  if(lane==0u){var total=pn_pair_add(pn_pair_add(sums[0u],sums[2u]),pn_pair_add(sums[1u],sums[3u]));for(var j=width/4u*4u;j<width;j+=1u){total=pn_pair_add(total,vec2<f32>(src[at+j],0.0));}average=pn_pair_div(total,f32(width));}
  workgroupBarrier();
  if(lane<8u){var sum=0.0;for(var j=lane;j<width/8u*8u;j+=8u){let d=pn_sub(src[at+j],average);sum=fma(d,d,sum);}squares[lane]=sum;}
  workgroupBarrier();
  if(lane==0u){var variance=pn_add(pn_add(pn_add(squares[0u],squares[4u]),pn_add(squares[2u],squares[6u])),pn_add(pn_add(squares[1u],squares[5u]),pn_add(squares[3u],squares[7u])));
    for(var j=width/8u*8u;j<width;j+=1u){let d=pn_sub(src[at+j],average);variance=pn_add(variance,pn_mul(d,d));}
    inverse=pn_div(1.0,pn_sqrt(pn_add(pn_div(variance,f32(width)),bitcast<f32>(cfg[2u]))));}
  workgroupBarrier();
  for(var j=lane;j<width;j+=64u){
    let normalized=pn_mul(pn_sub(src[at+j],average),inverse);
    var result:f32;
    // A select with both products live lets Intel reuse the unfused product for fma.
    if(cfg[4u]!=0u){
      if(j<width/8u*8u){result=fma(normalized,scale[j],bias[j]);}
      else{result=pn_add(pn_mul(normalized,scale[j]),bias[j]);}
    }else{result=pn_mul(normalized,scale[j]);}
    dst[at+j]=result;
  }
}
`;

export const KOKORO_LSTM_SHADER = `
${kokoroFloatShader(5)}
@group(0) @binding(0) var<storage, read> projected: array<f32>;
@group(0) @binding(1) var<storage, read> recurrent: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read> initialH: array<f32>;
@group(0) @binding(4) var<storage, read> initialC: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst: array<f32>;
@group(0) @binding(6) var<storage, read_write> states: array<f32>;
@group(0) @binding(7) var<storage, read> cfg: array<u32>;
var<workgroup> previousH: array<f32,256>;
fn sigmoid(value:f32)->f32{return pn_sigmoid(value);}
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
      var dot=vec4<f32>(0.0);
      for (var column = 0u; column < hidden; column += 1u) {
        let r = (direction * hidden + column) * 4u * hidden + unit;
        dot=fma(vec4<f32>(previousH[column]),vec4<f32>(recurrent[r],recurrent[r+hidden],recurrent[r+2u*hidden],recurrent[r+3u*hidden]),dot);
      }
      gates=vec4<f32>(pn_add(gates.x,dot.x),pn_add(gates.y,dot.y),pn_add(gates.z,dot.z),pn_add(gates.w,dot.w));
      gates=vec4<f32>(pn_add(gates.x,pn_add(bias[b],bias[b+4u*hidden])),pn_add(gates.y,pn_add(bias[b+hidden],bias[b+5u*hidden])),pn_add(gates.z,pn_add(bias[b+2u*hidden],bias[b+6u*hidden])),pn_add(gates.w,pn_add(bias[b+3u*hidden],bias[b+7u*hidden])));
      cell=pn_add(pn_mul(sigmoid(gates.z),cell),pn_mul(sigmoid(gates.x),pn_tanh(gates.w)));
      nextHidden=pn_mul(sigmoid(gates.y),pn_tanh(cell));
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
