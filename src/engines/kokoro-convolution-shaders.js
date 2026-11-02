import{KOKORO_TRIG_SHADER}from'./kokoro-trigonometry-shader.js';
import{SNAKE_SHADER}from'./webgpu-audio-shaders.js';
// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { CONV_1D_SHADER,ZERO_INSERT_CONV_1D_SHADER,ZERO_TAIL_CONV_1D_SHADER,CONV_TRANSPOSE_1D_SHADER } from './webgpu-audio-shaders.js';
import { CONV_DIRECT_SHADER } from './webgpu-cnn-shaders.js';
import { kokoroFloatShader } from './kokoro-float-shaders.js';
const arithmetic=kokoroFloatShader(24)+`
fn pn_add4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return bitcast<vec4<f32>>(bitcast<vec4<u32>>(a+b)^vec4<u32>(cfg[24u]));}
fn pn_mul4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return bitcast<vec4<f32>>(bitcast<vec4<u32>>(a*b)^vec4<u32>(cfg[24u]));}
fn pn_projection_block(n:u32,k:u32)->u32{var block=128u;var panel=128u;if(n>=k){while(block/2u>=k){block/=2u;}}else{while(panel>16u&&panel/2u>=n){block*=2u;panel/=2u;}}return block;}
`;
function forward(code){return arithmetic+code
  .replace('  var sums: array<vec4<f32>, 4>;', '  var sums:array<vec4<f32>,4>;var parts:array<vec4<f32>,4>;let strideK=pn_projection_block(cfg[6u],kSize);')
  .replace(`    for (var j = 0u; j < 32u; j += 1u) {
      let base = j * 32u + local.x * 4u;
      let x = vec4<f32>(tileX[base], tileX[base + 1u], tileX[base + 2u], tileX[base + 3u]);
      for (var row = 0u; row < 4u; row += 1u) { sums[row] += tileW[(local.y * 4u + row) * 32u + j] * x; }
    }
    workgroupBarrier();`, `    if(cfg[8u]==1u&&cfg[10u]==1u){
      for(var j=0u;j<min(32u,kSize-block);){let remaining=min(32u,kSize-block)-j;let chunk=select(select(1u,2u,remaining>=2u),4u,remaining>=4u);
        for(var row=0u;row<4u;row+=1u){var part=vec4<f32>(0.0);for(var k=0u;k<chunk;k+=1u){let base=(j+k)*32u+local.x*4u;let x=vec4<f32>(tileX[base],tileX[base+1u],tileX[base+2u],tileX[base+3u]);let value=pn_mul4(vec4<f32>(tileW[(local.y*4u+row)*32u+j+k]),x);part=select(pn_add4(part,value),value,k==0u);}sums[row]=pn_add4(part,sums[row]);}j+=chunk;}
    }else{
      for(var j=0u;j<min(32u,kSize-block);j+=1u){let base=j*32u+local.x*4u;let x=vec4<f32>(tileX[base],tileX[base+1u],tileX[base+2u],tileX[base+3u]);for(var row=0u;row<4u;row+=1u){parts[row]=fma(vec4<f32>(tileW[(local.y*4u+row)*32u+j]),x,parts[row]);}}
      if((block+32u)%strideK==0u||block+32u>=kSize){for(var row=0u;row<4u;row+=1u){sums[row]=select(pn_add4(sums[row],parts[row]),parts[row],block<strideK);parts[row]=vec4<f32>(0.0);}}
    }
    workgroupBarrier();`)
  .replace('var value = sums[row][column] + b;', 'var value=sums[row][column];if(cfg[17u]!=0u){value=pn_add(value,b);}');}
export const KOKORO_CONV_1D_SHADER=forward(CONV_1D_SHADER);
export const KOKORO_ZERO_INSERT_CONV_1D_SHADER=forward(ZERO_INSERT_CONV_1D_SHADER);
export const KOKORO_ZERO_TAIL_CONV_1D_SHADER=forward(ZERO_TAIL_CONV_1D_SHADER);
export const KOKORO_CONV_DIRECT_SHADER=arithmetic+CONV_DIRECT_SHADER
  .replace('sum += src[xi] * weight[wi];','sum=pn_add(sum,pn_mul(src[xi],weight[wi]));')
  .replace('sum += bias[oc];','sum=pn_add(sum,bias[oc]);');
export const KOKORO_CONV_TRANSPOSE_1D_SHADER=arithmetic+CONV_TRANSPOSE_1D_SHADER
  .replace('let kSize = cfg[7u] * taps;', 'let kSize=cfg[7u];let strideK=pn_projection_block(cfg[3u],kSize);')
  .replace('  for (var block = 0u;', '  for(var tap=0u;tap<taps;tap+=1u){var d00=0.0;var d01=0.0;var d10=0.0;var d11=0.0;var p00=0.0;var p01=0.0;var p10=0.0;var p11=0.0;\n  for (var block = 0u;')
  .replace('wk / taps','wk').replace('firstTap + (wk % taps) * stride','firstTap+tap*stride')
  .replace('i32(xk % taps)','i32(tap)').replace('xk / taps','xk')
  .replace('j < 16u;', 'j < min(16u,kSize-block);')
  .replace('s00 += w0 * x0; s01 += w0 * x1; s10 += w1 * x0; s11 += w1 * x1;', 'p00=fma(w0,x0,p00);p01=fma(w0,x1,p01);p10=fma(w1,x0,p10);p11=fma(w1,x1,p11);')
  .replace('    workgroupBarrier();\n  }', `    workgroupBarrier();
    if((block+16u)%strideK==0u||block+16u>=kSize){d00=select(pn_add(d00,p00),p00,block<strideK);d01=select(pn_add(d01,p01),p01,block<strideK);d10=select(pn_add(d10,p10),p10,block<strideK);d11=select(pn_add(d11,p11),p11,block<strideK);p00=0.0;p01=0.0;p10=0.0;p11=0.0;}
  }
  s00=pn_add(s00,d00);s01=pn_add(s01,d01);s10=pn_add(s10,d10);s11=pn_add(s11,d11);
  }`)
  .replace('var v0 = select(s00, s10, row == 1u) + b; var v1 = select(s01, s11, row == 1u) + b;', 'var v0=select(s00,s10,row==1u);var v1=select(s01,s11,row==1u);if(cfg[17u]!=0u){v0=pn_add(v0,b);v1=pn_add(v1,b);}');

export const KOKORO_SNAKE_SHADER=kokoroFloatShader(3)+KOKORO_TRIG_SHADER+SNAKE_SHADER.replace('let x = src[xi]; let wave = sin(alpha[ai] * x);','let x=src[xi];let argument=pn_mul(alpha[ai],x);let wave=pn_trig(argument,false);').replace('dst[index] = x + scale[si] * (wave * wave);','dst[index]=pn_add(x,pn_mul(scale[si],pn_mul(wave,wave)));');
