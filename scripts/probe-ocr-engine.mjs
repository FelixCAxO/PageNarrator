// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Existing ONNX Runtime is an independent test reference only. The candidate
// session imports no third-party inference implementation.
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';
import { engineSourcePins } from './lib/engine-source-pins.mjs';
import { debugOutputModel } from './lib/onnx-debug-outputs.mjs';
import { decodeOnnxModel } from '../src/engines/onnx-model.js';
import { createNodeOcrReference } from './lib/ocr-node-reference.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const recognizer = process.argv.includes('--recognizer');
const unwarp = process.argv.includes('--unwarp');
const benchmark = process.argv.includes('--benchmark');
const large = process.argv.includes('--large');
const onlyLarge = process.argv.includes('--only-large');
const reductionAccuracy = process.argv.includes('--reduction-accuracy');
const nodeReference = process.argv.includes('--node-reference');
const checkpointArgument = process.argv.find(value => value.startsWith('--checkpoint-index='));
const checkpointIndex = reductionAccuracy ? 12 : checkpointArgument ? Number(checkpointArgument.slice('--checkpoint-index='.length)) : null;
if (nodeReference && (benchmark || recognizer || unwarp || reductionAccuracy || checkpointArgument)) throw new Error('Node reference supports full detector parity only; incompatible probe flags were supplied.');
if (onlyLarge && (!large || recognizer || unwarp)) throw new Error('Only-large requires the large detector workload.');
if (reductionAccuracy && (!large || !onlyLarge || checkpointArgument)) throw new Error('Reduction accuracy requires only the single large detector input.');
if (recognizer && unwarp) throw new Error('Select one model per probe.');
const modelKind = unwarp ? 'unwarp' : recognizer ? 'recognizer' : 'detector';
const modelFilename = unwarp ? 'uvdoc.onnx' : recognizer ? 'small-rec.onnx' : 'tiny-det.onnx';
const modelPath = resolve(root, 'public/assets/ocr', modelFilename);
const model = await readFile(modelPath);
let checkpointName = null, probeModel = model;
if (checkpointIndex !== null) {
  if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0 || benchmark || recognizer || unwarp) throw new Error('Checkpoint diagnostics require a valid detector node index.');
  checkpointName = decodeOnnxModel(model).graph.nodes[checkpointIndex]?.outputs[0];
  if (!checkpointName) throw new Error('Unknown detector checkpoint.');
  probeModel = debugOutputModel(model, [checkpointName]);
}
const adapterConfiguration = browserAdapterConfiguration();
const output = resolve(root, `artifacts/engines/ocr-${modelKind}-${benchmark ? 'benchmark' : 'parity'}${large ? '-large' : ''}${onlyLarge ? '-single' : ''}${reductionAccuracy ? '-reduction-accuracy' : checkpointName ? `-checkpoint-${checkpointIndex}` : ''}${nodeReference ? '-node-reference' : ''}${adapterConfiguration.suffix}.json`);
const nodeRuntimeDirectory = `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}`;
const nodeReferenceFiles = nodeReference ? ['scripts/lib/ocr-node-reference.mjs', 'node_modules/onnxruntime-node/package.json',
  ...(await readdir(resolve(root, nodeRuntimeDirectory))).filter(name => /\.(?:node|dll|dylib)$|\.so(?:\.\d+)*$/.test(name)).map(name => `${nodeRuntimeDirectory}/${name}`)] : [];
const nodeVersion = nodeReference ? JSON.parse(await readFile(resolve(root, 'node_modules/onnxruntime-node/package.json'), 'utf8')).version : null;
const pins = () => engineSourcePins(root, ['scripts/probe-ocr-engine.mjs', 'scripts/lib/browser-adapter.mjs', 'scripts/lib/engine-source-pins.mjs',
  `public/assets/ocr/${modelFilename}`, 'public/assets/ocr/small-rec-alphabet.json', 'scripts/lib/onnx-debug-outputs.mjs',
  'scripts/lib/ocr-reduction-accuracy.mjs', 'src/tts/kokoro/phase-correction.js', ...nodeReferenceFiles]);
const implementationPins = await pins();
try { await copyFile(output, output.replace(/\.json$/, `-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator OCR engine verification</title>'); return; }
    const path = pathname.startsWith('/runtime/') ? resolve(root, 'node_modules/onnxruntime-web/dist', pathname.slice(9)) : resolve(root, `.${pathname}`);
    const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json' }[extname(path)];
    if (!path.startsWith(`${root}${sep}`) || !mime) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': mime }); response.end(path === modelPath ? probeModel : await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser, nativeReference;
try {
  if (nodeReference) nativeReference = await createNodeOcrReference(probeModel);
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: adapterConfiguration.args });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  if (nativeReference) await page.exposeFunction('pagenarratorNodeOcrReference', payload => nativeReference.run(payload));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ modelFilename, recognizer, unwarp, benchmark, large, onlyLarge, checkpointName, reductionAccuracy, nodeMetadata }) => {
    const candidateModule = '/src/engines/webgpu-onnx-session.js';
    const referenceModule = benchmark ? '/runtime/ort.webgpu.bundle.min.mjs' : '/runtime/ort.wasm.bundle.min.mjs';
    const { WebGpuOnnxSession } = await import(candidateModule);
    const ort = nodeMetadata ? null : await import(referenceModule);
    if (ort) { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`; }
    const modelBytes = await (await fetch(`/public/assets/ocr/${modelFilename}`)).arrayBuffer();
    const encode = bytes => { const parts = []; for (let index = 0; index < bytes.length; index += 32768) parts.push(String.fromCharCode(...bytes.subarray(index, index + 32768))); return btoa(parts.join('')); };
    const reference = nodeMetadata ? { ...nodeMetadata, release: async () => {}, run: async feeds => {
      const input = feeds[nodeMetadata.inputNames[0]], result = await window.pagenarratorNodeOcrReference({ shape: input.dims,
        base64: encode(new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength)) });
      return Object.fromEntries(Object.entries(result.outputs).map(([name, tensor]) => [name, {
        data: new Float32Array(Uint8Array.from(atob(tensor.base64), char => char.charCodeAt(0)).buffer), dims: tensor.shape,
        inputSha256: result.inputSha256, sha256: tensor.sha256, dispose() {},
      }]));
    } } : await ort.InferenceSession.create(modelBytes, { executionProviders: [benchmark ? 'webgpu' : 'wasm'], graphOptimizationLevel: benchmark ? 'all' : 'disabled', logSeverityLevel: 3 });
    let candidate;
    const validationErrors = [];
    try {
      candidate = await WebGpuOnnxSession.create(modelBytes);
      candidate.engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
      const adapter = await navigator.gpu.requestAdapter();
      const cases = [];
      const alphabet = recognizer ? await (await fetch('/public/assets/ocr/small-rec-alphabet.json')).json() : null;
      const inputs = recognizer ? [[48, 64, 'zero', 1], [48, 128, 'signal', 1], [48, 384, 'text', 1], [48, 384, 'text', 2], [48, 384, 'signal', 2]] : [[64, 96, 'zero', 1], [128, 192, 'signal', 1], [128, 192, 'text', 1]];
      if (large && !recognizer) inputs.push([384, 640, 'text', 1], [768, 1280, 'text', 1]);
      if (onlyLarge) inputs.splice(0, inputs.length - 1);
      let timing = null;
      let lastFeeds;
      for (const [height, width, kind, batchSize] of inputs) {
        const shape = [batchSize, 3, height, width];
        const data = new Float32Array(batchSize * 3 * height * width);
        if (kind === 'signal') for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i * 0.0017) * 0.5;
        if (kind === 'text') {
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.fillStyle = 'white'; context.fillRect(0, 0, width, height);
          context.fillStyle = 'black'; context.font = `${recognizer ? 28 : 16}px sans-serif`;
          context.fillText('PageNarrator browser', 4, recognizer ? 34 : 28);
          if (!recognizer) { context.fillText('GPU text detection 1.0', 4, 60); context.fillText('Read this document.', 4, 92); }
          const pixels = context.getImageData(0, 0, width, height).data;
          const mean = unwarp ? [0, 0, 0] : recognizer ? [0.5, 0.5, 0.5] : [0.485, 0.456, 0.406], deviation = unwarp ? [1, 1, 1] : recognizer ? [0.5, 0.5, 0.5] : [0.229, 0.224, 0.225];
          for (let c = 0; c < 3; c += 1) for (let p = 0; p < height * width; p += 1) data[c * height * width + p] = (pixels[p * 4 + c] / 255 - mean[c]) / deviation[c];
          for (let batch = 1; batch < batchSize; batch += 1) data.set(data.subarray(0, 3 * height * width), batch * 3 * height * width);
        }
        const expected = await reference.run({ [reference.inputNames[0]]: ort ? new ort.Tensor('float32', data, shape) : { data, dims: shape } });
        const actual = await candidate.run({ [candidate.inputNames[0]]: { data, shape } });
        lastFeeds = { [candidate.inputNames[0]]: { data, shape } };
        if (recognizer && kind === 'text') {
          const decode = labels => { let previous = -1; return Array.from(labels, value => { const label = Number(value); const token = label && label !== previous ? alphabet[label] : ''; previous = label; return token; }).join(''); };
          const expectedText = decode(expected.ocr_labels.data), actualText = decode(actual.ocr_labels.data);
          if (actualText !== expectedText || !actualText.includes('PageNarrator')) throw new Error(`Recognition text mismatch: ${actualText} / ${expectedText}`);
          cases.push({ kind: 'decoded-text', actualText, expectedText });
        }
        for (const outputName of reference.outputNames) {
        const expectedTensor = expected[outputName], actualTensor = actual[outputName];
        if (JSON.stringify(expectedTensor.dims) !== JSON.stringify(actualTensor.shape)) throw new Error('Detector output dimensions differ.');
        const thresholds = checkpointName ? [] : recognizer ? outputName === 'ocr_spaces' ? [0.25] : [] : unwarp ? [] : [0.2, 0.4];
        const thresholdDisagreements = Object.fromEntries(thresholds.map(threshold => [threshold, 0]));
        let maxAbsoluteError = 0, maxErrorIndex = -1, sumSquareError = 0, elementsOverAbsoluteGate = 0;
        for (let i = 0; i < expectedTensor.data.length; i += 1) {
          const error = typeof expectedTensor.data[i] === 'bigint' ? Number(actualTensor.data[i] !== expectedTensor.data[i]) : Math.abs(actualTensor.data[i] - expectedTensor.data[i]);
          if (!Number.isFinite(error)) throw new Error(`Non-finite detector output at ${i}.`);
          if (error > maxAbsoluteError) { maxAbsoluteError = error; maxErrorIndex = i; }
          if (error > 0.002) elementsOverAbsoluteGate++;
          sumSquareError += error * error;
          for (const threshold of thresholds) if ((actualTensor.data[i] >= threshold) !== (expectedTensor.data[i] >= threshold)) thresholdDisagreements[threshold] += 1;
        }
        const rmse = Math.sqrt(sumSquareError / expectedTensor.data.length);
        cases.push({ kind, outputName, inputShape: shape, outputShape: actualTensor.shape, elements: expectedTensor.data.length,
          ...(nodeMetadata ? { inputSha256: expectedTensor.inputSha256, referenceSha256: expectedTensor.sha256,
            candidateSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(actualTensor.data.buffer, actualTensor.data.byteOffset, actualTensor.data.byteLength))), byte => byte.toString(16).padStart(2, '0')).join('') } : {}),
          maxAbsoluteError, maxErrorIndex, elementsOverAbsoluteGate,
          worstValues: maxErrorIndex < 0 ? null : { actual: Number(actualTensor.data[maxErrorIndex]), reference: Number(expectedTensor.data[maxErrorIndex]) },
          rmse, thresholdDisagreements, resources: candidate.lastRun });
        if (reductionAccuracy) {
          const prefixComparison = cases.at(-1);
          const accuracyModule = '/scripts/lib/ocr-reduction-accuracy.mjs';
          const { verifyOcrReductionAccuracy } = await import(accuracyModule);
          const accuracy = await verifyOcrReductionAccuracy(ort, new Float32Array(expectedTensor.data), expectedTensor.dims);
          for (const tensor of Object.values(expected)) tensor.dispose();
          const engine = candidate.engine; await candidate.dispose();
          return { ...accuracy, prefixComparison, adapter: adapter.info.toJSON?.() ?? { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
            resourceCleanup: accuracy.resourceCleanup && engine.buffers.size === 0 && engine.tensors.size === 0,
            validationErrors: [...validationErrors, ...accuracy.validationErrors] };
        }
        if (!checkpointName && (maxAbsoluteError > 0.002 || rmse > 0.0001 || Object.values(thresholdDisagreements).some(count => count > Math.max(1, expectedTensor.data.length * 0.0001)))) throw new Error(`Model parity failed: ${JSON.stringify(cases.at(-1))}`);
        }
        for (const tensor of Object.values(expected)) tensor.dispose();
        if (benchmark && height === inputs.at(-1)[0] && width === inputs.at(-1)[1] && kind === inputs.at(-1)[2] && batchSize === inputs.at(-1)[3]) {
          const sample = async (candidateRun) => {
            const start = performance.now();
            if (candidateRun) await candidate.run({ [candidate.inputNames[0]]: { data, shape } });
            else { const result = await reference.run({ [reference.inputNames[0]]: new ort.Tensor('float32', data, shape) }); for (const tensor of Object.values(result)) tensor.dispose(); }
            return performance.now() - start;
          };
          for (let i = 0; i < 3; i += 1) { await sample(false); await sample(true); }
          const baselineMs = [], candidateMs = [];
          for (let i = 0; i < 12; i += 1) {
            if (i % 2) { candidateMs.push(await sample(true)); baselineMs.push(await sample(false)); }
            else { baselineMs.push(await sample(false)); candidateMs.push(await sample(true)); }
          }
          const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[5] + sorted[6]) / 2; };
          timing = { inputShape: shape, warmups: 3, repetitions: 12, baselineMs, candidateMs, baselineMedianMs: median(baselineMs), candidateMedianMs: median(candidateMs), ratio: median(candidateMs) / median(baselineMs), scope: 'local paired end-to-end diagnostic; no cross-device performance acceptance' };
        }
      }
      const retainedBuffers = candidate.engine.buffers.size;
      const persistentWeights = candidate.weights.size;
      const retainedPlanBytes = candidate.cachedPlan?.stats.planBytes ?? 0;
      if (retainedPlanBytes > candidate.maxPlanBytes) throw new Error('Execution plan exceeds its retention limit.');
      await candidate.releasePlan();
      if (candidate.engine.buffers.size !== persistentWeights) throw new Error('Inference intermediates remain after releasing the execution plan.');
      const engine = candidate.engine;
      const pendingRun = candidate.run(lastFeeds);
      const overlapError = await candidate.run(lastFeeds).then(() => null, error => error.message);
      if (!overlapError?.includes('active inference')) throw new Error('Concurrent model inference was not rejected.');
      const closing = candidate.dispose();
      await pendingRun;
      await closing;
      if (engine.buffers.size || engine.tensors.size) throw new Error('Disposed model retains GPU resources.');
      if (validationErrors.length) throw new Error(validationErrors.join('\n'));
      return { adapter: adapter.info.toJSON?.() ?? { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, cases, timing, persistentWeights, retainedBuffers, retainedPlanBytes, rejectedConcurrentInference: true, completedDuringDisposal: true, disposedBuffers: engine.buffers.size, validationErrors };
    } finally {
      await candidate?.dispose();
      await reference.release();
    }
  }, { modelFilename, recognizer, unwarp, benchmark, large, onlyLarge, checkpointName, reductionAccuracy,
    nodeMetadata: nativeReference ? { inputNames: nativeReference.inputNames, outputNames: nativeReference.outputNames } : null });
  if (errors.length) throw new Error(errors.join('\n'));
  verifyBrowserAdapter(result.adapter, adapterConfiguration);
  const sourcesUnchanged = JSON.stringify(implementationPins) === JSON.stringify(await pins());
  if (!sourcesUnchanged) throw new Error('Engine sources changed during verification.');
  const controlPassed = !reductionAccuracy || result.cases.every(item => item.passed) && result.resourceCleanup && result.validationErrors.length === 0;
  const report = { status: !controlPassed ? 'fail' : reductionAccuracy ? 'pass' : checkpointName ? 'diagnostic' : 'pass', checkpointName, large, onlyLarge, implementationPins, sourcesUnchanged,
    ...(checkpointName ? { scope: 'Intermediate-node diagnostic only; the original full-model tolerance is unchanged and its failures remain preserved.', derivedGraphSha256: createHash('sha256').update(probeModel).digest('hex') } : {}),
    browserVersion: browser.version(), browserArguments: adapterConfiguration.args,
    modelSha256: createHash('sha256').update(model).digest('hex'), reference: nodeReference ? `ONNX Runtime Node ${nodeVersion}, CPU 1 thread, graph optimization disabled` : benchmark ? 'ONNX Runtime WebGPU, graph optimization enabled' : 'ONNX Runtime WASM 1 thread, graph optimization disabled', candidate: 'first-party WebGPU, float32, GPU-resident graph', ...result };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!controlPassed) process.exitCode = 1;
} catch (error) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ status: 'fail', failure: String(error.stack || error), implementationPins,
    sourcesUnchanged: JSON.stringify(implementationPins) === JSON.stringify(await pins()),
    browserArguments: adapterConfiguration.args, browserVersion: browser?.version() }, null, 2)}\n`);
  throw error;
} finally {
  try { await browser?.close(); }
  finally { try { await nativeReference?.release(); } finally { await new Promise(done => server.close(done)); } }
}
