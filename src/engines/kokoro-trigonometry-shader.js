// SPDX-License-Identifier: MPL-2.0 OR GPL-3.0-or-later
// Copyright 2026 Felix Olsson.
// Eigen adaptations: Copyright (C) 2007 Julien Pommier
// Copyright (C) 2014 Pedro Gonnet (pedro.gonnet@gmail.com)
// Copyright (C) 2009-2019 Gael Guennebaud <gael.guennebaud@inria.fr>
// This Source Code Form is subject to the terms of the Mozilla
// Public License v. 2.0. If a copy of the MPL was not distributed
// with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Alternatively, this complete file, including PageNarrator's modifications,
// may be used under the GNU General Public License, version 3 or any later version.
// Eigen range reduction/polynomials; see extension/public/legal/THIRD_PARTY_NOTICES.txt.
// Use the same reduction for tails: hardware sin/cos can return zero for large finite angles.
export const KOKORO_TRIG_SHADER=`
fn pn_wide_mul(a:u32,b:u32)->vec2<u32>{let a0=a&65535u;let a1=a>>16u;let b0=b&65535u;let b1=b>>16u;let w0=a0*b0;let t=a1*b0+(w0>>16u);let w1=(t&65535u)+a0*b1;return vec2<u32>((w1<<16u)|(w0&65535u),a1*b1+(t>>16u)+(w1>>16u));}
fn pn_huge_reduce(value:f32)->vec2<f32>{
  let table=array<u32,26>(0x00000028u,0x000028beu,0x0028be60u,0x28be60dbu,0xbe60db93u,0x60db9391u,0xdb939105u,0x9391054au,0x91054a7fu,0x054a7f09u,0x4a7f09d5u,0x7f09d5f4u,0x09d5f47du,0xd5f47d4du,0xf47d4d37u,0x7d4d3770u,0x4d377036u,0x377036d8u,0x7036d8a5u,0x36d8a566u,0xd8a5664fu,0xa5664f10u,0x664f10e4u,0x4f10e410u,0x10e41000u,0xe4100000u);
  let bits=bitcast<u32>(value);let e=(bits>>23u)-118u;let xi=((bits&0x7fffffu)|0x800000u)<<(e&7u);let i=e>>3u;
  let last=pn_wide_mul(xi,table[i+7u]);let middle=pn_wide_mul(xi,table[i+3u]);var lo=middle.x+last.y;var hi=middle.y+u32(lo<middle.x)+xi*table[i-1u];let quadrant=(hi+0x20000000u)>>30u;hi-=quadrant<<30u;
  let negative=(hi&0x80000000u)!=0u;if(negative){lo=~lo+1u;hi=~hi+u32(lo==0u);}
  let top=pn_pair_add(vec2<f32>(f32(hi>>16u)*281474976710656.0,0.0),vec2<f32>(f32(hi&65535u)*4294967296.0,0.0));
  let low=pn_pair_add(vec2<f32>(f32(lo>>16u)*65536.0,0.0),vec2<f32>(f32(lo&65535u),0.0));
  let product=pn_pair_mul(pn_pair_add(top,low),vec2<f32>(3.4061215800865545e-19,-9.478396428567739e-27));let reduced=pn_add(product.x,product.y);
  return vec2<f32>(select(reduced,-reduced,negative),f32(quadrant));
}
fn pn_trig(value:f32,cosine:bool)->f32{
  let absolute=abs(value);if((bitcast<u32>(value)&0x7f800000u)==0x7f800000u){return value-value;}
  var quadrant=pn_sub(pn_add(pn_mul(absolute,0.636619746685028076171875),12582912.0),12582912.0);var x=absolute;
  x=pn_add(pn_mul(quadrant,-1.5703125),x);x=pn_add(pn_mul(quadrant,-0.000483989715576171875),x);x=pn_add(pn_mul(quadrant,1.62865035235881805419921875e-7),x);x=pn_add(pn_mul(quadrant,5.5644315544167710641e-11),x);
  if(absolute>=select(25966.0,18838.0,cosine)){let reduced=pn_huge_reduce(absolute);x=reduced.x;quadrant=reduced.y;}
  let q=u32(quadrant);let z=pn_mul(x,x);
  var c=pn_add(pn_mul(2.4372266125283204e-5,z),-0.001388652017340064);c=pn_add(pn_mul(c,z),0.04166661947965622);c=pn_add(pn_mul(c,z),-0.5);c=pn_add(pn_mul(c,z),1.0);
  var s=pn_add(pn_mul(-0.0001959234114083703,z),0.008332687365561685);s=pn_add(pn_mul(s,z),-0.16666662039822983);s=pn_add(pn_mul(pn_mul(s,z),x),x);
  let selected=select(select(s,c,cosine),select(c,s,cosine),(q&1u)!=0u);var sign=((q&2u)<<30u)^(bitcast<u32>(value)&0x80000000u);if(cosine){sign=((q+1u)&2u)<<30u;}return bitcast<f32>(bitcast<u32>(selected)^sign);
}
fn pn_atan(value:f32)->f32{
  let absolute=abs(value);let x=select(absolute,pn_div(1.0,absolute),absolute>1.0);let z=pn_mul(x,x);
  let p=pn_add(pn_mul(pn_add(pn_mul(0.112026982009410858154296875,z),0.7296695709228515625),z),0.8109951019287109375);
  let q=pn_add(pn_mul(pn_add(pn_mul(pn_add(pn_mul(0.0100917108356952667236328125,z),0.28318560123443603515625),z),1.0),z),0.8109951019287109375);
  let result=pn_mul(x,pn_div(p,q));let signed=select(result,pn_sub(1.57079632679489661923,result),absolute>1.0);return bitcast<f32>(bitcast<u32>(signed)^(bitcast<u32>(value)&0x80000000u));
}
`;
