// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Actual app registry, packaged production worker and immutable model data.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, mkdir, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';
import { runKokoroWorkerBenchmark } from './lib/kokoro-worker-benchmark.mjs';
import { runKokoroQualityCandidate } from './lib/kokoro-quality-candidate.mjs';
import { readQualityFreeze } from './lib/kokoro-quality-controls.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const benchmark = process.argv.includes('--benchmark'), repeats = Number(option('--repeats', '2')), mode = option('--mode', 'stream');
const serialCpu = process.argv.includes('--serial-cpu'), captureDirectory = option('--capture-audio', null);
if ((serialCpu || captureDirectory) && !benchmark) throw new Error('Serial CPU control and raw audio capture require the benchmark lane.');
const qualityRequestPath = option('--quality-request', null), qualityRequest = qualityRequestPath ? JSON.parse(await readFile(qualityRequestPath)) : null;
if (qualityRequest && benchmark) throw new Error('Quality capture and allocation-instrumented performance are separate runs.');
const qualityBuild = qualityRequest ? (await readQualityFreeze(root, qualityRequest.manifest)).packagedBuild : null;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5 || !['stream', 'batch'].includes(mode)) throw new Error('Benchmark requires 1–5 warm repetitions and stream or batch mode.');
const corpusBytes = await readFile(resolve(root, 'tests/fixtures/kokoro-connected-prose.json'));
if (createHash('sha256').update(corpusBytes).digest('hex') !== 'da954a98973a691563523d22111806e73898e6141498e62f4bf5a3a24c3e56b7') throw new Error('Frozen connected-prose fixture changed.');
const benchmarkCorpus = JSON.parse(corpusBytes), selectedCase = option('--case', null);
if (selectedCase && !benchmarkCorpus.cases.some(entry => entry.id === selectedCase)) throw new Error('Unknown frozen performance case.');
benchmarkCorpus.cases = benchmarkCorpus.cases.filter(entry => !selectedCase || entry.id === selectedCase).map(entry => ({ ...entry, mode }));
const selected = option('--backend', 'both'), adapterConfiguration = browserAdapterConfiguration();
if (!['both', 'wasm', 'webgpu'].includes(selected)) throw new Error('Expected both, wasm or webgpu backend.');
const devices = selected === 'both' ? ['wasm', 'webgpu'] : [selected];
const cacheDirectory = resolve(option('--cache', `.cache/kokoro/${KOKORO_DATA.modelId}`));
const reportFile = resolve(option('--output', `artifacts/engines/kokoro-${benchmark ? 'performance' : 'registry'}${adapterConfiguration.suffix}.json`));
const voiceFiles = qualityRequest ? [...new Set(qualityRequest.entries.map(entry => `voices/${entry.voice}.bin`))] : benchmark ? [...new Set(benchmarkCorpus.cases.map(entry => `voices/${entry.voice}.bin`))] : ['voices/af_heart.bin'];
const files = KOKORO_DATA.files.filter(file => ['tokenizer.json', 'tokenizer_config.json', ...voiceFiles,
  ...(devices.includes('wasm') ? ['onnx/model_quantized.onnx'] : []), ...(devices.includes('webgpu') ? ['onnx/model.onnx'] : [])].includes(file.path));
for (const file of files) {
  const bytes = await readFile(resolve(cacheDirectory, file.path));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Invalid pinned input: ${file.path}.`);
}
const sourceFiles = [...(await Promise.all(['src/engines', 'src/tts/kokoro'].map(async directory =>
  (await readdir(resolve(root, directory))).filter(file => file.endsWith('.js')).map(file => `${directory}/${file}`)))).flat(),
  'src/tts/voices/voice-registry.js', 'src/lib/kokoro-multilingual.js', 'src/lib/voice-model.js', 'scripts/probe-kokoro-registry.mjs',
  'scripts/lib/kokoro-performance-worker.mjs', 'scripts/lib/kokoro-worker-benchmark.mjs',
  'native/kokoro-parallel.cpp', 'public/native/kokoro-engine.wasm', 'public/native/kokoro-parallel.wasm', 'public/native/kokoro-parallel.json',
  'public/assets/phonemizer/english.wasm', 'public/assets/phonemizer/pronunciations.bin'].sort();
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const report = { status: 'incomplete', scope: 'Real app registry and original packaged worker transport, UI heartbeat, streaming source association, active CPU termination/offline recovery and required-style corruption. Correctness only; no performance or quality acceptance.',
  modelRevision: KOKORO_DATA.revision, modelPins: files, implementationPins: await pins(), cases: [], downloads: [], consoleErrors: [], expectedOfflineErrors: [], unexpectedRequests: [] };
if (benchmark) Object.assign(report, { scope: 'Original app registry/worker diagnostic performance with unchanged pinned models, phones and chunks. Allocation instrumentation is development-only. No upstream wrapper or speedup claim.',
  cpuPolicy: serialCpu ? 'Development control: only cpuParallel init flag disabled, retaining unchanged production single-worker CPU loader/math.' : 'Actual production capability selection; no forced backend fallback.',
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'), benchmarkCorpus: benchmarkCorpus.cases, warmRepetitions: repeats,
  coldScope: 'Fresh dedicated browser profile; first model data read streams verified local HTTP fixture bytes. Later cold runs recreate the worker from persistent cache. No cold driver-cache or internet-bandwidth claim.',
  audioScope: 'Time until Float32 PCM reaches the app, not Windows speaker output or audible playback. Batch first audio equals completion; stream first audio is the first native segment.',
  repeatabilityScope: 'Exact PCM, token/style/speed feeds and source chunks are compared within this run. This is not an independent comparison against historical accepted PCM or a new quality gate.',
  uiScope: 'Actual foreground page main-thread long-task observer and 25 ms heartbeat. Process/browser-wide RAM, driver VRAM and human responsiveness are not inferred from these counters.' });
let context, profile, page, offline = false, expectedOfflineFailure = false;
const actualWorkers = [];
let hostTimer, hostSample;
async function sampleHost(phase) {
  if (!benchmark) return;
  const record = { phase, at: new Date().toISOString(), freeSystemBytes: freemem(), totalSystemBytes: totalmem() };
  await new Promise(done => execFile('nvidia-smi', ['--query-gpu=timestamp,name,uuid,index,utilization.gpu,utilization.memory,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      Object.assign(record, { nvidiaCsv: error ? null : stdout.trim(), nvidiaUnavailable: error ? error.message : null }); done();
    }));
  report.hostSamples.push(record);
}
if (benchmark) Object.assign(report, { hostSamples: [], cpuModel: cpus()[0]?.model ?? null, logicalCpuCount: cpus().length,
  hostSampleScope: 'nvidia-smi whole-device occupancy includes other desktop/user processes. It is not attributed to this benchmark and says nothing about Intel GPU occupancy. Sampling and allocation observers add overhead.',
  performanceAcceptance: 'Not evaluated by this diagnostic; no exclusive-host, low-end or audible-latency acceptance.' });
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original Kokoro app registry</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (qualityBuild && pathname === '/src/tts/kokoro/worker-client.js') {
      response.writeHead(307, { Location: '/packaged/assets/worker-client.js' }); response.end(); return;
    }
    const data = pathname.startsWith('/data/') ? files.find(entry => entry.path === pathname.slice(6)) : null;
    const packaged = qualityBuild && pathname.startsWith('/packaged/');
    const file = data ? resolve(cacheDirectory, data.path) : packaged ? resolve(qualityBuild.directory, `.${pathname.slice('/packaged'.length)}`) : resolve(root, `.${pathname}`);
    if (packaged && (!file.startsWith(`${qualityBuild.directory}${sep}`) || !['.js', '.wasm', '.bin', '.json'].includes(extname(file)))) throw new Error('Unexpected packaged path.');
    if (!data && !packaged && (!file.startsWith(`${root}${sep}`) || !['/src/', '/public/native/kokoro-engine.wasm', '/public/native/kokoro-parallel.wasm', '/public/native/kokoro-parallel.json', '/public/assets/phonemizer/', '/scripts/lib/kokoro-performance-worker.mjs'].some(prefix => pathname.startsWith(prefix))
      || !['.js', '.mjs', '.wasm', '.bin', '.json'].includes(extname(file)))) throw new Error('Unexpected local path.');
    const metadata = await stat(file);
    response.writeHead(200, { 'Content-Length': metadata.size, 'Content-Type': ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  await sampleHost('before');
  if (benchmark) hostTimer = setInterval(() => {
    if (!hostSample) hostSample = sampleHost('during').finally(() => { hostSample = null; });
  }, 5000);
  profile = await mkdtemp(join(tmpdir(), 'pn-kokoro-registry-'));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: adapterConfiguration.args });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const modelBase = `https://huggingface.co/${KOKORO_DATA.modelId}/resolve/${KOKORO_DATA.revision}/`;
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    if (url.startsWith(modelBase)) {
      const file = files.find(entry => entry.path === url.slice(modelBase.length));
      if (file) {
        report.downloads.push({ path: file.path, blocked: offline });
        // Stream large pinned bytes over HTTP, not a 325 MB base64 DevTools reply.
        return offline ? route.abort() : route.fulfill({ status: 307, headers: { Location: `${origin}/data/${file.path}`, 'Access-Control-Allow-Origin': '*' } });
      }
    }
    report.unexpectedRequests.push(url); return route.abort();
  });
  page = await context.newPage();
  page.on('worker', worker => {
    const record = { url: worker.url(), openedAt: new Date().toISOString(), closedAt: null };
    actualWorkers.push(record); worker.on('close', () => { record.closedAt = new Date().toISOString(); });
  });
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      if (expectedOfflineFailure && /Failed to load resource.*ERR_FAILED/.test(message.text())) report.expectedOfflineErrors.push(message.text());
      else report.consoleErrors.push(message.text());
    }
  });
  await page.goto(origin);
  report.cpuCapabilities = await page.evaluate(() => ({ isolated: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    atomicsWait: typeof Atomics.wait === 'function', logicalCores: navigator.hardwareConcurrency }));
  report.adapter = await page.evaluate(async () => {
    const info = (await navigator.gpu?.requestAdapter())?.info;
    return info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null;
  });
  if (devices.includes('webgpu')) verifyBrowserAdapter(report.adapter, adapterConfiguration);
  await page.evaluate(async ({ benchmark, serialCpu, packaged }) => {
    globalThis.chrome = { runtime: { getURL: path => new URL(`/${packaged ? 'packaged' : 'public'}/${path}`, location.href).href } };
    const NativeWorker = Worker;
    globalThis.workerEvents = []; globalThis.performanceWorkers = [];
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        const helper = /\/cpu-pool-worker(?:-[\w-]+)?\.js$/u.test(new URL(args[0], location.href).pathname);
        if (benchmark && !helper) args[0] = new URL('/scripts/lib/kokoro-performance-worker.mjs', location.href);
        super(...args); this.probeId = workerEvents.filter(event => event.event === 'created').length + 1;
        workerEvents.push({ event: 'created', id: this.probeId, role: helper ? 'helper' : 'coordinator', url: String(args[0]) });
        if (benchmark && !helper) {
          performanceWorkers.push(this);
          this.addEventListener('message', ({ data }) => { if (data.performanceFinal) this.final = data.performanceFinal; });
          this.snapshot = () => new Promise((resolve, reject) => {
            const token = crypto.randomUUID(), timeout = setTimeout(() => { this.removeEventListener('message', receive); reject(new Error('Performance worker snapshot timed out.')); }, 10_000);
            const receive = ({ data }) => { if (data.probeSnapshot === token) { clearTimeout(timeout); this.removeEventListener('message', receive); resolve(data.snapshot); } };
            this.addEventListener('message', receive); this.postMessage({ probeSnapshot: token });
          });
        }
      }
      postMessage(data, transfer) {
        if (serialCpu && data.method === 'init' && data.device === 'wasm') data = { ...data, cpuParallel: false };
        workerEvents.push({ event: 'message', id: this.probeId, method: data.method, cpuPool: data.cpuPool?.type }); super.postMessage(data, transfer);
      }
      terminate() { this.probeTerminated = true; workerEvents.push({ event: 'terminated', id: this.probeId }); super.terminate(); }
    };
    globalThis.registry = await import(new URL('/src/tts/voices/voice-registry.js', location.href).href);
    await registry.configureOnnxRuntime();
  }, { benchmark, serialCpu, packaged: !!qualityBuild });
  for (const device of devices) {
    offline = false;
    if (qualityRequest) {
      await runKokoroQualityCandidate({ root, page, device, requestPath: qualityRequestPath, report });
      continue;
    }
    if (benchmark) {
      await runKokoroWorkerBenchmark({ page, device, corpus: benchmarkCorpus, repeats, report, captureDirectory: captureDirectory ? resolve(captureDirectory) : null });
      await mkdir(resolve(reportFile, '..'), { recursive: true }); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
      continue;
    }
    const normal = await page.evaluate(async device => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const inspect = output => {
        assert(output.audio instanceof Float32Array && output.audio.length && output.audio.every(Number.isFinite), 'Invalid audio from actual registry.');
        let sum = 0; for (const sample of output.audio) sum += sample * sample;
        assert(sum / output.audio.length > .000001, 'Silent registry audio.');
        return { samples: output.audio.length, samplingRate: output.sampling_rate };
      };
      const progress = [], startEvent = workerEvents.length;
      globalThis.tts = await registry.ensureVoiceModel({ backendPlan: { device, dtype: device === 'wasm' ? 'q8' : 'fp32' },
        warmupVoice: 'af_heart', warmupText: 'Hello.', onProgress: entry => progress.push(entry) });
      assert(tts.modelInfo?.version === 'kokoro-exact-zero-phase-v2', 'Registry did not select the guarded original model.');
      assert(registry.getVoiceOptions().length === 10 && registry.getDefaultVoiceId() === 'af_heart', 'Voice catalog changed.');
      const first = await tts.generate('Hello.');
      assert(device !== 'webgpu' || first.fromWarmup, 'Opening GPU warmup audio was not reused.');
      let beats = 0; const timer = setInterval(() => beats++, 25), chunks = [], source = 'Hello. Good morning.';
      try { for await (const chunk of tts.stream(source)) { inspect(chunk.audio); chunks.push({ text: chunk.text, phonemes: chunk.phonemes, samples: chunk.audio.audio.length }); } }
      finally { clearInterval(timer); }
      assert(chunks.map(chunk => chunk.text).join('') === source, 'Streaming lost source text association.');
      assert(beats >= 4, 'The reader event loop did not remain responsive during inference.');
      const created = workerEvents.slice(startEvent).filter(event => event.event === 'created');
      const expectedWorkers = device === 'wasm' && crossOriginIsolated && typeof SharedArrayBuffer === 'function' && navigator.hardwareConcurrency >= 4 ? 4 : 1;
      assert(created.length === expectedWorkers, 'Actual CPU worker selection differed from host capabilities.');
      return { phase: 'normal', device, modelInfo: tts.modelInfo, first: inspect(first), stream: chunks, uiHeartbeatTicks: beats,
        workerEvents: workerEvents.slice(startEvent), progress };
    }, device);
    report.cases.push(normal); console.log(JSON.stringify({ phase: normal.phase, device, beats: normal.uiHeartbeatTicks }));
    offline = true;
    if (device === 'wasm') {
      const downloadsBefore = report.downloads.length;
      const cancellation = await page.evaluate(async () => {
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const text = 'On a quiet morning, the reader settled beside the window and opened the next chapter, leaving enough time to follow each thought. The story moved from a simple question to a thoughtful answer; then, after a short pause, it returned to the idea that mattered most.';
        const controller = new AbortController(), startEvent = workerEvents.length;
        const active = tts.generate(text, { signal: controller.signal });
        const outcome = active.then(() => ({ unexpectedSuccess: true }), error => ({ name: error.name, message: error.message }));
        await new Promise(done => setTimeout(done, 2000));
        const before = workerEvents.filter(event => event.event === 'terminated').length, started = performance.now();
        const queued = tts.generate('Queued speech must not execute.').then(() => ({ unexpectedSuccess: true }), error => ({ name: error.name }));
        controller.abort(); const error = await outcome, queuedError = await queued, cancellationMs = performance.now() - started;
        assert(error.name === 'AbortError', 'Active CPU call did not abort.');
        const width = crossOriginIsolated && typeof SharedArrayBuffer === 'function' && navigator.hardwareConcurrency >= 4 ? 4 : 1;
        assert(queuedError.name === 'AbortError', 'Queued CPU call survived Stop.');
        assert(workerEvents.filter(event => event.event === 'terminated').length === before + width, 'CPU worker group was not terminated on Stop.');
        assert(cancellationMs < 500, 'Stop waited for the long CPU paragraph to finish.');
        const created = workerEvents.filter(event => event.event === 'created').length;
        const resumed = await tts.generate('Hello.');
        assert(workerEvents.filter(event => event.event === 'created').length === created + width && resumed.audio.length, 'Worker group was not lazily recreated for resumed speech.');
        // The app wrapper must also terminate active CPU work when the model is released.
        const disposing = tts.generate(text), disposedOutcome = disposing.then(() => ({ unexpectedSuccess: true }), error => ({ name: error.name }));
        await new Promise(done => setTimeout(done, 1500));
        const releaseStarted = performance.now(); await registry.releaseVoiceModel(); const disposedError = await disposedOutcome;
        assert(disposedError.name === 'AbortError' && performance.now() - releaseStarted < 500, 'CPU release did not terminate the active worker.');
        return { phase: 'active-cpu-stop-and-release', device: 'wasm', cancellationMs, queuedError, disposedError, resumedSamples: resumed.audio.length,
          workerEvents: workerEvents.slice(startEvent), scope: 'Actual long synthesis active for two seconds, prompt worker termination; diagnostic latency only.' };
      });
      cancellation.offlineDownloads = report.downloads.slice(downloadsBefore); report.cases.push(cancellation);
      if (cancellation.offlineDownloads.length) throw new Error('Offline CPU worker recovery attempted model downloads.');
    } else await page.evaluate(() => registry.releaseVoiceModel());
    const downloadsBefore = report.downloads.length;
    const restart = await page.evaluate(async device => {
      const before = workerEvents.length;
      const model = await registry.ensureVoiceModel({ backendPlan: { device, dtype: device === 'wasm' ? 'q8' : 'fp32' }, warmupVoice: 'af_heart', warmupText: 'Hello.' });
      const value = await model.generate('Hello.'); await registry.releaseVoiceModel(); await registry.releaseVoiceModel();
      return { phase: 'offline-registry-restart', device, samples: value.audio.length, modelInfo: model.modelInfo, workerEvents: workerEvents.slice(before) };
    }, device);
    restart.offlineDownloads = report.downloads.slice(downloadsBefore); report.cases.push(restart);
    if (restart.offlineDownloads.length) throw new Error('Offline registry restart attempted model downloads.');
    if (device === 'wasm') {
      expectedOfflineFailure = true;
      const corruption = await page.evaluate(async ({ base, device }) => {
        const cache = await caches.open('kokoro-voices'), url = `${base}voices/af_heart.bin`;
        const bytes = new Uint8Array(await (await cache.match(url)).arrayBuffer()); bytes[0] ^= 1;
        await cache.put(url, new Response(bytes));
        try {
          await registry.ensureVoiceModel({ backendPlan: { device, dtype: 'q8' }, warmupVoice: 'af_heart' });
          throw new Error('The corrupt required style was reported as a ready CPU model.');
        } catch (error) {
          if (error.originalCode !== 'voice_style_download_failed' && error.code !== 'voice_style_download_failed') throw error;
          return { phase: 'required-style-corruption', device, offlineError: { code: error.code, originalCode: error.originalCode, message: error.message },
            corruptEntryEvicted: !(await cache.match(url)), corruption: 'Same-size finite float32 bit flip; actual SHA verification.' };
        }
      }, { base: modelBase, device });
      if (!corruption.corruptEntryEvicted) throw new Error('Corrupt style survived hash verification.');
      offline = false;
      const repair = await page.evaluate(async device => {
        const model = await registry.ensureVoiceModel({ backendPlan: { device, dtype: 'q8' }, warmupVoice: 'af_heart' });
        const result = await model.generate('Hello.'); await registry.releaseVoiceModel();
        return { repairedSamples: result.audio.length };
      }, device);
      Object.assign(corruption, repair); report.cases.push(corruption); expectedOfflineFailure = false;
    }
    const final = await page.evaluate(() => ({ created: workerEvents.filter(event => event.event === 'created').length,
      terminated: workerEvents.filter(event => event.event === 'terminated').length }));
    if (final.created !== final.terminated) throw new Error('An owned Kokoro worker survived disposal.');
    report.workerOwnership = final;
  }
  report.implementationUnchangedDuringProbe = JSON.stringify(report.implementationPins) === JSON.stringify(await pins());
  report.status = report.implementationUnchangedDuringProbe && !report.consoleErrors.length && !report.unexpectedRequests.length ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally {
  clearInterval(hostTimer); await hostSample; await sampleHost('after');
  if (page) {
    try {
      const deadline = Date.now() + 5000;
      while ((page.workers().length || actualWorkers.some(worker => !worker.closedAt)) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
      const expected = await page.evaluate(() => workerEvents.filter(event => event.event === 'created').length);
      report.observedWorkerClosure = { status: page.workers().length === 0 && actualWorkers.every(worker => worker.closedAt) && actualWorkers.length === expected ? 'pass' : 'fail',
        liveTargetsBeforeBrowserClose: page.workers().length, expectedCreated: expected, records: actualWorkers,
        scope: 'Actual Playwright worker close events and empty live targets before browser shutdown; no browser or process memory claim.' };
      if (report.observedWorkerClosure.status !== 'pass') { report.status = 'fail'; process.exitCode = 1; }
    } catch (error) { report.status = 'fail'; report.observedWorkerClosure = { status: 'fail', failure: error.stack, records: actualWorkers }; process.exitCode = 1; }
  }
  await context?.close(); await new Promise(done => server.close(done));
  if (profile) {
    const absolute = await realpath(profile), parent = await realpath(tmpdir());
    if (!absolute.startsWith(`${parent}${sep}pn-kokoro-registry-`)) throw new Error('Refusing cleanup outside the created profile.');
    await rm(absolute, { recursive: true, force: true });
  }
  await mkdir(resolve(reportFile, '..'), { recursive: true }); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, reportFile }));
if (report.status !== 'pass') process.exitCode = 1;
