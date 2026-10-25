// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Fixed existing development input, never a fresh holdout sample.
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{createCpuOcrBrowser}from'./ocr-cpu-browser.mjs';
import{ocrResourceFailures}from'./lib/ocr-resource-gates.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const backend=process.argv.includes('--webgpu')?'webgpu':'cpu';
const corpus=JSON.parse(await readFile('.cache/ocr-paper-roi-baseline/corpus.json'));
const fixed=corpus.cases.find(c=>c.name==='clear-repeat0'),bytes=await readFile(fixed.path);
if(hash(bytes)!==fixed.sha256)throw new Error('Frozen development observer input changed.');
const paths=['scripts/probe-ocr-observer.mjs','scripts/ocr-cpu-browser.mjs','scripts/lib/ocr-engine-observer.mjs','scripts/lib/ocr-resource-gates.mjs',
  'src/lib/pdf-ocr-word-bounds.js','src/lib/pdf-ocr-detector.js','src/lib/pdf-ocr-neural-batch.js'];
const pins=async()=>Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
const initial=await pins(),report={scope:'One existing development clear image, actual original engine with and without allocator/session observation. Exact final text and PDF word items; no fresh quality/performance claim.',
  backend,inputSha256:fixed.sha256,sourcePins:initial,cases:[],status:'incomplete'};
let browser;
try{
  for(const observe of[false,true]){
    browser=await createCpuOcrBrowser({candidate:'verified-retained',backend,observe,expectedVendor:backend==='webgpu'?process.env.PN_GPU_VENDOR||'nvidia':null});
    const result=await browser.recognizePdfSource(bytes);await browser.close();browser=null;
    report.cases.push({observe,...result});
  }
  const[before,after]=report.cases;report.textAndItemsExact=before.text===after.text&&JSON.stringify(before.items)===JSON.stringify(after.items);
  const resources=after.resources,engines=resources?.page.engines||[],cpu=(resources?.workerSnapshots||[]).flatMap(s=>s.engines);
  report.allocatorObserved=backend==='cpu'?cpu.some(e=>e.allocations>0&&e.peakArenaBytes>0):engines.some(e=>e.allocations>0&&e.peakLiveBufferBytes>0);
  report.resourceFailures=ocrResourceFailures(after,backend==='cpu'?'wasm':'webgpu');
  report.resourcesPass=report.resourceFailures.length===0;
  report.sourcesUnchanged=JSON.stringify(initial)===JSON.stringify(await pins());
  report.status=report.textAndItemsExact&&report.allocatorObserved&&report.resourcesPass&&report.sourcesUnchanged
    &&after.actualBackend===(backend==='cpu'?'wasm':'webgpu')?'PASS-fixed-development-observer-control':'FAIL-fixed-development-observer-control';
}catch(error){report.status='FAIL-execution';report.failure=error.stack;throw error;}
finally{await browser?.close();await writeFile(`artifacts/engines/ocr-observer-control-${backend}-${process.env.PN_GPU_VENDOR||'default'}.json`,JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,textAndItemsExact:report.textAndItemsExact,allocatorObserved:report.allocatorObserved,resourcesPass:report.resourcesPass,actualBackend:report.cases[1]?.actualBackend}));
if(report.status.startsWith('FAIL'))process.exitCode=1;
