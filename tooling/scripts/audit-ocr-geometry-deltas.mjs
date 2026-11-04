// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import { readOcrSourceFile } from './lib/ocr-private-fixtures.mjs';

const sourceGeometry=process.argv.includes('--source-geometry');
const retainedInk=process.argv.includes('--retained-ink');
const edgeInk=process.argv.includes('--edge-ink');
const labelIndex=process.argv.indexOf('--report-label'),reportLabel=labelIndex<0?null:process.argv[labelIndex+1];
if(labelIndex>=0&&(!reportLabel||!/^[a-z0-9-]+$/.test(reportLabel)||!sourceGeometry))throw new Error('Invalid source-geometry report label.');
if(retainedInk&&!sourceGeometry)throw new Error('Retained-ink audit requires source-geometry mode.');
if(edgeInk&&!sourceGeometry)throw new Error('Edge-ink audit requires source-geometry mode.');
const suffix=sourceGeometry?`-source-geometry${reportLabel?`-${reportLabel}`:edgeInk?'-edge-ink':retainedInk?'-retained-ink':''}`:'';
const report=JSON.parse(await readFile(`artifacts/engines/ocr-paper-source-roi${suffix||'-production640'}.json`,'utf8'));
const escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const panels=[],records=[];
const box=(item,scale)=>({left:item.transform[4]*scale,top:(item.transform[5]-item.height)*scale,right:(item.transform[4]+item.width)*scale,bottom:item.transform[5]*scale});
const root=`artifacts/engines/ocr-geometry-review${suffix}`;await mkdir(root,{recursive:true});
for(let caseIndex=0;caseIndex<report.paper.length;caseIndex++){
  const current=report.paper[caseIndex],before=report.baseline[caseIndex];
  if(current.text!==before.text||current.items.length!==before.items.length)continue;
  const path=sourceGeometry?report.corpus.cases.find(c=>c.name===current.name)?.path:
    current.name.startsWith('docs/')?current.name:current.name==='curved-lines'?'tests/fixtures/ocr/curved-lines.png':current.name==='rating-matrix'?'tests/fixtures/ocr/rating-matrix.png':null;
  if(!path)continue;
  const original=await readOcrSourceFile(path),metadata=await sharp(original).metadata(),scale=3*metadata.width/current.width;
  for(let index=0;index<current.items.length;index++){
    const a=current.items[index],b=before.items[index];
    if(JSON.stringify(a)===JSON.stringify(b))continue;
    const old=box(b,scale),now=box(a,scale),left=Math.max(0,Math.floor(Math.min(old.left,now.left))-12),top=Math.max(0,Math.floor(Math.min(old.top,now.top))-8);
    const width=Math.min(metadata.width-left,Math.ceil(Math.max(old.right,now.right))-left+12),height=Math.min(metadata.height-top,Math.ceil(Math.max(old.bottom,now.bottom))-top+8);
    const factor=Math.min(3,216/width,76/height),outWidth=Math.max(1,Math.round(width*factor)),outHeight=Math.max(1,Math.round(height*factor));
    const rect=(v,color)=>`<rect x="${(v.left-left)*outWidth/width}" y="${(v.top-top)*outHeight/height}" width="${(v.right-v.left)*outWidth/width}" height="${(v.bottom-v.top)*outHeight/height}" fill="none" stroke="${color}" stroke-width="1"/>`;
    const crop=await sharp(original).extract({left,top,width,height}).resize(outWidth,outHeight).composite([{input:Buffer.from(`<svg width="${outWidth}" height="${outHeight}">${rect(old,'#ff4655')}${rect(now,'#44ff66')}</svg>`)}]).png().toBuffer();
    const number=records.length+1,context=current.items.slice(Math.max(0,index-1),index+2).map(v=>v.str).join(' ');
    const caption=Buffer.from(`<svg width="240" height="120"><rect width="240" height="120" fill="#20242c"/><text x="8" y="16" font-size="12" fill="white">${number}. ${escape(a.str)}</text><text x="8" y="116" font-size="10" fill="white">${escape(context).slice(0,90)}</text></svg>`);
    panels.push(await sharp(caption).composite([{input:crop,left:Math.round((240-outWidth)/2),top:22}]).png().toBuffer());
    records.push({number,name:current.name,index,text:a.str,context,old,now,originalSource:path,sourceCrop:{left,top,width,height}});
  }
}
for(let start=0;start<panels.length;start+=16){
  const path=`${root}/page-${start/16+1}.png`,slice=panels.slice(start,start+16);
  await sharp({create:{width:960,height:Math.ceil(slice.length/4)*120,channels:4,background:'#20242c'}}).composite(slice.map((input,i)=>({input,left:i%4*240,top:Math.floor(i/4)*120}))).png().toFile(path);
}
await writeFile(`${root}/manifest.json`,JSON.stringify({scope:'Offline original-source geometry delta overlays: old red, current green. Superset boxes are not by themselves verified word association.',records},null,2));
console.log(JSON.stringify({records:records.length,pages:Math.ceil(records.length/16),directory:root}));
