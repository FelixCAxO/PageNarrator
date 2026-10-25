// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only paired browser computation. Neither oracle code nor test weights ship.
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { applyKokoroPhaseCorrection } from '../src/tts/kokoro/phase-correction.js';

const root=resolve(fileURLToPath(new URL('../',import.meta.url))), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const option=(name,fallback)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const cache=resolve(option('--cache',`.cache/kokoro/${KOKORO_DATA.modelId}`)), threads=Number(option('--reference-threads','1'));
const repeats=Number(option('--repeats','2')), output=resolve(option('--output',`artifacts/engines/kokoro-browser-cpu-${threads}-thread.json`));
if(![1,4].includes(threads)||!Number.isInteger(repeats)||repeats<1||repeats>5)throw new Error('Use one or four reference threads and one to five warm pairs.');
try{await stat(output);throw new Error('Preserving existing browser CPU report; select a new --output.');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(resolve(output,'..'),{recursive:true});
const readData=async path=>{const bytes=await readFile(resolve(cache,path)),pin=KOKORO_DATA.files.find(f=>f.path===path);
  if(!pin||bytes.length!==pin.bytes||hash(bytes)!==pin.sha256)throw new Error(`Pinned model data changed: ${path}`);return bytes;};
const raw=await readData('onnx/model_quantized.onnx'),corrected=await applyKokoroPhaseCorrection(raw);
const fixtureBytes=await readFile(resolve(root,'tests/fixtures/kokoro-connected-prose.json'));
if(hash(fixtureBytes)!=='da954a98973a691563523d22111806e73898e6141498e62f4bf5a3a24c3e56b7')throw new Error('Frozen connected input changed.');
const tokenizer=createKokoroTokenizer(JSON.parse(await readData('tokenizer.json')),JSON.parse(await readData('tokenizer_config.json')));
const phonemizer=await createEnglishPhonemizer({wasmBinary:await readFile(resolve(root,'public/assets/phonemizer/english.wasm')),
  pronunciationData:await readFile(resolve(root,'public/assets/phonemizer/pronunciations.bin'))});
const cases=[];
try{for(const entry of JSON.parse(fixtureBytes).cases){
  const style=await readData(`voices/${entry.voice}.bin`),chunks=[];
  for(const{segment}of new Intl.Segmenter('en',{granularity:'sentence'}).segment(entry.text)){
    const phones=await phonemizer.phonemizeText(segment,entry.voice.startsWith('b')?'en-gb':'en-us'),ids=tokenizer.encode(phones,{strict:true}),row=Math.min(509,ids.length-2);
    chunks.push({text:segment,phones,ids:Array.from(ids,Number),styleBits:Array.from(new Uint32Array(style.buffer.slice(style.byteOffset+row*1024,style.byteOffset+(row+1)*1024)))});
  }
  if(chunks.length!==2||chunks.map(c=>c.text).join('')!==entry.text)throw new Error('Fixed streaming segmentation changed.');
  cases.push({...entry,mode:'stream',chunks});
}}finally{await phonemizer.dispose();}
const sourceFiles=['scripts/probe-kokoro-browser-cpu.mjs','public/native/kokoro-engine.wasm',
  'public/assets/phonemizer/english.wasm','public/assets/phonemizer/pronunciations.bin',
  ...(await readdir(resolve(root,'src/engines'))).filter(f=>f.endsWith('.js')).map(f=>`src/engines/${f}`),
  ...(await readdir(resolve(root,'src/tts/kokoro'))).filter(f=>f.endsWith('.js')).map(f=>`src/tts/kokoro/${f}`)];
const pins=async()=>Object.fromEntries(await Promise.all(sourceFiles.sort().map(async path=>[path,hash(await readFile(resolve(root,path)))])));
const report={status:'incomplete',scope:'Identical phase-corrected q8 graph and fixed token/style/speed feeds, alternating original and ORT browser WASM compute in one isolated worker on an uncontrolled workstation. Computation fields exclude phonemization, transport, download, audible output and cold driver caches; not a complete app speedup or weak-device acceptance.',
  loadTimingScope:'Unequal diagnostic boundaries, never compared: originalLoadMs compiles preloaded native/model bytes; referenceLoadMs also fetches its lazy local WASM/helper assets during Session.create. Neither is full application cold startup.',
  referenceThreads:threads,originalThreads:1,repeats,sourcePins:await pins(),modelSha256:hash(raw),correctedModelSha256:hash(corrected.bytes),
  fixtureSha256:hash(fixtureBytes),cases,requestedFiles:{},unexpectedRequests:[],errors:[]};

async function workerProbe({cases,threads,repeats}){
  let helperWorkers=0;const NativeWorker=globalThis.Worker;
  globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);helperWorkers++;}};
  const modules=new URL('/src/engines/',location.href).href,runtime=new URL('/runtime/ort.wasm.bundle.min.mjs',location.href).href;
  const {WasmKokoroCompute}=await import(`${modules}kokoro-cpu-compute.js`);
  const {WebGpuOnnxSession}=await import(`${modules}webgpu-onnx-session.js`);
  const ort=await import(runtime);ort.env.logLevel='error';ort.env.wasm.numThreads=threads;ort.env.wasm.wasmPaths=`${location.origin}/runtime/`;
  const model=new Uint8Array(await(await fetch('/model.onnx')).arrayBuffer()),native=await(await fetch('/public/native/kokoro-engine.wasm')).arrayBuffer();
  let engine,original,reference;const records=[];
  const times={};
  try{
    let start=performance.now();engine=await WasmKokoroCompute.create(native);original=await WebGpuOnnxSession.create(model,{engine});times.originalLoadMs=performance.now()-start;
    start=performance.now();reference=await ort.InferenceSession.create(model,{executionProviders:['wasm'],graphOptimizationLevel:'all',logSeverityLevel:3});times.referenceLoadMs=performance.now()-start;
    if(threads===4&&(!crossOriginIsolated||helperWorkers<3))throw new Error('Requested reference thread pool was not observed.');
    for(const entry of cases){
      for(let repeat=0;repeat<=repeats;repeat++)for(const backend of repeat%2?['reference','original']:['original','reference']){
        const started=performance.now(),chunks=[];let firstMs,square=0,samples=0;
        for(const chunk of entry.chunks){
          const data={input_ids:BigInt64Array.from(chunk.ids,BigInt),style:new Float32Array(Uint32Array.from(chunk.styleBits).buffer),speed:Float32Array.of(entry.speed)};
          const shapes={input_ids:[1,chunk.ids.length],style:[1,256],speed:[1]};
          const feeds=Object.fromEntries(Object.entries(data).map(([name,value])=>[name,backend==='original'?{shape:shapes[name],data:value}:new ort.Tensor(name==='input_ids'?'int64':'float32',value,shapes[name])]));
          const at=performance.now(),result=backend==='original'?await original.run(feeds,['waveform']):await reference.run(feeds,['waveform']);
          const elapsedMs=performance.now()-at,pcm=result.waveform.data,shape=result.waveform.shape||result.waveform.dims;firstMs??=performance.now()-started;
          if(!(pcm instanceof Float32Array)||!pcm.length||!pcm.every(Number.isFinite))throw new Error('Invalid browser baseline waveform.');
          for(const x of pcm)square+=x*x;samples+=pcm.length;
          const digest=await crypto.subtle.digest('SHA-256',pcm);chunks.push({samples:pcm.length,shape,elapsedMs,pcmSha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')});
          for(const tensor of Object.values(result))tensor.dispose?.();for(const tensor of Object.values(feeds))tensor.dispose?.();
        }
        if(Math.sqrt(square/samples)<.001)throw new Error('Silent browser baseline waveform.');
        const record={id:entry.id,backend,repeat,phase:repeat?'warm':'first-inference',firstPcmMs:firstMs,
          computationMs:chunks.reduce((sum,c)=>sum+c.elapsedMs,0),audioSeconds:samples/24000,chunks};records.push(record);self.postMessage({progress:record});
      }
    }
    await original.dispose();original=null;await reference.release();reference=null;
    if(engine.buffers.size||engine.tensors.size)throw new Error('Browser CPU candidate retained buffers.');
    const arenaBytes=engine.memory.buffer.byteLength;await engine.dispose();
    return{records,times,arenaBytes,remainingBuffers:engine.buffers.size,remainingTensors:engine.tensors.size,nativeMemoryReleased:engine.memory===null,
      crossOriginIsolated,hardwareConcurrency:navigator.hardwareConcurrency,referenceConfiguredThreads:ort.env.wasm.numThreads,helperWorkersCreated:helperWorkers,
      referenceMemoryReleaseBoundary:'Containing module worker is terminated after this result; session.release does not prove shrinkage of its WASM heap.'};
  }finally{await original?.dispose();await reference?.release();await engine?.dispose();}
}
const workerSource=`self.onmessage=async({data})=>{try{self.postMessage({result:await(${workerProbe.toString()})(data)});}catch(error){self.postMessage({failure:error.stack});}};`;
let browser;
const server=createServer(async(request,response)=>{try{
  const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname),headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
  if(path==='/'){response.writeHead(200,{...headers,'Content-Type':'text/html'});response.end('<!doctype html><title>Paired browser CPU computation</title>');return;}
  if(path==='/favicon.ico'){response.writeHead(204,headers);response.end();return;}
  if(path==='/worker.mjs'){response.writeHead(200,{...headers,'Content-Type':'text/javascript'});response.end(workerSource);return;}
  if(path==='/model.onnx'){response.writeHead(200,{...headers,'Content-Type':'application/octet-stream','Content-Length':corrected.bytes.length});response.end(corrected.bytes);return;}
  const runtime=path.startsWith('/runtime/')&&/^[-a-zA-Z0-9_.]+\.(mjs|wasm)$/.test(path.slice(9));
  const file=runtime?resolve(root,'node_modules/onnxruntime-web/dist',path.slice(9)):resolve(root,`.${path}`);
  if(!file.startsWith(`${root}${sep}`)||!(runtime||path.startsWith('/src/engines/')&&extname(file)==='.js'||path==='/public/native/kokoro-engine.wasm'))throw new Error('Unexpected probe file.');
  const bytes=await readFile(file);report.requestedFiles[path]=hash(bytes);
  response.writeHead(200,{...headers,'Content-Type':extname(file)==='.wasm'?'application/wasm':'text/javascript','Content-Length':bytes.length});response.end(bytes);
}catch(error){report.unexpectedRequests.push({url:request.url,error:error.message});response.writeHead(404);response.end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
try{
  browser=await chromium.launch({channel:'chromium',headless:true,args:['--disable-gpu']});const context=await browser.newContext(),page=await context.newPage();
  const origin=`http://127.0.0.1:${server.address().port}`;
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();report.unexpectedRequests.push(route.request().url());return route.abort();});
  page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());if(message.type()==='info')console.log(message.text());});
  await page.goto(origin);report.browser=browser.version();
  report.result=await page.evaluate(({cases,threads,repeats})=>new Promise((done,reject)=>{const worker=new Worker('/worker.mjs',{type:'module'});
    worker.onerror=error=>{worker.terminate();reject(new Error(error.message));};worker.onmessage=({data})=>{if(data.progress)console.info(JSON.stringify(data.progress));
      else{worker.terminate();data.failure?reject(new Error(data.failure)):done(data.result);}};worker.postMessage({cases,threads,repeats});}),{cases,threads,repeats});
  report.outputShapesMatch=report.result.records.every(record=>{const other=report.result.records.find(r=>r.id===record.id&&r.repeat===record.repeat&&r.backend!==record.backend);
    return other&&JSON.stringify(record.chunks.map(c=>c.shape))===JSON.stringify(other.chunks.map(c=>c.shape));});
  report.repeatability=report.result.records.map(record=>{const first=report.result.records.find(r=>r.id===record.id&&r.backend===record.backend);
    return{id:record.id,backend:record.backend,repeat:record.repeat,rawPcmExactToFirst:JSON.stringify(record.chunks.map(c=>c.pcmSha256))===JSON.stringify(first.chunks.map(c=>c.pcmSha256))};});
  report.originalRepeatabilityPass=report.repeatability.filter(r=>r.backend==='original').every(r=>r.rawPcmExactToFirst);
  report.referenceRepeatabilityScope='Same-backend exact PCM is reported independently; no cross-backend PCM parity is inferred from timing or equal output shapes.';
  report.sourcesUnchanged=JSON.stringify(report.sourcePins)===JSON.stringify(await pins());
  report.status=report.outputShapesMatch&&report.originalRepeatabilityPass&&report.sourcesUnchanged&&!report.errors.length&&!report.unexpectedRequests.length?'PASS-fixed-browser-computation-only':'FAIL-probe';
}catch(error){report.status='FAIL-execution';report.failure=error.stack;throw error;}
finally{await browser?.close();await new Promise(done=>server.close(done));await writeFile(output,`${JSON.stringify(report,null,2)}\n`);}
if(report.status.startsWith('FAIL'))process.exitCode=1;
