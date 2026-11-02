// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { MATMUL_SHADER } from './webgpu-shaders.js';
import { kokoroFloatShader } from './kokoro-float-shaders.js';

export const KOKORO_MATMUL_SHADER = kokoroFloatShader(5) + MATMUL_SHADER
  .replace('  for (var block = 0u;', '  var part00=0.0;var part01=0.0;var part10=0.0;var part11=0.0;\n  for (var block = 0u;')
  .replace('j < 16u;', 'j < min(16u,cfg[2u]-block);')
  .replace('sum00 += a0 * b0; sum01 += a0 * b1;', 'part00=fma(a0,b0,part00);part01=fma(a0,b1,part01);')
  .replace('sum10 += a1 * b0; sum11 += a1 * b1;', 'part10=fma(a1,b0,part10);part11=fma(a1,b1,part11);')
  .replace('    workgroupBarrier();\n  }', `    workgroupBarrier();
    if((block+16u)%256u==0u||block+16u>=cfg[2u]){
      sum00=select(pn_add(sum00,part00),part00,block<256u);sum01=select(pn_add(sum01,part01),part01,block<256u);
      sum10=select(pn_add(sum10,part10),part10,block<256u);sum11=select(pn_add(sum11,part11),part11,block<256u);
      part00=0.0;part01=0.0;part10=0.0;part11=0.0;
    }
  }`);
