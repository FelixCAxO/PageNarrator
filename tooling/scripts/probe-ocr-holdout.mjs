// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Private external implementation holdout. Never copies its image/gold bytes into the product.
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{resolve}from'node:path';
import sharp from'sharp';
import{createCpuOcrBrowser}from'./ocr-cpu-browser.mjs';
import{scoreOcrHoldout,holdoutWordsFromPdf,textInOcrHoldoutRegion}from'./lib/ocr-holdout-score.mjs';
import{ocrResourceFailures}from'./lib/ocr-resource-gates.mjs';
import{pinOcrCandidateSources,readOcrDevelopmentGate}from'./lib/ocr-development-gate.mjs';
import{readOcrHoldoutManifests}from'./lib/ocr-holdout-manifests.mjs';
import{scoreOcrHoldoutScan}from'./lib/ocr-holdout-scan-scope.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const directory=option('--directory')||process.env.PN_OCR_HOLDOUT_DIR;
if(!directory)throw new Error('Specify --directory or PN_OCR_HOLDOUT_DIR for the private frozen corpus.');
const root=resolve(directory),backend=option('--backend')||'cpu';
if(!['cpu','nvidia','intel','legacy'].includes(backend))throw new Error('Unknown holdout backend.');
const regressionLabel=option('--regression-label');
if(process.argv.includes('--regression-label')&&(!regressionLabel||!/^[a-z0-9-]+$/.test(regressionLabel)))throw new Error('Invalid development regression label.');
let firstEvaluation;
if(regressionLabel){
  const summary=JSON.parse(await readFile(resolve(root,'evaluation-summary.json')));
  if(summary.status!=='FAIL-preregistered-implementation-holdout'||Object.values(summary.reports).some(r=>!r.closed||r.cases!==9))throw new Error('Regression mode requires the preserved completed failed first evaluation.');
  firstEvaluation=JSON.parse(await readFile(resolve(root,`evaluation-${backend}.json`)));
}
const{files,manifests,acceptance,reserve,goldFile}=await readOcrHoldoutManifests(root);
if(reserve&&regressionLabel)throw new Error('Reserve evaluation cannot be relabeled as the consumed first9 regression.');
const inputs=[];
for(const fixed of manifests['scans-manifest.json'].data.cases){
  const [image,gold]=await Promise.all([readFile(fixed.imagePath),readFile(fixed.goldPath)]);
  if(hash(image)!==fixed.imageSha256||hash(gold)!==fixed.goldSha256)throw new Error('Frozen scan/gold changed.');
  inputs.push({name:fixed.name,path:fixed.imagePath,sha256:fixed.imageSha256,width:fixed.width,height:fixed.height,
    reference:gold.toString('utf8'),textScope:acceptance.scanTextScopes?.find(scope=>scope.name===fixed.name)});
}
for(const fixed of manifests['photos-manifest.json'].data.cases){
  const image=await readFile(fixed.photo.path),gold=manifests[goldFile].data.cases.find(c=>c.name===fixed.name);
  if(hash(image)!==fixed.photo.sha256||gold?.photoSha256!==fixed.photo.sha256)throw new Error('Frozen photo/gold changed.');
  const{data,info}=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const neighbors=acceptance.geometry.photoNeighborMasks.filter(mask=>mask.name===fixed.name&&mask.maskSha256);
  for(const anchor of[...gold.anchors,...neighbors]){let ink=0;const mask=[];
    for(let y=anchor.pixelRect[1];y<anchor.pixelRect[3];y++)for(let x=anchor.pixelRect[0];x<anchor.pixelRect[2];x++){
      const p=(y*info.width+x)*4,gray=(data[p]*77+data[p+1]*150+data[p+2]*29)/256;
      const value=anchor.light?gray>anchor.threshold:gray<anchor.threshold;mask.push(Number(value));ink+=Number(value);
    }
    if(ink!==anchor.foregroundPixels||hash(Uint8Array.from(mask))!==anchor.maskSha256)throw new Error('Frozen pre-evaluation photo glyph mask changed.');
  }
  inputs.push({name:fixed.name,path:fixed.photo.path,sha256:fixed.photo.sha256,width:fixed.width,height:fixed.height,photoGold:gold});
}
for(const[path,pin]of Object.entries(manifests['legacy-oracle-pins.json'].data.pins)){
  const bytes=await readFile(path);if(bytes.length!==pin.bytes||hash(bytes)!==pin.sha256)throw new Error(`Pinned legacy oracle changed: ${path}`);
}
if(inputs.length!==9)throw new Error('The frozen nine-input corpus changed.');
if(process.argv.includes('--prepare')){console.log(JSON.stringify({status:regressionLabel?'prepared-previously-consumed-development-regression-not-run':'prepared-not-evaluated',inputs:inputs.map(({name,sha256,width,height})=>({name,sha256,width,height})),manifests:Object.fromEntries(files.map(file=>[file,manifests[file].sha256]))}));process.exit(0);}
const developmentGatePath=option('--development-gate')||process.env.PN_OCR_DEVELOPMENT_GATE;
if(!developmentGatePath)throw new Error('Specify the frozen current --development-gate before evaluation.');
const pins=await pinOcrCandidateSources(),developmentGate=await readOcrDevelopmentGate(developmentGatePath,pins);
const freezePath=resolve(root,regressionLabel?`regression-${regressionLabel}-source-pins.json`:'candidate-source-pins.json');
try{const existing=JSON.parse(await readFile(freezePath));if(JSON.stringify(existing)!==JSON.stringify(pins))throw new Error('Frozen common runtime candidate changed after holdout preparation.');}
catch(error){if(error.code!=='ENOENT')throw error;await writeFile(freezePath,JSON.stringify(pins),{flag:'wx'});}
const output=resolve(root,regressionLabel?`regression-${regressionLabel}-${backend}.json`:`evaluation-${backend}.json`),report={status:'incomplete',scope:regressionLabel?'Previously consumed first9 development regression under its unchanged original gold/scoring/absolute/ownership gates; never a fresh holdout or release acceptance.':acceptance.scope,backend,sourcePins:pins,developmentGate,
  ...(regressionLabel?{regressionLabel,firstEvaluationSha256:hash(await readFile(resolve(root,`evaluation-${backend}.json`)))}:{}),
  manifests:Object.fromEntries(files.map(file=>[file,manifests[file].sha256])),timingScope:'Serial actual original-image pipeline, one fresh reader/worker per page; allocation observation adds overhead. Not weak-device or process-memory acceptance.',cases:[],failures:[]};
const save=()=>writeFile(output,JSON.stringify(report,null,2));
try{await readFile(output);throw new Error('Existing holdout evaluation is preserved; choose no replacement outputs.');}catch(error){if(error.code!=='ENOENT')throw error;}
const checkPins=async()=>{
  if(JSON.stringify(await pinOcrCandidateSources())!==JSON.stringify(pins))throw new Error('Common holdout candidate mutated during evaluation.');
  const current=await readOcrDevelopmentGate(developmentGatePath,pins);
  if(current.sha256!==developmentGate.sha256)throw new Error('Accepted development gate mutated during evaluation.');
};
let browser,worker;
try{
  if(backend==='legacy'){
    const{createWorker}=await import('tesseract.js'),features=await import('wasm-feature-detect');
    report.oracleVariant=await features.relaxedSimd()?'relaxedsimd':await features.simd()?'simd':'scalar';
    const started=performance.now();worker=await createWorker('eng',1,{langPath:resolve('node_modules/@tesseract.js-data/eng/4.0.0'),cacheMethod:'none',gzip:true});
    await worker.setParameters({tessedit_pageseg_mode:'3'});report.oracleSetupMs=performance.now()-started;
  }else browser=await createCpuOcrBrowser({candidate:'verified-retained',backend:backend==='cpu'?'cpu':'webgpu',observe:true,expectedVendor:backend==='cpu'?null:backend});
  for(const fixed of inputs){
    await checkPins();const bytes=await readFile(fixed.path);if(hash(bytes)!==fixed.sha256)throw new Error('Protected holdout input changed');
    try{
    let entry,words;
    if(worker){const started=performance.now(),result=await worker.recognize(bytes,{},{text:true,blocks:true});
      words=(result.data.blocks||[]).flatMap(b=>b.paragraphs||[]).flatMap(p=>p.lines||[]).flatMap(l=>l.words||[]).map(w=>({text:w.text,bbox:w.bbox}));
      if(!words.length&&result.data.text.trim())throw new Error('Legacy oracle produced text without requested word layout');
      entry={name:fixed.name,inputSha256:fixed.sha256,width:fixed.width,height:fixed.height,text:result.data.text,elapsedMs:performance.now()-started,words};
    }else{entry={name:fixed.name,inputSha256:fixed.sha256,...await browser.recognizePdfSource(bytes)};words=holdoutWordsFromPdf(entry);
      for(const failure of ocrResourceFailures(entry,backend==='cpu'?'wasm':'webgpu'))report.failures.push(`${fixed.name}: ${failure}`);
    }
    entry.invalidGeometry=words.filter(w=>!Object.values(w.bbox).every(Number.isFinite)||w.bbox.x0< -1e-6||w.bbox.y0< -1e-6
      ||w.bbox.x1>fixed.width+1e-6||w.bbox.y1>fixed.height+1e-6||w.bbox.x1<=w.bbox.x0||w.bbox.y1<=w.bbox.y0).length;
    if(entry.invalidGeometry)report.failures.push(`${fixed.name}: invalid original-source boxes`);
    if(fixed.photoGold)entry.scores=fixed.photoGold.regions.map(region=>{const text=textInOcrHoldoutRegion(words,region,fixed.width,fixed.height);return{reference:region.text,recognized:text,...scoreOcrHoldout(region.text,text)};});
    else{
      Object.assign(entry,scoreOcrHoldoutScan(fixed.reference,entry.text,words,fixed.width,fixed.height,fixed.textScope));
      if(fixed.textScope)entry.textScope=fixed.textScope;
    }
    if(backend!=='legacy'&&entry.scores.some(s=>s.word.rate>.05||s.character.rate>.05))report.failures.push(`${fixed.name}: preregistered5percent text gate failed`);
    if(fixed.photoGold){
      const{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});entry.anchorGeometry=[];
      for(const gold of fixed.photoGold.anchors){
        const center=[(gold.pixelRect[0]+gold.pixelRect[2])/2,(gold.pixelRect[1]+gold.pixelRect[3])/2];
        const candidates=words.filter(w=>w.text.toLowerCase()===gold.word.toLowerCase()).sort((a,b)=>Math.hypot((a.bbox.x0+a.bbox.x1)/2-center[0],(a.bbox.y0+a.bbox.y1)/2-center[1])-Math.hypot((b.bbox.x0+b.bbox.x1)/2-center[0],(b.bbox.y0+b.bbox.y1)/2-center[1]));
        const box=candidates[0]?.bbox,count=(rect,threshold=gold.threshold,light=gold.light)=>{let ink=0,covered=0;const mask=[];
          for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++){const p=(y*info.width+x)*4,gray=(data[p]*77+data[p+1]*150+data[p+2]*29)/256,v=light?gray>threshold:gray<threshold;mask.push(Number(v));if(v){ink++;if(box&&x+.5>=box.x0&&x+.5<box.x1&&y+.5>=box.y0&&y+.5<box.y1)covered++;}}
          return{ink,covered,ratio:covered/Math.max(1,ink),maskSha256:hash(Uint8Array.from(mask))};};
        const own=count(gold.pixelRect);if(own.ink!==gold.foregroundPixels||own.maskSha256!==gold.maskSha256)throw new Error('Frozen photo glyph mask changed');
        const neighbor=acceptance.geometry.photoNeighborMasks.find(n=>n.name===fixed.name&&n.anchor===gold.word),rect=neighbor.rect;
        const neighborPixels=count(neighbor.pixelRect||[Math.floor(rect[0]*info.width),Math.floor(rect[1]*info.height),Math.ceil((rect[0]+rect[2])*info.width),Math.ceil((rect[1]+rect[3])*info.height)],neighbor.threshold,neighbor.light).covered;
        entry.anchorGeometry.push({word:gold.word,box,...own,neighborPixels});
        if(backend!=='legacy'&&(own.ratio<.9||neighborPixels))report.failures.push(`${fixed.name}: ${gold.word} source ownership failed`);
      }
    }
    if(regressionLabel){
      const before=firstEvaluation.cases.find(c=>c.name===fixed.name);
      entry.firstEvaluationComparison={textIdentical:entry.text===before?.text,
        geometryDifferences:JSON.stringify(entry.items)===JSON.stringify(before?.items)?[]:(entry.items||[]).flatMap((item,index)=>JSON.stringify(item)===JSON.stringify(before?.items?.[index])?[]:[{index,before:before?.items?.[index],after:item}])};
    }
    report.cases.push(entry);await save();console.log(JSON.stringify({backend,name:fixed.name,elapsedMs:entry.elapsedMs,scores:entry.scores.map(s=>({wer:s.word.rate,cer:s.character.rate})),invalidGeometry:entry.invalidGeometry}));
    }catch(error){
      if(/Frozen|Protected|candidate mutated/.test(error.message))throw error;
      report.cases.push({name:fixed.name,inputSha256:fixed.sha256,status:'FAIL-execution',failure:error.stack});
      report.failures.push(`${fixed.name}: execution failed`);await save();
      console.log(JSON.stringify({backend,name:fixed.name,status:'FAIL-execution',error:error.message}));
    }
  }
  const scores=report.cases.flatMap(c=>c.scores||[]);
  const sum=field=>scores.reduce((total,s)=>total+s[field].errors,0);
  const wordCount=scores.reduce((total,s)=>total+s.word.referenceWords,0),characters=scores.reduce((total,s)=>total+s.character.referenceCharacters,0);
  report.aggregate={word:{errors:sum('word'),referenceWords:wordCount,rate:sum('word')/Math.max(1,wordCount)},
    character:{errors:sum('character'),referenceCharacters:characters,rate:sum('character')/Math.max(1,characters)}};
  if(backend!=='legacy'&&(report.aggregate.word.rate>.05||report.aggregate.character.rate>.05))report.failures.push('Preregistered aggregate text gate failed');
  await checkPins();report.status=report.failures.length?(regressionLabel?'FAIL-preregistered-development-regression':'FAIL-preregistered-implementation-holdout'):backend==='legacy'?'COMPLETE-independent-development-oracle':regressionLabel?'PASS-development-absolute-gates-pending-legacy-comparison':'PASS-absolute-gates-pending-cross-backend-and-legacy-comparison';
}catch(error){report.status='FAIL-execution';report.failure=error.stack;throw error;}
finally{await browser?.close();await worker?.terminate();report.closed=true;await save();}
if(report.status.startsWith('FAIL'))process.exitCode=1;
