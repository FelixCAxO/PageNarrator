// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import * as oracle from 'onnxruntime-node';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { kokoroProbeModelMode, prepareKokoroProbeModel, requireNewKokoroProbeReport } from './lib/kokoro-probe-model.mjs';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), cacheIndex = process.argv.indexOf('--cache');
const directory = resolve(cacheIndex < 0 ? `.cache/kokoro/${KOKORO_DATA.modelId}` : process.argv[cacheIndex + 1]);
const modelMode = kokoroProbeModelMode(), outputIndex = process.argv.indexOf('--output');
const adapterConfiguration = browserAdapterConfiguration();
const output = resolve(root, outputIndex < 0 ? `artifacts/engines/kokoro-gpu-model${modelMode === 'production' ? '-production' : ''}.json` : process.argv[outputIndex + 1]);
await requireNewKokoroProbeReport(output);
const report = { status: 'incomplete', modelMode, requestedAdapter: adapterConfiguration, scope: `Same full ${modelMode === 'production' ? 'production phase-v2' : 'unmodified retained'} f32 Kokoro graph on both paths; identical phonemizer/tokenizer/style/speed versus independent ORT CPU. Numerical and lifecycle evidence, human listening pending.`, timingAcceptance: 'diagnostic only; exclusive hardware use has not been established by this script', modelRevision: KOKORO_DATA.revision, cases: [] };
async function verified(path) {
  const bytes = await readFile(resolve(directory, path)), pin = KOKORO_DATA.files.find(file => file.path === path);
  if (!pin || bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`Invalid data pin: ${path}.`);
  return bytes;
}
function wave(pcm) {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((value, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)); return bytes;
}
let baseline, phonemizer, browser, server;
try {
  const model = await verified('onnx/model.onnx'); report.modelSha256 = createHash('sha256').update(model).digest('hex');
  const prepared = await prepareKokoroProbeModel(model, modelMode), probeModel = prepared.bytes;
  report.phaseCorrection = prepared.phaseCorrection;
  report.comparedModelSha256 = createHash('sha256').update(probeModel).digest('hex');
  const tokenizer = createKokoroTokenizer(JSON.parse(await verified('tokenizer.json')), JSON.parse(await verified('tokenizer_config.json')));
  phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile(resolve(root, 'public/assets/phonemizer/english.wasm')), pronunciationData: await readFile(resolve(root, 'public/assets/phonemizer/pronunciations.bin')) });
  const text = 'Hello.', voice = 'af_heart', speed = 1, phones = await phonemizer.phonemizeText(text, 'en-us'), ids = tokenizer.encode(phones, { strict: true });
  const styleBytes = await verified(`voices/${voice}.bin`), row = ids.length - 2;
  const style = new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + row * 1024, styleBytes.byteOffset + (row + 1) * 1024));
  baseline = await oracle.InferenceSession.create(probeModel, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
  const startReference = performance.now(), expected = (await baseline.run({ input_ids: new oracle.Tensor('int64', ids, [1, ids.length]), style: new oracle.Tensor('float32', style, [1, 256]), speed: new oracle.Tensor('float32', Float32Array.of(speed), [1]) })).waveform;
  const referenceMs = performance.now() - startReference;
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original Kokoro full graph parity</title>'); return; }
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (pathname === '/model.onnx') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': probeModel.length }); response.end(probeModel); return; }
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}${sep}`) || !pathname.startsWith('/src/engines/') || extname(path) !== '.js') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(path));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--mute-audio', ...adapterConfiguration.args] });
  const page = await browser.newPage(), consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actual = await page.evaluate(async ({ ids, style, speed }) => {
    const moduleRoot = new URL('/src/engines/', location.href).href;
    const { WebGpuCompute } = await import(`${moduleRoot}webgpu-compute.js`);
    const { WebGpuOnnxSession } = await import(`${moduleRoot}webgpu-onnx-session.js`);
    const adapter = await navigator.gpu?.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable.');
    const device = await adapter.requestDevice(), engine = await WebGpuCompute.create({ device });
    const validationErrors = []; device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    let session, failure = null, result;
    try {
      session = await WebGpuOnnxSession.create(new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer()), { engine });
      const start = performance.now(), waveform = (await session.run({ input_ids: { shape: [1, ids.length], data: BigInt64Array.from(ids, BigInt) }, style: { shape: [1, 256], data: Float32Array.from(style) }, speed: { shape: [1], data: Float32Array.of(speed) } }, ['waveform'])).waveform;
      result = { elapsedMs: performance.now() - start, shape: waveform.shape, pcm: Array.from(waveform.data), stats: session.lastRun };
    } catch (error) { failure = error.message; }
    finally { await session?.dispose(); await engine.dispose(); device.destroy(); }
    return { ...result, failure, validationErrors, resourceCleanup: !engine.buffers.size && !engine.tensors.size, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } };
  }, { ids: [...ids].map(Number), style: [...style], speed });
  const { pcm, ...details } = actual; Object.assign(report, details, { consoleErrors });
  verifyBrowserAdapter(actual.adapter, adapterConfiguration);
  if (actual.failure) throw new Error(actual.failure);
  let maximumAbsolute = 0, squareError = 0, squareReference = 0, mismatches = 0, finite = true;
  if (pcm.length !== expected.data.length) throw new Error(`PCM output length differs: ${pcm.length}/${expected.data.length}.`);
  for (let i = 0; i < pcm.length; i++) {
    const error = Math.abs(pcm[i] - expected.data[i]); finite &&= Number.isFinite(error);
    maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error ** 2; squareReference += expected.data[i] ** 2;
    if (error > .0003 + .003 * Math.abs(expected.data[i])) mismatches++;
  }
  const audioDirectory = `${output.replace(/\.json$/u, '')}-audio`; await mkdir(audioDirectory, { recursive: true });
  for (const [variant, values] of [['candidate', pcm], ['reference', expected.data]]) await writeFile(resolve(audioDirectory, `0-af_heart-${variant}.wav`), wave(values), { flag: 'wx' });
  report.cases.push({ text, voice, speed, phones, tokens: [...ids].map(Number), samples: pcm.length, referenceMs, candidateMs: actual.elapsedMs, finite, maximumAbsolute, relativeRmse: Math.sqrt(squareError / Math.max(1e-30, squareReference)), mismatches, audioDirectory, listening: 'pending' });
  report.status = finite && !mismatches && actual.resourceCleanup && !actual.validationErrors.length && !consoleErrors.length ? 'pass' : 'fail';
  if (report.status === 'fail') report.failureKind = finite && mismatches && actual.resourceCleanup && !actual.validationErrors.length && !consoleErrors.length ? 'pcm-mismatch' : 'execution';
  console.log(JSON.stringify(report));
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await browser?.close(); if (server) await new Promise(done => server.close(done)); await baseline?.release(); phonemizer?.dispose();
  await mkdir(resolve(root, 'artifacts/engines'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}
if (report.status !== 'pass') throw new Error('Full Kokoro f32 GPU acceptance failed; inspect saved numerical/audio evidence.');
