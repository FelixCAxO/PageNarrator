// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Frozen development source pixels only; never use OCR output to rewrite gold.
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import sharp from'sharp';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const labelIndex=process.argv.indexOf('--report-label'),reportLabel=labelIndex<0?null:process.argv[labelIndex+1];
if(labelIndex>=0&&(!reportLabel||!/^[a-z0-9-]+$/.test(reportLabel)))throw new Error('Invalid source-geometry report label.');
const retained=process.argv.includes('--retained-ink'),edge=process.argv.includes('--edge-ink'),suffix=reportLabel?`-${reportLabel}`:edge?'-edge-ink':retained?'-retained-ink':'';
const path=`artifacts/engines/ocr-paper-source-roi-source-geometry${suffix}.json`,bytes=await readFile(path),report=JSON.parse(bytes);
const corpusBytes=await readFile('.cache/ocr-contrast-baseline/corpus.json'),corpus=JSON.parse(corpusBytes);
const counterBytes=await readFile('artifacts/engines/ocr-source-geometry-ownership.json'),counter=JSON.parse(counterBytes);
const output={scope:'Fixed development original-source glyph ownership and every raw text delta. These masks do not establish ownership of unannotated words; full delta visual review remains separate.',
  candidateReportSha256:hash(bytes),corpusSha256:hash(corpusBytes),counterexampleSha256:hash(counterBytes),sourceMasks:[],counterexamples:[],textDifferences:[],failures:[]};
const asBox=(item,scale)=>({left:item.transform[4]*scale,top:(item.transform[5]-item.height)*scale,right:(item.transform[4]+item.width)*scale,bottom:item.transform[5]*scale});
function count(image,rect,threshold,light,box){
  let ink=0,covered=0;const mask=[];
  for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++){
    const p=(y*image.width+x)*4,gray=(image.data[p]*77+image.data[p+1]*150+image.data[p+2]*29)/256;
    const foreground=light?gray>threshold:gray<threshold;mask.push(Number(foreground));if(!foreground)continue;ink++;
    if(x+.5>=box.left&&x+.5<box.right&&y+.5>=box.top&&y+.5<box.bottom)covered++;
  }
  return{ink,covered,ratio:covered/Math.max(1,ink),maskSha256:hash(Uint8Array.from(mask))};
}
for(const fixed of corpus.cases.filter(c=>!c.name.startsWith('control-'))){
  const entry=report.paper.find(c=>c.name===fixed.name);if(!entry)throw new Error('Missing fixed source case');
  const original=await readFile(`.cache/ocr-contrast-baseline/original-${fixed.originalSource.split('/').at(-1)}`);
  if(hash(original)!==fixed.originalSha256)throw new Error('Frozen original image changed');
  const{data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true}),image={data,width:info.width},scale=3*info.width/entry.width;
  const masks=[...fixed.masks];
  if(fixed.name.endsWith('screenshot-04-toolbar-player-pdf.png'))masks.push({word:'·',rect:[852,320,856,334],other:[859,320,864,334],threshold:80,light:true,frozenInk:{pixels:2}});
  for(const gold of masks){
    const cx=(gold.rect[0]+gold.rect[2])/2,cy=(gold.rect[1]+gold.rect[3])/2;
    const candidates=entry.items.filter(item=>item.str===gold.word).map(item=>asBox(item,scale));
    candidates.sort((a,b)=>Math.hypot((a.left+a.right)/2-cx,(a.top+a.bottom)/2-cy)-Math.hypot((b.left+b.right)/2-cx,(b.top+b.bottom)/2-cy));
    const box=candidates[0];if(!box)throw new Error('Frozen source word missing');
    const actual=count(image,gold.rect,gold.threshold,gold.light,box);
    if(actual.ink!==gold.frozenInk.pixels||gold.frozenInk.sha256&&actual.maskSha256!==gold.frozenInk.sha256)throw new Error('Frozen source glyph mask changed');
    const otherCovered=gold.other?count(image,gold.other,gold.threshold,gold.light,box).covered:0;
    output.sourceMasks.push({name:fixed.name,word:gold.word,box,...actual,otherCovered});
    if(actual.ratio<1||otherCovered)output.failures.push(`${fixed.name}: ${gold.word} owned glyphs or neighbor exclusion failed`);
  }
}
for(const gold of counter.records){
  const entry=report.paper.find(c=>c.name===gold.name),item=entry?.items[gold.index];
  if(item?.str!==gold.text)throw new Error('Counterexample text/index changed');
  const original=await readFile(gold.originalSource);if(hash(original)!==gold.sourceSha256)throw new Error('Counterexample source changed');
  const{data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const box=asBox(item,3*info.width/entry.width),actual=count({data,width:info.width},gold.rect,gold.threshold,gold.light,box);
  if(actual.ink!==gold.ink||actual.maskSha256!==gold.maskSha256)throw new Error('Counterexample glyph mask changed');
  output.counterexamples.push({number:gold.number,name:gold.name,word:gold.text,box,...actual});
  if(actual.ratio<1)output.failures.push(`${gold.name}: ${gold.text} counterexample glyphs clipped`);
}
if(edge){
  const edgeBytes=await readFile('artifacts/engines/ocr-source-geometry-edge-gold.json'),gold=JSON.parse(edgeBytes);
  output.edgeGoldSha256=hash(edgeBytes);output.edgeCounterexamples=[];
  for(const fixed of gold.gold){
    const entry=report.paper.find(c=>c.name===fixed.name),item=entry?.items[fixed.index];
    if(item?.str!==fixed.word)throw new Error('Edge counterexample association changed');
    const original=await readFile(fixed.path);if(hash(original)!==fixed.sourceSha256)throw new Error('Edge source changed');
    const{data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const box=asBox(item,3*info.width/entry.width),actual=count({data,width:info.width},fixed.rect,fixed.threshold,fixed.light,box);
    if(actual.ink!==fixed.ink||actual.maskSha256!==fixed.maskSha256)throw new Error('Edge glyph mask changed');
    output.edgeCounterexamples.push({name:fixed.name,word:fixed.word,box,...actual});
    if(actual.ratio<1)output.failures.push(`${fixed.name}: ${fixed.word} edge glyphs clipped`);
  }
}
for(let i=0;i<report.paper.length;i++)if(report.paper[i].text!==report.baseline[i].text)output.textDifferences.push({name:report.paper[i].name,before:report.baseline[i].text,after:report.paper[i].text});
if(output.textDifferences.length)output.failures.push('Raw fixed input text changed');
output.status=output.failures.length?'FAIL-development-source-ownership':'PASS-frozen-development-masks-only';
await writeFile(`artifacts/engines/ocr-source-geometry-mask-audit${suffix}.json`,JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
if(output.failures.length)process.exitCode=1;
