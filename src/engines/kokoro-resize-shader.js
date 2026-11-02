// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{kokoroFloatShader}from'./kokoro-float-shaders.js';
export const KOKORO_RESIZE_SHADER=`
${kokoroFloatShader(9)}
@group(0) @binding(0) var<storage,read> src:array<f32>;
@group(0) @binding(1) var<storage,read_write> dst:array<f32>;
@group(0) @binding(2) var<storage,read> cfg:array<u32>;
fn pn_coordinate(x:u32)->f32{
  let scale=bitcast<f32>(cfg[4u]);if(cfg[5u]==1u){if(cfg[3u]==1u){return 0.0;}return pn_div(pn_mul(f32(x),f32(cfg[2u]-1u)),f32(cfg[3u]-1u));}
  if(cfg[5u]==2u){return pn_div(f32(x),scale);}if(cfg[5u]==3u&&cfg[3u]==1u){return 0.0;}return pn_sub(pn_div(pn_add(f32(x),0.5),scale),0.5);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position:vec3<u32>){
  let index=position.x+position.y*cfg[8u]*64u;if(index>=cfg[0u]*cfg[1u]*cfg[3u]){return;}let x=index%cfg[3u];let c=(index/cfg[3u])%cfg[1u];let n=index/(cfg[1u]*cfg[3u]);let raw=pn_coordinate(x);
  if(cfg[7u]==0u){let low=floor(raw);var source=low;let fraction=pn_sub(raw,low);if((cfg[6u]==0u&&fraction>0.5)||(cfg[6u]==1u&&fraction>=0.5)){source=pn_add(source,1.0);}if(cfg[6u]==3u){source=ceil(raw);}dst[index]=src[(n*cfg[1u]+c)*cfg[2u]+u32(clamp(source,0.0,f32(cfg[2u]-1u)))];return;}
  let t=clamp(raw,0.0,f32(cfg[2u]-1u));let left=u32(t);let right=min(left+1u,cfg[2u]-1u);let nextC=min(c+1u,cfg[1u]-1u);let nextN=min(n+1u,cfg[0u]-1u);
  let low=array<u32,3>(left,c,n);let high=array<u32,3>(right,nextC,nextN);let sizes=array<u32,3>(cfg[2u],cfg[1u],cfg[0u]);
  let lower=array<f32,3>(select(pn_sub(f32(right),t),0.5,left==right),select(1.0,0.5,c==nextC),select(1.0,0.5,n==nextN));
  let upper=array<f32,3>(select(pn_sub(t,f32(left)),0.5,left==right),select(0.0,0.5,c==nextC),select(0.0,0.5,n==nextN));
  var sum=0.0;for(var corner=0u;corner<8u;corner+=1u){var weight=1.0;var at=0u;var stride=1u;for(var axis=0u;axis<3u;axis+=1u){let next=((corner>>axis)&1u)!=0u;weight=pn_mul(weight,select(lower[axis],upper[axis],next));at+=select(low[axis],high[axis],next)*stride;stride*=sizes[axis];}sum=pn_add(sum,pn_mul(src[at],weight));}dst[index]=sum;
}
`;
