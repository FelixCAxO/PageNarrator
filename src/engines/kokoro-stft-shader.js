// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{kokoroFloatShader}from'./kokoro-float-shaders.js';
export const KOKORO_FFT_SHADER=`
${kokoroFloatShader(9)}
@group(0) @binding(0) var<storage,read> src:array<f32>;
@group(0) @binding(1) var<storage,read> window:array<f32>;
@group(0) @binding(2) var<storage,read_write> dst:array<f32>;
@group(0) @binding(3) var<storage,read> cfg:array<u32>;
var<workgroup> values:array<vec2<f32>,128>;
var<workgroup> temporary:array<vec2<f32>,128>;
fn pn_reverse(n:u32,bits:u32)->u32{var x=n;var result=0u;for(var i=0u;i<bits;i+=1u){result=result*2u+(x&1u);x>>=1u;}return result;}
fn pn_complex(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{return vec2<f32>(pn_sub(pn_mul(a.x,b.x),pn_mul(a.y,b.y)),pn_add(pn_mul(a.x,b.y),pn_mul(a.y,b.x)));}
fn pn_coefficient(base:u32,i:u32)->vec2<f32>{return vec2<f32>(bitcast<f32>(cfg[base+i*2u]),bitcast<f32>(cfg[base+i*2u+1u]));}
fn pn_fft(lane:u32){
  for(var width=2u; width<=cfg[6u];width*=2u){let half=width/2u;let stage=countTrailingZeros(width);
    for(var pair=lane;pair<cfg[6u]/2u;pair+=64u){let i=pair%half;let block=pair/half*width;let low=values[block+i];let high=values[block+i+half];let a=pn_complex(pn_coefficient(10u,pn_reverse(i,stage)),high);let b=pn_complex(pn_coefficient(10u,pn_reverse(i+half,stage)),high);values[block+i]=vec2<f32>(pn_add(low.x,a.x),pn_add(low.y,a.y));values[block+i+half]=vec2<f32>(pn_add(low.x,b.x),pn_add(low.y,b.y));}
    workgroupBarrier();
  }
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let frame=group.x+group.y*cfg[7u];if(frame>=cfg[0u]*cfg[4u]){return;}let batch=frame/cfg[4u];let step=frame%cfg[4u];let length=cfg[2u];let base=batch*cfg[1u]+step*cfg[3u];
  if(length==1u){if(lane==0u){let x=src[base];let w=window[0u];dst[frame*2u]=pn_mul(x,w);dst[frame*2u+1u]=bitcast<f32>((bitcast<u32>(x)^bitcast<u32>(w))&0x80000000u);}return;}
  let chirped=(length&(length-1u))!=0u;let chirpBase=10u+cfg[6u]*2u;let kernelBase=chirpBase+length*2u;
  for(var i=lane;i<cfg[6u];i+=64u){let j=pn_reverse(i,cfg[8u]);var v=vec2<f32>(0.0);if(j<length){v=vec2<f32>(pn_mul(src[base+j],window[j]),0.0);if(chirped){v=pn_complex(v,pn_coefficient(chirpBase,j));}}values[i]=pn_complex(vec2<f32>(1.0,0.0),v);}
  workgroupBarrier();pn_fft(lane);
  if(chirped){for(var i=lane;i<cfg[6u];i+=64u){let j=pn_reverse(i,cfg[8u]);temporary[i]=pn_complex(vec2<f32>(1.0,0.0),pn_complex(values[j],pn_coefficient(kernelBase,j)));}workgroupBarrier();for(var i=lane;i<cfg[6u];i+=64u){values[i]=temporary[i];}workgroupBarrier();pn_fft(lane);}
  for(var i=lane;i<cfg[5u];i+=64u){var result=values[i];if(chirped){let v=values[select(0u,cfg[6u]-i,i!=0u)];result=pn_complex(vec2<f32>(pn_div(v.x,f32(cfg[6u])),pn_div(v.y,f32(cfg[6u]))),pn_coefficient(chirpBase,i));}let at=(frame*cfg[5u]+i)*2u;dst[at]=result.x;dst[at+1u]=result.y;}
}
`;
