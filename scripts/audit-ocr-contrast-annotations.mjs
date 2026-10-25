// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import sharp from'sharp';

const input=JSON.parse(await readFile('.cache/ocr-contrast-baseline/corpus.json','utf8'));
const prior=JSON.parse(await readFile('artifacts/engines/ocr-contrast-ab.json','utf8'));
const report={status:'annotation-correction-replay-only-no-fresh-acceptance',scope:'Original source pixels, text and model output unchanged. Only proved overlapping two-row glyph annotation rectangles are audited separately; original gold/report and reading-order failures remain preserved.',cases:[]};
for(const fixed of input.cases.filter(value=>value.name.startsWith('control-'))){
  const bytes=await readFile(fixed.path);if(createHash('sha256').update(bytes).digest('hex')!==fixed.sha256)throw new Error('Frozen source changed');
  const{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}),m=fixed.masks[0];
  const foreground=(x,y)=>{const p=(y*info.width+x)*4,gray=(data[p]*77+data[p+1]*150+data[p+2]*29)/256;return m.light?gray>m.threshold:gray<m.threshold;};
  const blankRows=[];
  // The authored SVG baselines are60 and92. Find only actual blank source rows
  // between them, independent of detector/model output or word-box predictions.
  for(let y=60;y<76;y++){let ink=false;for(let x=0;x<info.width&&!ink;x++)ink=foreground(x,y);if(!ink)blankRows.push(y);}
  const runs=[];for(const y of blankRows){const last=runs.at(-1);if(last&&last.at(-1)===y-1)last.push(y);else runs.push([y]);}
  const gap=runs.sort((a,b)=>b.length-a.length)[0];if(!gap?.length)throw new Error('No independent blank row gap');
  const boundary=gap[Math.floor(gap.length/2)],changedMasks=fixed.masks.map((mask,i)=>({...mask,rect:i<3?[mask.rect[0],mask.rect[1],mask.rect[2],boundary]:[mask.rect[0],boundary,mask.rect[2],mask.rect[3]]}));
  const row={name:fixed.name,sourceSha256:fixed.sha256,blankSourceRows:gap,boundary,originalExpectedText:fixed.expected,masks:[],outputs:[]};
  for(let i=0;i<changedMasks.length;i++){
    const old=fixed.masks[i],now=changedMasks[i];let ink=0;
    for(let y=now.rect[1];y<now.rect[3];y++)for(let x=now.rect[0];x<now.rect[2];x++)if(foreground(x,y))ink++;
    row.masks.push({word:now.word,oldRect:old.rect,oldInk:old.frozenInk.pixels,correctedRect:now.rect,correctedInk:ink});
  }
  for(const phase of['baseline','contrast']){
    const result=prior[phase].find(value=>value.name===fixed.name),scale=3*info.width/result.width,words=[];
    for(const mask of changedMasks){
      const cx=(mask.rect[0]+mask.rect[2])/2,cy=(mask.rect[1]+mask.rect[3])/2;
      const box=result.items.filter(item=>item.str===mask.word).map(item=>({left:item.transform[4]*scale,top:(item.transform[5]-item.height)*scale,right:(item.transform[4]+item.width)*scale,bottom:item.transform[5]*scale}))
        .sort((a,b)=>Math.hypot((a.left+a.right)/2-cx,(a.top+a.bottom)/2-cy)-Math.hypot((b.left+b.right)/2-cx,(b.top+b.bottom)/2-cy))[0];
      let ink=0,covered=0,otherCovered=0;
      for(let y=mask.rect[1];y<mask.rect[3];y++)for(let x=mask.rect[0];x<mask.rect[2];x++)if(foreground(x,y)){ink++;if(box&&x+.5>=box.left&&x+.5<box.right&&y+.5>=box.top&&y+.5<box.bottom)covered++;}
      for(const other of changedMasks.filter(value=>value!==mask))for(let y=other.rect[1];y<other.rect[3];y++)for(let x=other.rect[0];x<other.rect[2];x++)if(foreground(x,y)&&box&&x+.5>=box.left&&x+.5<box.right&&y+.5>=box.top&&y+.5<box.bottom)otherCovered++;
      words.push({word:mask.word,ink,covered,ratio:covered/ink,otherCovered});
    }
    row.outputs.push({phase,text:result.text,originalExpectedTextPass:result.expectedTextPass,words});
  }
  report.cases.push(row);
}
await writeFile('artifacts/engines/ocr-contrast-annotation-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.cases.map(c=>({name:c.name,blankSourceRows:c.blankSourceRows,masks:c.masks,outputs:c.outputs.map(v=>({phase:v.phase,failures:v.words.filter(w=>w.ratio<.9||w.otherCovered)}))})),null,2));
