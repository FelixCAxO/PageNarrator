// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

/** Test/build helper only: the actual browser CPU pipeline, with no third-party OCR engine. */
export async function createCpuOcrBrowser({ candidate = false, beam = false, sourceOverrides = {}, backend = 'cpu', observe = false, expectedVendor = null } = {}) {
  if(!['cpu','webgpu'].includes(backend)||backend==='webgpu'&&candidate!=='verified-retained')throw new Error('Invalid actual OCR audit backend.');
  const adapterConfiguration={...browserAdapterConfiguration(),...(expectedVendor?{expectedVendor}: {})};
  if(observe){
    sourceOverrides={...sourceOverrides,'/src/ocr-audit-observer.js':await readFile(resolve(root,'scripts/lib/ocr-engine-observer.mjs'))};
    for(const[file,className]of[['wasm-ocr-compute.js','WasmOcrCompute'],['webgpu-compute.js','WebGpuCompute']]){
      const path=`/src/engines/${file}`;if(sourceOverrides[path])throw new Error('OCR allocator observation conflicts with source override.');
      sourceOverrides[path]=`import{observeOcrEngine}from'../ocr-audit-observer.js';\n${await readFile(resolve(root,`src/engines/${file}`),'utf8')}\nconst auditCreate=${className}.create;${className}.create=async function(...args){return observeOcrEngine(await auditCreate.call(this,...args));};`;
    }
    const session='/src/engines/webgpu-onnx-session.js';if(sourceOverrides[session])throw new Error('OCR session observation conflicts with source override.');
    sourceOverrides[session]=`import{observeOcrRun}from'../ocr-audit-observer.js';\n${await readFile(resolve(root,session.slice(1)),'utf8')}\nconst auditRun=WebGpuOnnxSession.prototype.run;WebGpuOnnxSession.prototype.run=function(feeds,...rest){observeOcrRun(this,feeds);return auditRun.call(this,feeds,...rest);};`;
    const worker='/src/lib/pdf-ocr-worker.js';if(sourceOverrides[worker])throw new Error('OCR worker observation conflicts with source override.');
    const original=await readFile(resolve(root,worker.slice(1)),'utf8'),needle='self.postMessage({ id: data.id, result });';
    if(!original.includes(needle))throw new Error('Unexpected original OCR worker boundary.');
    sourceOverrides[worker]=`import{ocrEngineSnapshot}from'../ocr-audit-observer.js';\n${original.replace(needle,'self.postMessage({ id: data.id, result, ocrAudit: ocrEngineSnapshot() });')}`;
  }
  sourceOverrides={...sourceOverrides,'/src/ocr-worker-result-capture.js':await readFile(resolve(root,'scripts/lib/ocr-worker-result-capture.mjs'))};
  const images = new Map(); let nextId = 0, browser;
  const candidateAssets = new Map();
  if (candidate === 'english-lstm' || candidate === 'verified-retained') {
    const cache = resolve(root, '.cache/tesseract-english-candidate');
    for (const path of ['model.json', 'weights.bin']) candidateAssets.set(`/candidate/${path}`, await readFile(resolve(cache, path)));
    candidateAssets.set('/assets/ocr/english-lstm.json', await readFile(resolve(root, 'public/assets/ocr/english-lstm.json')));
    candidateAssets.set('/assets/ocr/english-lstm.bin', await readFile(resolve(root, 'public/assets/ocr/english-lstm.bin')));
  } else if (candidate === 'retained-dense') {
    const bytes = await readFile(resolve(root, 'public/assets/ocr/small-rec.onnx'));
    if (createHash('sha256').update(bytes).digest('hex') !== 'c3a4550768b962131ed08dde81e73e2258f2c1d32a0e2ecb0fd80a223c6252f5') throw new Error('Retained OCR model differs.');
    candidateAssets.set('/candidate/inference.onnx', debugOutputModel(bytes, ['fetch_name_0']));
    const alphabet = await readFile(resolve(root, 'public/assets/ocr/small-rec-alphabet.json'));
    if (createHash('sha256').update(alphabet).digest('hex') !== 'b50d01361bea9087ccb896a6381c1a8334e2af14ae0f1036571bd06cdc3832bf') throw new Error('Retained OCR alphabet differs.');
    candidateAssets.set('/candidate/alphabet.json', alphabet);
  } else if (candidate) {
    const kind = candidate === 'latin' ? 'latin' : 'english';
    const manifest = JSON.parse(await readFile(new URL(`../tests/fixtures/ocr/${kind}-rec-candidate.json`, import.meta.url), 'utf8'));
    const cache = resolve(process.env.PN_OCR_CANDIDATE_DIR || resolve(root, `.cache/ocr-${kind}-candidate`), manifest.modelId);
    for (const file of [...manifest.files, manifest.derivedAlphabet]) {
      const bytes = await readFile(resolve(cache, file.path));
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Pinned OCR candidate differs: ${file.path}`);
      candidateAssets.set(`/candidate/${file.path}`, bytes);
    }
  }
  const server = createServer(async (request, response) => {
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if(pathname==='/favicon.ico'){response.writeHead(204,headers);response.end();return;}
      if (pathname === '/') {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator CPU OCR audit</title>'); return;
      }
      if (images.has(pathname)) {
        response.writeHead(200, { ...headers, 'Content-Type': 'image/png' }); response.end(images.get(pathname)); return;
      }
      if (Object.hasOwn(sourceOverrides, pathname)) {
        if (!pathname.startsWith('/src/') || !pathname.endsWith('.js')) throw new Error('Invalid OCR probe source override.');
        response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end(sourceOverrides[pathname]); return;
      }
      if (candidateAssets.has(pathname)) {
        response.writeHead(200, { ...headers, 'Content-Type': types[extname(pathname)] || 'application/octet-stream' }); response.end(candidateAssets.get(pathname)); return;
      }
      let file;
      if (pathname.startsWith('/src/')) {
        file = resolve(root, `.${pathname}`);
        if (!file.startsWith(`${resolve(root, 'src')}${sep}`) || !['.js', '.mjs'].includes(extname(file))) file = null;
      }
      else if (/^\/(?:native\/(?:engine|ocr-engine|ocr-lstm-engine|kernels)\.wasm|assets\/ocr\/(?:tiny-det\.onnx|small-rec\.onnx|small-rec-alphabet\.json|uvdoc\.onnx))$/.test(pathname)) file = resolve(root, `public${pathname}`);
      if (!file || !file.startsWith(`${resolve(root)}${sep}`)) { response.writeHead(404, headers); response.end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] || 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404, headers); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: backend==='cpu'?['--disable-gpu']:adapterConfiguration.args });
    const page = await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const adapter=backend==='webgpu'?await page.evaluate(async()=>{const value=await navigator.gpu?.requestAdapter();if(!value)throw new Error('Requested OCR GPU adapter unavailable');return{...value.info.toJSON?.(),vendor:value.info.vendor,architecture:value.info.architecture,device:value.info.device,description:value.info.description};}):null;
    if(backend==='webgpu')verifyBrowserAdapter(adapter,adapterConfiguration);
    await page.evaluate(async ({ candidate, beam }) => {
      if (candidate === 'verified-retained') {
        if (beam) throw new Error('Independent OCR policy is frozen to greedy decoding.');
        const moduleUrl = new URL('/src/engines/ocr-worker-runtime.js', location.href);
        const { createOcrWorkerRuntime } = await import(moduleUrl.href);
        globalThis.pnCpuOcr = createOcrWorkerRuntime(`${location.origin}/`);
        return;
      }
      if (candidate === 'english-lstm') {
        const moduleUrl = new URL('/src/engines/ocr-tesseract-candidate.js', location.href);
        const { createTesseractOcrCandidate } = await import(moduleUrl.href);
        const get = async path => {
          const response = await fetch(path); if (!response.ok) throw new Error('Pinned English LSTM candidate is unavailable.'); return response.arrayBuffer();
        };
        const [detectorBytes, learnedBytes, wasmBytes, metadata] = await Promise.all([
          get('/assets/ocr/tiny-det.onnx'), get('/candidate/weights.bin'), get('/native/ocr-lstm-engine.wasm'), get('/candidate/model.json'),
        ]);
        const kernelsUrl = new URL('/src/lib/native-kernels.js', location.href);
        await (await import(kernelsUrl.href)).initializeNativeKernels(`${location.origin}/native/kernels.wasm`);
        globalThis.pnCpuOcr = await createTesseractOcrCandidate({ detectorBytes, learnedBytes: new Uint8Array(learnedBytes), wasmBytes,
          manifest: JSON.parse(new TextDecoder().decode(metadata)), beam });
        return;
      }
      if (candidate) {
        const moduleUrl = new URL('/src/engines/ocr-english-candidate.js', location.href);
        const { createEnglishOcrCandidate } = await import(moduleUrl.href);
        const get = async path => {
          const response = await fetch(path); if (!response.ok) throw new Error('Pinned OCR candidate is unavailable.'); return response.arrayBuffer();
        };
        const [detectorBytes, recognizerBytes, wasmBytes, dictionary] = await Promise.all([
          get('/assets/ocr/tiny-det.onnx'), get('/candidate/inference.onnx'), get('/native/ocr-engine.wasm'), get('/candidate/alphabet.json'),
        ]);
        const kernelsUrl = new URL('/src/lib/native-kernels.js', location.href);
        await (await import(kernelsUrl.href)).initializeNativeKernels(`${location.origin}/native/kernels.wasm`);
        globalThis.pnCpuOcr = await createEnglishOcrCandidate({ detectorBytes, recognizerBytes, wasmBytes,
          alphabet: JSON.parse(new TextDecoder().decode(dictionary)), bgr: candidate !== 'retained-dense', beam });
        return;
      }
      const moduleUrl = new URL('/src/engines/wasm-ocr-runtime.js', location.href);
      const { createWasmOcrRuntime } = await import(moduleUrl.href);
      globalThis.pnCpuOcr = await createWasmOcrRuntime(`${location.origin}/`);
    }, { candidate, beam });
    let closed = false;
    return {
      async recognize(bytes, { mode = 'page', crop = null } = {}) {
        if (closed) throw new Error('CPU OCR audit is closed.');
        const imagePath = `/image/${++nextId}.png`; images.set(imagePath, bytes);
        try {
          return await page.evaluate(async ({ imagePath, mode, crop }) => {
            const response = await fetch(imagePath); if (!response.ok) throw new Error('OCR audit image unavailable.');
            const bitmap = await createImageBitmap(await response.blob());
            let canvas;
            try {
              if (bitmap.width * bitmap.height > 4_000_000) throw new RangeError('OCR audit image exceeds four million pixels.');
              canvas = new OffscreenCanvas(crop ? Math.floor(crop.width * crop.factor) : bitmap.width, crop ? Math.floor(crop.height * crop.factor) : bitmap.height);
              if (crop) canvas.getContext('2d').drawImage(bitmap, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
              else canvas.getContext('2d').drawImage(bitmap, 0, 0);
              const output = await globalThis.pnCpuOcr.recognize(canvas, { mode });
              const lines = output.data.blocks.flatMap(block => block.paragraphs).flatMap(part => part.lines);
              return { lines, text: lines.map(line => (line.words || []).map(word => word.text).join(' ')).join('\n') };
            } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
          }, { imagePath, mode, crop });
        } finally { images.delete(imagePath); }
      },
      async recognizePdfSource(bytes) {
        if (closed || candidate && candidate !== 'verified-retained') throw new Error('Source retry probe requires the retained CPU OCR runtime.');
        const imagePath = `/image/${++nextId}.png`; images.set(imagePath, bytes);
        try {
          const errorsBefore=errors.length;
          const result=await page.evaluate(async ({imagePath,backend,observe,adapter}) => {
            // Exercise the production viewer orchestration and real module worker.
            // The page adapter represents one embedded raster, without a second PDF decoder.
            await globalThis.pnCpuOcr.dispose();
            if(backend==='cpu')Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
            const bitmap = await createImageBitmap(await (await fetch(imagePath)).blob());
            const renders = [], results = [], verificationResults = [], diagnostics = [], NativeWorker = globalThis.Worker;
            const {createOcrWorkerResultCapture,ocrPageResultLines}=await import(new URL('/src/ocr-worker-result-capture.js',location.href).href);
            const activeWorkers=new Set(),workerRequests=[],workerSnapshots=[];
            const observer=observe?await import(new URL('/src/ocr-audit-observer.js',location.href).href):null;
            const previousPage=observer?.ocrEngineSnapshot(),previousEngineCount=previousPage?.engines.length||0,previousRunCount=previousPage?.runs.length||0;
            globalThis.Worker = class extends NativeWorker {
              constructor(...args){super(...args);this.resultCapture=createOcrWorkerResultCapture(results,verificationResults);activeWorkers.add(this);}
              postMessage(message,...args){this.resultCapture.request(message);if(message?.method)workerRequests.push({id:message.id,method:message.method,width:message.bitmap?.width,height:message.bitmap?.height});return super.postMessage(message,...args);}
              terminate(){activeWorkers.delete(this);return super.terminate();}
              set onmessage(listener) {
                super.onmessage = event => {
                  this.resultCapture.receive(event.data);
                  if(event.data?.ocrAudit)workerSnapshots.push(event.data.ocrAudit);
                  if (event.data?.type === 'ocr-geometry-diagnostic') diagnostics.push(event.data);
                  listener(event);
                };
              }
            };
            const { createPdfOcr } = await import(new URL('/src/lib/pdf-ocr.js', location.href).href);
            const reader = createPdfOcr({ runtime: { getURL: path => new URL(path, `${location.origin}/`).href } });
            let output;
            try {
              const source = { pageNumber: 1, getTextContent: async () => ({ items: [] }),
                getViewport: ({ scale }) => ({ width: bitmap.width * scale / 3, height: bitmap.height * scale / 3,
                  scale, convertToPdfPoint: (x, y) => [x / scale, y / scale] }),
                render({ canvasContext, viewport, transform = [1, 0, 0, 1, 0, 0] }) {
                  renders.push({ scale: viewport.scale, width: canvasContext.canvas.width,
                    height: canvasContext.canvas.height, transform });
                  canvasContext.save(); canvasContext.setTransform(...transform);
                  canvasContext.drawImage(bitmap, 0, 0, viewport.width, viewport.height); canvasContext.restore();
                  return { promise: Promise.resolve() };
                } };
              const started = performance.now(), items = await reader.recognizePage(source);
              output={ width: bitmap.width, height: bitmap.height, elapsedMs: performance.now() - started, renders, diagnostics,
                initial: ocrPageResultLines(results[0]), retry: ocrPageResultLines(results[1]), verificationResults, items,
                text: items.map(item => item.str).join(' ') };
              return output;
            } finally {
              let workersRemaining;
              try{await reader.destroy();}finally{
                workersRemaining=activeWorkers.size;
                for(const worker of activeWorkers)worker.terminate();
                bitmap.close();globalThis.Worker=NativeWorker;
              }
              if(output&&observe){
                const snapshot=observer.ocrEngineSnapshot(),pageResources={...snapshot,engines:snapshot.engines.slice(previousEngineCount),runs:snapshot.runs.slice(previousRunCount)};
                const gpuRuns=pageResources.runs.filter(r=>r.backend==='webgpu').length;
                const cpuPrimary=workerRequests.filter(r=>r.method==='recognize').length;
                output.actualBackend=gpuRuns?(cpuPrimary?'mixed-webgpu-wasm':'webgpu'):cpuPrimary?'wasm':'none';
                output.adapter=adapter;
                output.resources={errors:[],page:pageResources,workerSnapshots,workerRequests,workersRemaining,workersAfterForcedCleanup:activeWorkers.size,
                  cpuArenaReleaseBoundary:'Worker.terminate; snapshots are measured before hard termination, not evidence of explicit pre-termination arena disposal.'};
              }
            }
          }, {imagePath,backend,observe,adapter});
          if(result.resources)result.resources.errors=errors.slice(errorsBefore);
          return result;
        } finally { images.delete(imagePath); }
      },
      async inspectEnglishConfidence(bytes, render = null) {
        if (closed || candidate !== 'english-lstm') throw new Error('English confidence inspection requires the explicit English candidate.');
        const imagePath = `/image/${++nextId}.png`; images.set(imagePath, bytes);
        try {
          return await page.evaluate(async ({ imagePath, render }) => {
            const { TesseractLineModel } = await import(new URL('/src/engines/tesseract-line-model.js', location.href).href);
            const original = TesseractLineModel.prototype.runPixels, captures = [];
            TesseractLineModel.prototype.runPixels = async function(...args) {
              const result = await original.apply(this, args), words = []; let previous = 110, runs = [], run;
              const finish = () => { if (runs.length) words.push({ text: runs.map(value => value.text).join(''),
                firstConfidence: 100 * runs.reduce((sum, value) => sum + value.first, 0) / runs.length,
                peakConfidence: 100 * runs.reduce((sum, value) => sum + value.peak, 0) / runs.length, runs }); runs = []; run = null; };
              for (let step = 0; step < result.dims[0]; step++) {
                let label = 0;
                for (let c = 1; c < 111; c++) if (result.data[step * 111 + c] > result.data[step * 111 + label]) label = c;
                const confidence = result.data[step * 111 + label];
                if (label !== previous && label !== 110) {
                  if (label === 0) finish();
                  else { run = { text: this.manifest.alphabet[label], first: confidence, peak: confidence, frames: 1 }; runs.push(run); }
                } else if (label !== 0 && label !== 110 && run) { run.peak = Math.max(run.peak, confidence); run.frames++; }
                if (label === 110) run = null;
                previous = label;
              }
              finish(); captures.push({ width: args[1], words }); return result;
            };
            const bitmap = await createImageBitmap(await (await fetch(imagePath)).blob());
            const canvas = new OffscreenCanvas(render?.width || bitmap.width, render?.height || bitmap.height);
            try {
              const context = canvas.getContext('2d');
              if (render) { context.setTransform(...render.transform); context.drawImage(bitmap, 0, 0, bitmap.width * render.scale / 3, bitmap.height * render.scale / 3); }
              else context.drawImage(bitmap, 0, 0);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
              const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(value => value.toString(16).padStart(2, '0')).join('');
              const started = performance.now(), output = await globalThis.pnCpuOcr.recognize(canvas, { mode: render ? 'crop' : 'page' });
              const lines = output.data.blocks.flatMap(block => block.paragraphs).flatMap(part => part.lines);
              return { captures, lines, render, rgbaSha256: hash, elapsedMs: performance.now() - started };
            } finally { TesseractLineModel.prototype.runPixels = original; bitmap.close(); canvas.width = canvas.height = 0; }
          }, { imagePath, render });
        } finally { images.delete(imagePath); }
      },
      async inspectIndependentRejection(bytes, syntheticPrimaryText) {
        if (closed || candidate !== 'verified-retained') throw new Error('Independent negative inspection requires the verified retained runtime.');
        const imagePath = `/image/${++nextId}.png`; images.set(imagePath, bytes);
        try {
          return await page.evaluate(async ({ imagePath, syntheticPrimaryText }) => {
            const bitmap = await createImageBitmap(await (await fetch(imagePath)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            try {
              canvas.getContext('2d').drawImage(bitmap, 0, 0);
              const independent = await globalThis.pnCpuOcr.recognizeLine(canvas);
              const line = independent.blocks[0].paragraphs[0].lines[0];
              if (line.words.length !== 1) throw new Error('Incorrect-word negative requires exactly one independently read word.');
              const primary = { blocks: [{ paragraphs: [{ lines: [{ ...line, words: [{ ...line.words[0], text: syntheticPrimaryText, confidence: 99 }] }] }] }] };
              const { mergePdfOcrIndependentLine } = await import(new URL('/src/lib/pdf-ocr-independent.js', location.href).href);
              const merged = mergePdfOcrIndependentLine(primary, independent);
              return { syntheticPrimaryText, independent: line.words[0], accepted: merged !== primary,
                output: merged.blocks[0].paragraphs[0].lines[0].words[0].text };
            } finally { bitmap.close(); canvas.width = canvas.height = 0; }
          }, { imagePath, syntheticPrimaryText });
        } finally { images.delete(imagePath); }
      },
      async inspectSourceCrops(bytes, crops) {
        if (closed) throw new Error('Crop investigation requires an open CPU OCR runtime.');
        const imagePath = `/image/${++nextId}.png`; images.set(imagePath, bytes);
        try {
          return await page.evaluate(async ({ imagePath, crops }) => {
            const bitmap = await createImageBitmap(await (await fetch(imagePath)).blob());
            const { InferenceSession } = await import(new URL('/src/engines/browser-inference.js', location.href).href);
            const originalRun = InferenceSession.prototype.run;
            let captures = [];
            InferenceSession.prototype.run = async function(feeds, ...rest) {
              const result = await originalRun.call(this, feeds, ...rest);
              if (this.outputNames.includes('ocr_labels')) {
                const input = feeds[this.inputNames[0]];
                captures.push({ inputName: this.inputNames[0], shape: input.dims, input: Array.from(input.data),
                  labels: Array.from(result.ocr_labels.data, Number), scores: Array.from(result.ocr_scores.data),
                  spaces: Array.from(result.ocr_spaces.data), dims: result.ocr_labels.dims });
              }
              return result;
            };
            try {
              const results = [];
              for (const crop of crops) {
                captures = [];
                const canvas = new OffscreenCanvas(Math.floor(crop.width * crop.factor), Math.floor(crop.height * crop.factor));
                try {
                  canvas.getContext('2d').drawImage(bitmap, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
                  const started = performance.now(), output = await globalThis.pnCpuOcr.recognize(canvas, { mode: 'crop' });
                  const lines = output.data.blocks.flatMap(block => block.paragraphs).flatMap(part => part.lines);
                  results.push({ crop, elapsedMs: performance.now() - started, lines, captures,
                    text: lines.map(line => (line.words || []).map(word => word.text).join(' ')).join('\n') });
                } finally { canvas.width = canvas.height = 0; }
              }
              return results;
            } finally { InferenceSession.prototype.run = originalRun; bitmap.close(); }
          }, { imagePath, crops });
        } finally { images.delete(imagePath); }
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await page.evaluate(() => globalThis.pnCpuOcr.dispose()); }
        finally { try { await browser.close(); } finally { images.clear(); await new Promise(resolve => server.close(resolve)); } }
      },
    };
  } catch (error) {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
    throw error;
  }
}
