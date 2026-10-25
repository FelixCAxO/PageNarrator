// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Downloads data only. Never runs OCR or changes runtime/model files.
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{createHash}from'node:crypto';
import sharp from'sharp';

const directory=process.env.PN_OCR_HOLDOUT_DIR||'.cache/ocr-implementation-holdout';
const commit='9a0378e1188741ac6061d51adac5a9eef1c59d20';
const base=`https://raw.githubusercontent.com/PedroBarcha/old-books-dataset/${commit}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const selection={createdAt:new Date().toISOString(),scope:'Implementation-held-out only; no claim of model-training disjointness. Selected before new OCR runtime edits; no inference permitted until candidate policy/source pinned.',
  source:'https://github.com/PedroBarcha/old-books-dataset',commit,license:'GPL-3.0',
  selectionRule:'Fixed first six book groups, one published prose page per group, chosen from file listing before image/output inspection; exact IDs frozen here. No candidate-quality filtering or replacement.',
  ids:['a013','b013','c016','d015','e009','f012'],
  metrics:{primary:'Per-image raw output, word error rate with existing tests/helpers/ocr-word-error-rate.js tokenizer, aggregate and worst page; page number/header differences remain visible.',
    geometry:'Finite in-source coordinates plus independently annotated source-glyph ownership anchors, reviewed before inference.',
    regression:'Report all own-vs-legacy oracle deltas; never change gold or route samples after seeing candidate results.'}};
await mkdir(directory,{recursive:true});
try{await writeFile(`${directory}/selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const old=JSON.parse(await readFile(`${directory}/selection.json`,'utf8'));if(JSON.stringify(old.ids)!==JSON.stringify(selection.ids)||old.commit!==commit)throw new Error('Existing selection differs');}
const fetchFile=async(url,path)=>{try{return await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;const response=await fetch(url);if(!response.ok)throw new Error(`${response.status}:${url}`);const bytes=Buffer.from(await response.arrayBuffer());await writeFile(path,bytes,{flag:'wx'});return bytes;}};
const notices=[];for(const file of['LICENSE','README.md']){const bytes=await fetchFile(`${base}/${file}`,`${directory}/old-books-${file}`);notices.push({path:`old-books-${file}`,url:`${base}/${file}`,sha256:hash(bytes),bytes:bytes.length});}
const cases=[];
for(const id of selection.ids){
  const originalPath=`${directory}/${id}.tiff`,imagePath=`${directory}/${id}.png`,goldPath=`${directory}/${id}.txt`;
  const imageUrl=`${base}/300dpi/tiff/${id}.tiff`,goldUrl=`${base}/groundtruth/${id}.txt`;
  const original=await fetchFile(imageUrl,originalPath),gold=await fetchFile(goldUrl,goldPath);
  let image;try{image=await readFile(imagePath);}catch(error){if(error.code!=='ENOENT')throw error;image=await sharp(original).png().toBuffer();await writeFile(imagePath,image,{flag:'wx'});}
  const metadata=await sharp(image).metadata();
  cases.push({name:`old-books-${id}`,kind:'real-historical-scan',originalPath,imagePath,goldPath,imageUrl,goldUrl,originalSha256:hash(original),imageSha256:hash(image),goldSha256:hash(gold),originalBytes:original.length,imageBytes:image.length,goldBytes:gold.length,width:metadata.width,height:metadata.height,
    conversion:'TIFF decoded to lossless PNG for browser; no resizing/cropping/color/quality tuning; original bytes retained.',gold:'Published ground truth unchanged; must review source alignment before inference and record any annotation defects separately.'});
  console.log(JSON.stringify({name:id,width:metadata.width,height:metadata.height,originalBytes:original.length,pngBytes:image.length,goldSha256:hash(gold)}));
}
const scoreBytes=await readFile('tests/helpers/ocr-word-error-rate.js');
const manifest={status:'frozen-not-evaluated',scope:selection.scope,selectionSha256:hash(await readFile(`${directory}/selection.json`)),scoreHelperSha256:hash(scoreBytes),notices,cases};
await writeFile(`${directory}/scans-manifest.json`,JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({directory,cases:cases.length,manifestSha256:hash(Buffer.from(JSON.stringify(manifest,null,2)))}));
