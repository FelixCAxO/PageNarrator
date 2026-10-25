// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent ORT/WASM reference; candidate executes only our own WebGPU code.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const benchmark = process.argv.includes('--benchmark');
const profile = process.argv.includes('--profile');
const speech = process.argv.includes('--speech');
if (process.argv.slice(2).some(arg => !['--benchmark', '--profile', '--speech'].includes(arg)) || (profile && !benchmark)) throw new Error('Usage: node scripts/probe-audio-decoder.mjs [--speech] [--benchmark [--profile]]');
const model = manifest.files.find(file => file.path === 'omnivoice-decoder-webgpu.onnx');
const modelPath = resolve(root, process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', manifest.modelId, model.path);
const bytes = await readFile(modelPath);
if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Pinned audio decoder differs.');
const modelRoot = dirname(modelPath);
if (speech) for (const file of manifest.files) {
  const hash = createHash('sha256'); let count = 0;
  for await (const chunk of createReadStream(resolve(modelRoot, file.path))) { count += chunk.length; hash.update(chunk); }
  if (count !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Pinned speech data differs: ${file.path}`);
}
const output = resolve(root, `artifacts/engines/audio-${speech ? 'speech' : 'decoder'}-${benchmark ? 'benchmark' : 'parity'}.json`);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (speech && request.method === 'POST' && /^\/evidence\/voice-(en|sv|arb)\.pcm$/.test(pathname)) {
      const chunks = []; let count = 0;
      for await (const chunk of request) { count += chunk.length; if (count > 16 * 1024 * 1024) throw new Error('Audio evidence exceeds its limit.'); chunks.push(chunk); }
      const pcm = Buffer.concat(chunks), floats = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), wav = Buffer.alloc(44 + floats.length * 2);
      wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(floats.length * 2, 40);
      for (let i = 0; i < floats.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, floats[i])) * 32767), 44 + i * 2);
      await mkdir(dirname(output), { recursive: true }); await writeFile(resolve(dirname(output), pathname.slice(10).replace('.pcm', '.wav')), wav);
      response.writeHead(204); response.end(); return;
    }
    if (speech && pathname.startsWith('/models/')) {
      const name = pathname.slice(8), file = manifest.files.find(file => file.path === name);
      if (!file) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { ...headers, 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': file.bytes });
      createReadStream(resolve(modelRoot, name)).pipe(response); return;
    }
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator audio decoder verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = pathname === '/decoder.onnx' ? modelPath : pathname.startsWith('/runtime/')
      ? resolve(root, 'node_modules/onnxruntime-web-omnivoice/dist', pathname.slice(9)) : resolve(root, `.${pathname}`);
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm' }[extname(path)];
    if ((!path.startsWith(`${root}${sep}`) && path !== modelPath) || !type) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(path === modelPath ? bytes : await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.text().startsWith('PN speech')) console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ benchmark, profile, speech }) => {
    const candidateModule = '/src/engines/webgpu-onnx-session.js', referenceModule = benchmark || speech ? '/runtime/ort.webgpu.bundle.min.mjs' : '/runtime/ort.wasm.bundle.min.mjs';
    const { WebGpuOnnxSession } = await import(candidateModule), ort = await import(referenceModule);
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`; ort.env.logLevel = 'error';
    const model = await (await fetch('/decoder.onnx')).arrayBuffer();
    const reference = await ort.InferenceSession.create(model, { executionProviders: [benchmark ? 'webgpu' : 'wasm'], graphOptimizationLevel: benchmark ? 'all' : 'disabled', logSeverityLevel: 3 });
    let candidate, compute, profileDevice;
    const validationErrors = [], cases = [], timing = [], gpuProfile = [], narration = [];
    try {
      if (profile) {
        const computeModule = '/src/engines/webgpu-compute.js', { WebGpuCompute } = await import(computeModule);
        const adapter = await navigator.gpu.requestAdapter();
        profileDevice = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
        compute = await WebGpuCompute.create({ device: profileDevice });
      }
      candidate = await WebGpuOnnxSession.create(model, { engine: compute });
      candidate.engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
      const adapter = await navigator.gpu.requestAdapter();
      if (speech) {
        const runtimeModule = '/src/tts/omnivoice/runtime.js', tokenizerModule = '/src/engines/bytepair-tokenizer.js', tensorModule = '/src/engines/browser-inference.js';
        const [{ createOmniVoiceRuntime }, { BytePairTokenizer }, { Tensor }, json, config] = await Promise.all([
          import(runtimeModule), import(tokenizerModule), import(tensorModule), fetch('/models/tokenizer.json').then(response => response.json()), fetch('/models/tokenizer_config.json').then(response => response.json()),
        ]);
        const tokenizer = new BytePairTokenizer(json, config);
        let current;
        const runtime = createOmniVoiceRuntime({ ort, tokenizer, fetch: url => fetch(`/models/${url.slice(url.lastIndexOf('/') + 1)}`),
          decoderRuntime: { Tensor, InferenceSession: { create: async () => ({ release: async () => {}, run: async feeds => {
            const tensor = feeds.audio_codes, data = tensor.data, shape = tensor.dims;
            const expected = (await reference.run({ audio_codes: new ort.Tensor('int64', data, shape) })).audio_values;
            const started = performance.now(), actual = (await candidate.run({ audio_codes: { data, shape } })).audio_values;
            const decoderMs = performance.now() - started;
            if (JSON.stringify(actual.shape) !== JSON.stringify(expected.dims)) throw new Error('Narration decoder dimensions differ.');
            let maxAbsoluteError = 0, squareError = 0, energy = 0;
            for (let i = 0; i < actual.data.length; i++) {
              const error = actual.data[i] - expected.data[i];
              if (!Number.isFinite(error)) throw new Error('Narration decoder returned non-finite samples.');
              maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(error)); squareError += error * error; energy += expected.data[i] ** 2;
            }
            const rmse = Math.sqrt(squareError / actual.data.length), snrDb = 10 * Math.log10(energy / Math.max(squareError, 1e-30)); expected.dispose();
            if (maxAbsoluteError > .002 || rmse > .0001 || snrDb < 60) throw new Error(`Narration decoder parity failed: ${JSON.stringify({ maxAbsoluteError, rmse, snrDb })}`);
            Object.assign(current, { frames: shape[2], codes: Array.from(data, Number), maxAbsoluteError, rmse, snrDb, decoderMs, resources: candidate.lastRun });
            return { audio_values: new Tensor('float32', actual.data, actual.shape) };
          } }) } } });
        try {
          const started = performance.now(); await runtime.init('/models');
          const initMs = performance.now() - started;
          console.log(`PN speech initialized in ${Math.round(initMs)} ms`);
          for (const [lang, text] of [['en', 'Hello from PageNarrator.'], ['sv', 'Nu läser vi svenska.'], ['arb', 'مرحبا بالعالم.']]) {
            current = { lang, text, seed: 42, numStep: 24, initMs };
            const started = performance.now(), { pcm, sampleRate } = await runtime.synthesize({ text, lang, instruct: 'None', speed: 1, seed: 42, numStep: 24 });
            const synthesisMs = performance.now() - started;
            let energy = 0, peak = 0;
            for (const value of pcm) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
            Object.assign(current, { samples: pcm.length, sampleRate, seconds: pcm.length / sampleRate, synthesisMs, rms: Math.sqrt(energy / pcm.length), peak,
              scope: 'Real speech codes from the unchanged ORT main model; own tokenizer and own decoder checked against ORT waveform. Listening quality remains unreviewed.' });
            const saved = await fetch(`/evidence/voice-${lang}.pcm`, { method: 'POST', body: pcm });
            if (!saved.ok) throw new Error('Could not save narration evidence.');
            narration.push(current);
            console.log(`PN speech ${lang}: ${pcm.length} samples, ${current.snrDb.toFixed(1)} dB decoder parity`);
          }
        } finally { await runtime.dispose(); }
      }
      // Changed codes of the same dimensions/range must update captured GPU inputs.
      for (const [frames, seed] of [[1, 0], [4, 11], [16, 29], [16, 41], [100, 79]]) {
        const shape = [1, 8, frames];
        let random = seed;
        const data = BigInt64Array.from({ length: 8 * frames }, (_, i) => {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          return BigInt(i === 0 ? 0 : i === 1 ? 1023 : seed ? random % 1024 : 0);
        });
        const expected = (await reference.run({ audio_codes: new ort.Tensor('int64', data, shape) })).audio_values;
        const actual = (await candidate.run({ audio_codes: { data, shape } })).audio_values;
        if (JSON.stringify(expected.dims) !== JSON.stringify(actual.shape)) throw new Error(`Decoder output shape differs: ${JSON.stringify(actual.shape)} / ${JSON.stringify(expected.dims)}`);
        let maxAbsoluteError = 0, sumSquareError = 0, energy = 0;
        for (let i = 0; i < expected.data.length; i++) {
          const error = Math.abs(actual.data[i] - expected.data[i]);
          if (!Number.isFinite(error)) throw new Error(`Non-finite decoder sample ${i}.`);
          maxAbsoluteError = Math.max(maxAbsoluteError, error); sumSquareError += error * error; energy += expected.data[i] ** 2;
        }
        const rmse = Math.sqrt(sumSquareError / expected.data.length), snrDb = 10 * Math.log10(energy / Math.max(sumSquareError, 1e-30));
        const item = { frames, seed, samples: expected.data.length, maxAbsoluteError, rmse, snrDb, resources: candidate.lastRun };
        cases.push(item);
        console.log(JSON.stringify(item));
        expected.dispose();
        if (maxAbsoluteError > .002 || rmse > .0001 || snrDb < 60) throw new Error(`Decoder parity failed: ${JSON.stringify(item)}`);
        if (seed === 41 && !candidate.lastRun.cacheHit) throw new Error('Same-range changed audio codes did not exercise the captured GPU plan.');
        if (benchmark && (seed === 41 || frames === 100)) {
          const candidateMs = [], referenceMs = [];
          const sample = async own => {
            const started = performance.now();
            if (own) await candidate.run({ audio_codes: { data, shape } });
            else { const result = await reference.run({ audio_codes: new ort.Tensor('int64', data, shape) }); result.audio_values.dispose(); }
            return performance.now() - started;
          };
          for (let i = 0; i < 3; i++) { await sample(false); await sample(true); }
          for (let i = 0; i < 12; i++) {
            if (i % 2) { candidateMs.push(await sample(true)); referenceMs.push(await sample(false)); }
            else { referenceMs.push(await sample(false)); candidateMs.push(await sample(true)); }
          }
          const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[5] + sorted[6]) / 2; };
          timing.push({ frames, candidateMs, referenceMs, candidateMedianMs: median(candidateMs), referenceMedianMs: median(referenceMs), ratio: median(candidateMs) / median(referenceMs),
            scope: 'Local paired GPU component diagnostic, including final waveform readback; not cross-device narration acceptance.' });
          if (profile) {
            const commands = candidate.cachedPlan.batch.commands, device = candidate.engine.device;
            const count = commands.filter(command => !command.copy).length * 2, query = device.createQuerySet({ type: 'timestamp', count });
            const resolved = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            const staging = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
              const encoder = device.createCommandEncoder(); let at = 0;
              for (const command of commands) {
                if (command.copy) encoder.copyBufferToBuffer(command.source, 0, command.destination, 0, command.bytes);
                else {
                  const pass = encoder.beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: at++, endOfPassWriteIndex: at++ } });
                  pass.setPipeline(command.pipeline); pass.setBindGroup(0, command.group); pass.dispatchWorkgroups(command.x, command.y, command.z); pass.end();
                }
              }
              encoder.resolveQuerySet(query, 0, count, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, staging, 0, count * 8); device.queue.submit([encoder.finish()]);
              await staging.mapAsync(GPUMapMode.READ); const times = new BigUint64Array(staging.getMappedRange()), totals = new Map(); at = 0;
              for (const command of commands) if (!command.copy) {
                const label = command.pipeline.label, time = Number(times[at + 1] - times[at]) / 1e6; at += 2;
                totals.set(label, (totals.get(label) ?? 0) + time);
              }
              gpuProfile.push({ frames, pipelineMs: Object.fromEntries([...totals].sort((a, b) => b[1] - a[1])) }); staging.unmap();
            } finally { query.destroy(); resolved.destroy(); staging.destroy(); }
          }
        }
      }
      const retained = candidate.engine.buffers.size;
      await candidate.dispose(); await candidate.dispose();
      if (candidate.engine.buffers.size || candidate.engine.tensors.size) throw new Error('Decoder GPU resources remain after disposal.');
      if (validationErrors.length) throw new Error(validationErrors.join('\n'));
      return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }, cases, timing, gpuProfile, narration,
        retainedBeforeDisposal: retained, resourceCleanup: true, validationErrors,
        scope: 'Seeded code tensor parity only; these are not speech-quality or end-to-end narration acceptance cases.' };
    } finally { await candidate?.dispose(); await compute?.dispose(); profileDevice?.destroy(); await reference.release(); }
  }, { benchmark, profile, speech });
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { status: 'pass', browser: browser.version(), modelId: manifest.modelId, revision: manifest.revision,
    modelSha256: model.sha256, reference: benchmark ? 'Packaged ONNX Runtime 1.25 WebGPU, graph optimizations enabled' : 'ONNX Runtime 1.25 WASM, one thread, graph optimizations disabled', ...result };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, narration: report.narration.map(({ codes: _codes, ...item }) => item) }, null, 2));
} catch (error) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ status: 'fail', error: error.stack }, null, 2)}\n`);
  throw error;
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
