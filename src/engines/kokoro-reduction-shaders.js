// SPDX-License-Identifier: MPL-2.0 OR GPL-3.0-or-later
// Copyright 2026 Felix Olsson.
// Eigen reduction adaptations: Copyright (C) 2008 Gael Guennebaud <gael.guennebaud@inria.fr>
// Copyright (C) 2006-2008 Benoit Jacob <jacob.benoit.1@gmail.com>
// This Source Code Form is subject to the terms of the Mozilla
// Public License v. 2.0. If a copy of the MPL was not distributed
// with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Alternatively, this complete file, including PageNarrator's modifications,
// may be used under the GNU General Public License, version 3 or any later version.
// Eigen packet reduction order; see extension/public/legal/THIRD_PARTY_NOTICES.txt.
import{kokoroFloatShader}from'./kokoro-float-shaders.js';
export const KOKORO_REDUCE_SHADER=`
${kokoroFloatShader(7)}
@group(0) @binding(0) var<storage,read> src:array<f32>;
@group(0) @binding(1) var<storage,read_write> dst:array<f32>;
@group(0) @binding(2) var<storage,read> cfg:array<u32>;
var<workgroup> partial:array<f32,4>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let row=group.x+group.y*cfg[4u];if(row>=cfg[0u]){return;}let count=cfg[1u];
  if(cfg[6u]!=0u&&cfg[5u]!=1u&&count>=4u){
    let base=row*count;let first=min(count,(4u-base%4u)%4u);let packed=(count-first)/4u*4u;let end=first+packed;let paired=first+(count-first)/8u*8u;
    if(packed>0u){
      if(lane<4u){var a=src[base+first+lane];if(packed>4u){var b=src[base+first+4u+lane];for(var i=first+8u;i<paired;i+=8u){a=pn_add(a,src[base+i+lane]);b=pn_add(b,src[base+i+lane+4u]);}a=pn_add(a,b);if(end>paired){a=pn_add(a,src[base+paired+lane]);}}partial[lane]=a;}
      workgroupBarrier();
      if(lane==0u){var sum=pn_add(pn_add(partial[0u],partial[2u]),pn_add(partial[1u],partial[3u]));for(var i=0u;i<first;i+=1u){sum=pn_add(sum,src[base+i]);}for(var i=end;i<count;i+=1u){sum=pn_add(sum,src[base+i]);}dst[row]=select(sum,pn_div(sum,f32(count)),cfg[5u]==0u);}return;
    }
  }
  if(lane!=0u){return;}
  var offset=0u;var remaining=row;var stride=1u;
  for(var axis=i32(cfg[2u])-1;axis>=0;axis-=1){let dim=cfg[8u+u32(axis)];if((cfg[3u]&(1u<<u32(axis)))==0u){offset+=(remaining%dim)*stride;remaining/=dim;}stride*=dim;}
  var sum=0.0;
  for(var r=0u;r<count;r+=1u){var at=offset;var value=r;var step=1u;for(var axis=i32(cfg[2u])-1;axis>=0;axis-=1){let dim=cfg[8u+u32(axis)];if((cfg[3u]&(1u<<u32(axis)))!=0u){at+=(value%dim)*step;value/=dim;}step*=dim;}if(cfg[5u]==1u){sum=select(max(sum,src[at]),src[at],r==0u);}else{sum=pn_add(sum,src[at]);}}
  dst[row]=select(sum,pn_div(sum,f32(count)),cfg[5u]==0u);
}
`;
export const KOKORO_SERIAL_SCAN_SHADER=`
${kokoroFloatShader(5)}
@group(0) @binding(0) var<storage,read> src:array<f32>;
@group(0) @binding(1) var<storage,read_write> dst:array<f32>;
@group(0) @binding(2) var<storage,read> cfg:array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) position:vec3<u32>){let lane=position.x+position.y*cfg[4u]*64u;if(lane>=cfg[3u]){return;}var sum=0.0;for(var i=0u;i<cfg[0u];i+=1u){let at=((lane/cfg[1u])*cfg[0u]+i)*cfg[1u]+lane%cfg[1u];sum=pn_add(sum,src[at]);dst[at]=sum;}}
`;
