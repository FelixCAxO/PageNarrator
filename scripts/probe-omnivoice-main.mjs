// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };
import { debugOutputModel, float32MatmulReference } from './lib/onnx-debug-outputs.mjs';
import { OMNI_PROJECTION_INPUT } from './lib/omnivoice-projection-accuracy.mjs';
import { applyOmniVoiceRmsNormCorrection } from '../src/tts/omnivoice/rmsnorm-correction.js';
import { acquireMeasurementLock } from './weak-hardware/measurement-lock.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const debug = process.argv.includes('--debug');
const checkpoint = process.argv.find(arg => arg.startsWith('--checkpoint='))?.slice(13);
const unoptimizedReference = process.argv.includes('--unoptimized-reference');
const projectionAccuracy = process.argv.includes('--projection-accuracy');
const unmodifiedModel = process.argv.includes('--unmodified-model');
if (projectionAccuracy && (checkpoint || debug)) throw new Error('Projection accuracy is a separate primitive control.');
if (process.argv.slice(2).some(arg => !['--debug', '--unoptimized-reference', '--projection-accuracy', '--unmodified-model'].includes(arg) && !arg.startsWith('--checkpoint='))) throw new Error('Usage: node scripts/probe-omnivoice-main.mjs [--debug] [--checkpoint=node_output] [--unoptimized-reference] [--projection-accuracy] [--unmodified-model]');
const outputName = checkpoint || 'audio_logits';
const output = resolve(root, `artifacts/engines/omnivoice-main${unmodifiedModel ? '' : '-rmsnorm-corrected'}${projectionAccuracy ? '-projection-accuracy' : ''}${checkpoint ? `-checkpoint-${createHash('sha256').update(checkpoint).digest('hex').slice(0, 12)}` : ''}${unoptimizedReference ? '-unoptimized-reference' : ''}-parity.json`);
try { await copyFile(output, output.replace(/\.json$/, `-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = manifest.files.filter(file => /main.*(?:\.onnx|\.onnx_data)$/u.test(file.path));
const modelRoot = resolve(root, process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', manifest.modelId);
for (const file of files) {
  const hash = createHash('sha256'); let count = 0;
  for await (const chunk of createReadStream(resolve(modelRoot, file.path))) { count += chunk.length; hash.update(chunk); }
  if (count !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Pinned model bytes differ: ${file.path}`);
}
const originalGraph = new Uint8Array(await readFile(resolve(modelRoot, 'omnivoice-main-kv-fp16-b1.onnx')));
const correction = unmodifiedModel ? null : await applyOmniVoiceRmsNormCorrection(originalGraph);
const graph = correction?.bytes ?? originalGraph;
const checkpointGraph = checkpoint || projectionAccuracy ? debugOutputModel(graph, [checkpoint || OMNI_PROJECTION_INPUT]) : graph;
const reference = unmodifiedModel || projectionAccuracy ? { bytes: checkpointGraph, promotedMatmuls: 0 } : float32MatmulReference(checkpointGraph);
const modelCorrection = correction ? { version: correction.version, norms: correction.norms, originalSha256: correction.originalSha256,
  modifiedSha256: correction.modifiedSha256 } : null;
const referencePrecision = { policy: unmodifiedModel || projectionAccuracy ? 'Unmodified comparator arithmetic' : 'Float32 MatMul accumulation with unchanged half output storage',
  promotedMatmuls: reference.promotedMatmuls, sha256: createHash('sha256').update(reference.bytes).digest('hex') };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original OmniVoice main-graph verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname === '/models/reference-main.onnx') {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': reference.bytes.length });
      response.end(reference.bytes); return;
    }
    const model = files.find(file => pathname === `/models/${file.path}`);
    if (model) {
      const transformed = model.path.endsWith('.onnx') ? checkpointGraph : null;
      response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': transformed?.length ?? model.bytes });
      if (transformed) response.end(transformed); else createReadStream(resolve(modelRoot, model.path)).pipe(response); return;
    }
    const path = pathname.startsWith('/runtime/') ? resolve(root, 'node_modules/onnxruntime-web-omnivoice/dist', pathname.slice(9)) : resolve(root, `.${pathname}`);
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }[extname(path)];
    if (!path.startsWith(`${root}${sep}`) || !type) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const measurementLock = await acquireMeasurementLock({ owner: { purpose: 'OmniVoice main-model numerical probe' } });
let browser; const errors = [];
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.text().startsWith('PN main')) console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ debug, checkpoint, outputName, unoptimizedReference, projectionAccuracy }) => {
    const candidateModule = '/src/engines/webgpu-onnx-session.js', formatModule = '/src/engines/tensor-format.js', referenceModule = '/runtime/ort.webgpu.bundle.min.mjs';
    const [{ WebGpuOnnxSession }, { halfToFloat }, ort] = await Promise.all([import(candidateModule), import(formatModule), import(referenceModule)]);
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`; ort.env.logLevel = 'error';
    const [graph, weights, referenceGraph] = await Promise.all(['omnivoice-main-kv-fp16-b1.onnx', 'omnivoice-main-kv-fp16-b1.onnx_data', 'reference-main.onnx'].map(path => fetch(`/models/${path}`).then(response => response.arrayBuffer())));
    const options = { executionProviders: ['webgpu'], externalData: [{ path: 'omnivoice-main-kv-fp16-b1.onnx_data', data: weights }], logSeverityLevel: 3,
      ...(unoptimizedReference ? { graphOptimizationLevel: 'disabled' } : {}) };
    const specs = checkpoint ? [[4, 1]] : [[4, 1], [8, 7], [8, 13]], expected = [], cases = [], validationErrors = [];
    function feeds(length, seed) {
      const ids = BigInt64Array.from({ length: 8 * length }, (_, i) => BigInt((i * 31 + seed) % 1025));
      // Cover real text embedding rows across the default storage-buffer boundary.
      for (let book = 0; book < 8; book++) { ids[book * length] = 151000n; ids[book * length + 1] = 140000n; }
      const audio = new Uint8Array(length).fill(1); audio.fill(0, 0, 2);
      const positions = BigInt64Array.from({ length }, (_, i) => BigInt(i));
      const result = { input_ids: { data: ids, shape: [1, 8, length], type: 'int64' }, audio_mask: { data: audio, shape: [1, length], type: 'bool' },
        attention_mask: { data: new Uint8Array(length * length).fill(1), shape: [1, 1, length, length], type: 'bool' },
        position_ids: { data: positions, shape: [1, length], type: 'int64' }, target_positions: { data: positions, shape: [1, length], type: 'int64' } };
      const cache = { data: new Uint16Array(8 * length * 128), shape: [1, 8, length, 128], type: 'float16' };
      for (let layer = 0; layer < 28; layer++) { result[`past_key_${layer}`] = cache; result[`past_value_${layer}`] = cache; }
      return result;
    }
    if (projectionAccuracy) {
      const diagnosticModule = '/scripts/lib/omnivoice-projection-accuracy.mjs';
      const { verifyOmniProjectionAccuracy } = await import(diagnosticModule);
      return verifyOmniProjectionAccuracy({ graph, weights, feeds: feeds(4, 1), ort, options });
    }
    const reference = await ort.InferenceSession.create(referenceGraph, options);
    try {
      for (const [length, seed] of specs) {
        const input = Object.fromEntries(Object.entries(feeds(length, seed)).map(([name, tensor]) => [name, new ort.Tensor(tensor.type, tensor.data, tensor.shape)]));
        try {
          const result = await reference.run(input, [outputName]), tensor = result[outputName];
          const data = await tensor.getData();
          const bits = tensor.type === 'float16' && data.byteLength === tensor.size * 2
            ? new Uint16Array(data.buffer, data.byteOffset, tensor.size) : null;
          expected.push({ shape: tensor.dims, data: bits ? Float32Array.from(bits, halfToFloat) : new Float32Array(data), type: tensor.type });
          tensor.dispose(); console.log(`PN main reference ${length}/${seed} complete`);
        } finally { for (const tensor of new Set(Object.values(input))) tensor.dispose(); }
      }
    } finally { await reference.release(); }
    const candidate = await WebGpuOnnxSession.create(graph, { externalData: options.externalData });
    candidate.engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    let flag, diagnosticNodes;
    if (debug) {
      flag = candidate.engine.uploadInt32(Int32Array.of(-1), [1]); diagnosticNodes = [];
      const pipelines = {};
      for (const type of ['float32', 'float16']) pipelines[type] = await candidate.engine.pipeline(`${type === 'float16' ? 'enable f16;' : ''}
@group(0) @binding(0) var<storage,read> src: array<${type === 'float16' ? 'f16' : 'f32'}>;
@group(0) @binding(1) var<storage,read_write> first: atomic<u32>;
@group(0) @binding(2) var<storage,read> cfg: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) p:vec3<u32>) {
  let i=p.x+p.y*cfg[2u]*64u;
  if(i<cfg[0u] && (bitcast<u32>(f32(src[i])) & 0x7f800000u)==0x7f800000u) { atomicMin(&first,cfg[1u]); }
}`, `diagnostic nonfinite ${type}`);
      const execute = candidate.execute.bind(candidate);
      candidate.execute = (...args) => {
        const result = execute(...args), [node, batch] = args, tensors = Array.isArray(result) ? result : [result];
        for (const tensor of tensors) if (!tensor.cpu && ['float16', 'float32'].includes(tensor.dataType)) {
          const index = diagnosticNodes.length; diagnosticNodes.push({ op: node.opType, name: node.name, outputs: node.outputs, shape: tensor.shape });
          const [x,y] = batch.grid(Math.ceil(tensor.length/64));
          batch.dispatchTensors(pipelines[tensor.dataType], [tensor,flag], Uint32Array.of(tensor.length,index,x), x,y);
        }
        return result;
      };
    }
    try {
      for (let index = 0; index < specs.length; index++) {
        const [length, seed] = specs[index], started = performance.now();
        const actual = (await candidate.run(feeds(length, seed), [outputName]))[outputName], reference = expected[index];
        if (debug) {
          const first = (await candidate.engine.read(flag))[0];
          if (first !== -1) throw new Error(`First nonfinite intermediate ${first}: ${JSON.stringify(diagnosticNodes[first])}`);
        }
        if (Object.keys(actual).length === 0 || JSON.stringify(actual.shape) !== JSON.stringify(reference.shape)) throw new Error('Main logits dimensions differ.');
        const data = actual.type === 'float16' ? Float32Array.from(actual.data, halfToFloat) : new Float32Array(actual.data); let maxAbsoluteError = 0, sumError = 0, sumReference = 0, argmaxMismatch = 0;
        for (let i = 0; i < data.length; i++) {
          const error = data[i] - reference.data[i]; if (!Number.isFinite(error)) throw new Error(`Main logits contain non-finite data at ${i}: candidate=${data[i]} (${actual.type}), reference=${reference.data[i]} (${reference.type}).`);
          maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(error)); sumError += error * error; sumReference += reference.data[i] ** 2;
        }
        for (let offset = 0; !checkpoint && offset < data.length; offset += 1025) {
          let a = 0, b = 0; for (let token = 1; token < 1025; token++) { if (data[offset + token] > data[offset + a]) a = token; if (reference.data[offset + token] > reference.data[offset + b]) b = token; }
          if (a !== b) argmaxMismatch++;
        }
        const relativeRmse = Math.sqrt(sumError / Math.max(sumReference, 1e-30));
        const passed = relativeRmse <= .01 && maxAbsoluteError <= 1;
        const evidence = { outputName, length, seed, passed, maxAbsoluteError, relativeRmse, argmaxMismatch, elapsedMs: performance.now() - started, resources: candidate.lastRun };
        cases.push(evidence); console.log(`PN main candidate ${JSON.stringify(evidence)}`);
      }
    } finally { await candidate.dispose(); }
    if (candidate.engine.buffers.size || candidate.engine.tensors.size || validationErrors.length) throw new Error(`Main graph cleanup/validation failed: ${validationErrors.join('; ')}`);
    return { cases, validationErrors, resourceCleanup: true, referenceGraphOptimization: unoptimizedReference ? 'disabled diagnostic control' : 'default', scope: 'Short pinned-model tensor parity only; diffusion token parity, listening, lifecycle and hardware performance remain separate gates.' };
  }, { debug, checkpoint, outputName, unoptimizedReference, projectionAccuracy });
  if (errors.length) throw new Error(errors.join('\n'));
  const passed = result.cases.every(item => item.passed);
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify({ status: passed ? 'passed' : 'failed', files, modelCorrection, referencePrecision, ...result }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
  console.log(output);
} catch (error) {
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify({ status: 'failed', error: error.stack, browserErrors: errors }, null, 2)}\n`); throw error;
} finally { await browser?.close(); await new Promise(closed => server.close(closed)); measurementLock.release(); }
