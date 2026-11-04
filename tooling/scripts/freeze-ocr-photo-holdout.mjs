// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Extracts only original data/attribution from the pinned official release.
import{readFile,writeFile,mkdir,stat}from'node:fs/promises';
import{createWriteStream,createReadStream}from'node:fs';
import{createHash}from'node:crypto';
import{Readable}from'node:stream';
import{pipeline}from'node:stream/promises';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import sharp from'sharp';

const run=promisify(execFile),directory=process.env.PN_OCR_HOLDOUT_DIR||'.cache/ocr-implementation-holdout';
const base='https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0',archive=`${directory}/smartdoc-models.tar.gz`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const selection={createdAt:new Date().toISOString(),scope:'Implementation-held-out real camera capture only; no model-training disjointness claim and no inference before final policy freeze.',
  source:'https://github.com/jchazalon/smartdoc15-ch1-dataset',release:'v2.0.0',sourceCommit:'22367cef525c54db998c0f8515e0367a76c9d123',license:'CC-BY-4.0',
  attribution:'Burie, Chazalon, Coustaty, Eskenazi, Luqman, Mehri, Nayef, Ogier, Prum and Rusinol. ICDAR2015 Competition on Smartphone Document Capture and OCR (SmartDoc), ICDAR 2015.',
  ids:['letter001','paper001','magazine001'],selectionRule:'First numbered document from three text-bearing layout classes, fixed before capture/source/output inspection. No sample replacement based on OCR quality.',
  gold:'Exact camera image and matching original edited document image frozen now. Source transcription and visible glyph ownership to be manually reviewed and hashed before any OCR evaluation; not OCR-generated candidate gold.'};
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/photo-selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});
const response=await fetch(`${base}/sha256.chksum`);if(!response.ok)throw new Error('Missing upstream archive checksums');const checksums=await response.text();await writeFile(`${directory}/smartdoc-sha256.chksum`,checksums,{flag:'wx'});
try{await stat(archive);}catch(error){if(error.code!=='ENOENT')throw error;const source=await fetch(`${base}/models.tar.gz`);if(!source.ok)throw new Error(`Archive download ${source.status}`);await pipeline(Readable.fromWeb(source.body),createWriteStream(archive,{flags:'wx'}));}
const digest=createHash('sha256');for await(const bytes of createReadStream(archive))digest.update(bytes);const archiveSha256=digest.digest('hex');
const expected=checksums.split(/\r?\n/).find(line=>line.includes('models.tar.gz'))?.split(/\s+/)[0];if(archiveSha256!==expected)throw new Error('Official archive checksum mismatch');
const{stdout}=await run('tar',['-tzf',archive],{maxBuffer:2**20}),members=stdout.trim().split(/\r?\n/);
const cases=[],notices=[];
const extract=async(member,path)=>{if(member.split('/').includes('..'))throw new Error('Unsafe selected data member');const{stdout:bytes}=await run('tar',['-xOzf',archive,member],{encoding:'buffer',maxBuffer:64*2**20});await writeFile(`${directory}/${path}`,bytes,{flag:'wx'});return{path:`${directory}/${path}`,member,sha256:hash(bytes),bytes:bytes.length};};
for(const suffix of['LICENCE','README.md','original_datasets_files.txt']){const member=members.find(value=>value===suffix||value.endsWith(`/${suffix}`));if(!member)throw new Error(`Missing ${suffix}`);notices.push(await extract(member,`smartdoc-${suffix}`));}
for(const id of selection.ids){
  const photoMember=members.find(value=>value.endsWith(`03-captured-nexus/${id}.jpg`)),sourceMember=members.find(value=>value.endsWith(`02-edited/${id}.png`));
  if(!photoMember||!sourceMember)throw new Error(`Missing frozen pair ${id}`);
  const photo=await extract(photoMember,`smartdoc-${id}.jpg`),source=await extract(sourceMember,`smartdoc-${id}-source.png`),metadata=await sharp(photo.path).metadata();
  cases.push({name:`smartdoc-${id}`,kind:'real-camera-captured-paper',photo,source,width:metadata.width,height:metadata.height,goldStatus:'source-pair-frozen-awaiting-independent-transcription-before-inference'});
  console.log(JSON.stringify({id,photoBytes:photo.bytes,sourceBytes:source.bytes,width:metadata.width,height:metadata.height}));
}
const manifest={status:'image-source-pairs-frozen-not-evaluated-gold-pending',selectionSha256:hash(await readFile(`${directory}/photo-selection.json`)),archiveSha256,archiveUrl:`${base}/models.tar.gz`,notices,cases};
await writeFile(`${directory}/photos-manifest.json`,JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({directory,cases:cases.length,manifestSha256:hash(Buffer.from(JSON.stringify(manifest,null,2)))}));
