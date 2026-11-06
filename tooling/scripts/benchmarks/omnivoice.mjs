// Serial, instrumented full-runtime A/B. See docs/benchmarks/omnivoice.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium } from '@playwright/test';
import { createOmniVoiceRequest } from '../../../src/lib/omnivoice-settings.js';
import { OMNIVOICE_DATA } from '../../../src/tts/omnivoice/model-data.js';
import { browserAdapterConfiguration, verifyBrowserAdapter } from '../../../tooling/scripts/lib/browser-adapter.mjs';
import { acquireMeasurementLock } from '../../../tooling/scripts/weak-hardware/measurement-lock.mjs';
import { compareOmniVoiceRuntimeSamples, compareOmniVoiceComputeSamples } from '../lib/omnivoice-runtime-comparison.mjs';
import { engineVariantPins } from '../lib/engine-source-pins.mjs';

const root = resolve('.'), directory = resolve('artifacts/omnivoice-micro-20261105');
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const output = resolve(option('--output', `${directory}/speech-${Date.now()}.json`));
assert(output.endsWith('.json'), 'Output must end in .json.');
try { await stat(output); throw new Error('Refusing to overwrite an existing report.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const candidatePath = resolve(option('--candidate', 'src/tts/omnivoice/runtime.js'));
const criterion = option('--criterion', 'cache');
assert(['cache', 'compute'].includes(criterion), 'Criterion must be cache or compute.');
const warmRepeats = Number(option('--warm-repeats', criterion === 'compute' ? '5' : '3'));
const control = process.argv.includes('--control');
assert(Number.isInteger(warmRepeats) && warmRepeats > 0);
const baselinePath = option('--baseline', null);
assert(baselinePath, 'Supply --baseline=<saved runtime.js> from the same checkout.');
const baselineEngineDirectory = option('--baseline-engine-dir', null);
const baselineEngineSources = new Map();
if (baselineEngineDirectory) {
  const names = new Set((await readdir('src/engines')).filter(name => name.endsWith('.js')));
  for (const name of await readdir(baselineEngineDirectory)) {
    assert(names.has(name), `Unexpected baseline engine file: ${name}`);
    baselineEngineSources.set(`/src/engines/${name}`, await readFile(resolve(baselineEngineDirectory, name), 'utf8'));
  }
  assert(baselineEngineSources.size, 'Baseline engine directory must contain saved engine modules.');
}
const baselineSource = await readFile(resolve(baselinePath), 'utf8');
const candidateSource = control ? baselineSource : await readFile(candidatePath, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const requests = [
  { id: 'en-female-1', ...createOmniVoiceRequest('The garden gate is open.', { detectCode: 'en', omniVoice: { gender: 'female', variation: 1, whisper: false } }) },
  { id: 'sv-male-1', ...createOmniVoiceRequest('Vi läser en bok tillsammans.', { detectCode: 'sv', omniVoice: { gender: 'male', variation: 1, whisper: false } }) },
];
const modelRoot = resolve(process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', OMNIVOICE_DATA.modelId);
const configuration = browserAdapterConfiguration();
const sourceNames = ['src/lib/omnivoice-settings.js', ...await Promise.all(['src/engines', 'src/tts/omnivoice'].map(async path =>
  (await readdir(path)).filter(name => name.endsWith('.js')).map(name => `${path}/${name}`))).then(paths => paths.flat())];
const pins = async () => Object.fromEntries(await Promise.all(sourceNames.map(async file => [file, hash(await readFile(file))])));
const implementationPins = await pins();
const instrument = source => {
  assert.equal(source.split('return (state + 0.5) / 4294967296;').length, 2);
  return source.replace('return (state + 0.5) / 4294967296;', 'globalThis.__pnOmniRandomStates.push(state); return (state + 0.5) / 4294967296;');
};
const sources = { baseline: instrument(baselineSource), candidate: instrument(candidateSource) };
const plan = { control, criterion, baselinePath: resolve(baselinePath), baselineEngineDirectory, candidatePath, requests, warmRepeats,
  order: criterion === 'compute' ? ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate'] : ['baseline', 'candidate', 'candidate', 'baseline'],
  harnessSha256: hash(await readFile(new URL(import.meta.url))),
  scoringSha256: hash(await readFile(new URL('../lib/omnivoice-runtime-comparison.mjs', import.meta.url))),
  pinningSha256: hash(await readFile(new URL('../lib/engine-source-pins.mjs', import.meta.url))),
  engineSourceSha256: engineVariantPins(baselineEngineSources, implementationPins, { control }),
  environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  sourceSha256: { baseline: hash(baselineSource), candidate: hash(candidateSource) },
  instrumentedSha256: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, hash(source)])),
  modelPins: OMNIVOICE_DATA, implementationPins,
  scope: 'Instrumented original runtime in module workers. CPU includes feed/RNG/PCM hashing, queue validation and CDP snapshots; not energy, hardware cycles, package UI or audible latency.',
  instrumentation: 'Same development-only RNG-state observer on both sources; no arithmetic or random draws changed. Hash non-cache main feeds, every raw logits buffer, decoder codes, every RNG state and raw float32 PCM. Validate zero cache contents, dimensions and aliases separately.',
  decisionRule: criterion === 'compute'
    ? 'Exact feeds/logits/code/RNG/PCM and no errors; >=5% lower pooled median warm latency and lower per-voice medians; <=5% pooled warm browser-CPU regression; no increase in peak live GPU-buffer bytes. ABBAAB, 5 warm repeats by default. A/A is control only.'
    : 'Exact non-cache feeds/logits/code/RNG/PCM hashes and no errors; pooled warm browser-process CPU lower; <=5% median warm latency regression; lower maximum live GPU-buffer bytes. A/A is a control only, never an adoption decision.',
};
await writeFile(output.replace(/\.json$/, '-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
if (process.argv.includes('--prepare')) { console.log(output.replace(/\.json$/, '-plan.json')); process.exit(0); }

async function browserWorker() {
  let runtime, api, gpuInfo, engines = new Set(), sessions = new Set(), feedHashes = [], logitsHashes = [], cacheInputs = [], cacheData = new Set(), uploadedBytes = 0, decoderCodes, errors = [], liveBytes = 0, peakBytes = 0;
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
  const encoder = new TextEncoder();
  const mainFeeds = async feeds => {
    const aliases = new Map(), descriptors = [], data = [];
    const cache = feeds.past_key_0;
    if (cache.type !== 'float16' || cache.dims.join(',') !== `1,8,${cache.dims[2]},128`
      || ![0, feeds.input_ids.dims[2]].includes(cache.dims[2]) || cache.size !== cache.data.length) throw new Error('Unexpected KV cache.');
    for (let layer = 0; layer < 28; layer++) if (feeds[`past_key_${layer}`] !== cache || feeds[`past_value_${layer}`] !== cache) throw new Error('KV cache aliases changed.');
    cacheInputs.push({ shape: cache.dims, bytes: cache.data.byteLength });
    cacheData.add(cache.data);
    for (const [name, tensor] of Object.entries(feeds)) {
      if (/^past_(key|value)_/u.test(name)) continue;
      if (!aliases.has(tensor.data)) { aliases.set(tensor.data, aliases.size); data.push(await digest(tensor.data)); }
      descriptors.push([name, tensor.type, tensor.dims, aliases.get(tensor.data)]);
    }
    feedHashes.push(await digest(encoder.encode(JSON.stringify({ descriptors, data }))));
  };
  const monitor = engine => {
    if (engines.has(engine)) return;
    engines.add(engine);
    const track = buffer => {
      liveBytes += buffer.size; peakBytes = Math.max(peakBytes, liveBytes);
      const destroy = buffer.destroy.bind(buffer); let destroyed = false;
      buffer.destroy = () => { if (!destroyed) { destroyed = true; liveBytes -= buffer.size; } destroy(); };
      return buffer;
    };
    for (const buffer of engine.buffers) track(buffer);
    const write = engine.write.bind(engine); engine.write = (tensor, data) => { uploadedBytes += data.byteLength; return write(tensor, data); };
    const allocate = engine.buffer.bind(engine); engine.buffer = (...args) => track(allocate(...args));
    engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  };
  self.onmessage = async ({ data: { id, method, arm, request } }) => {
    try {
      let result;
      if (method === 'init') {
        const prefix = arm === 'baseline' ? '/baseline' : '';
        const [{ createOmniVoiceRuntime }, inference, { BytePairTokenizer }] = await Promise.all([
          import(`${prefix}/src/tts/omnivoice/runtime.js`), import(`${prefix}/src/engines/browser-inference.js`), import('/src/engines/bytepair-tokenizer.js'),
        ]);
        const adapter = await navigator.gpu.requestAdapter();
        gpuInfo = { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, device: adapter?.info.device, isFallbackAdapter: adapter?.isFallbackAdapter };
        const json = async file => (await fetch(`/models/${file}`)).json();
        const tokenizer = new BytePairTokenizer(...await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(json)));
        api = inference.createBrowserInferenceEngine({ float16: true });
        const wrapped = { Tensor: api.Tensor, dispose: () => api.dispose(), InferenceSession: { async create(source, options) {
          const session = await api.InferenceSession.create(source, options);
          sessions.add(session.session);
          monitor(session.session.engine);
          return { async run(feeds, outputs) {
            if (feeds.input_ids) await mainFeeds(feeds);
            if (feeds.audio_codes) decoderCodes = await digest(feeds.audio_codes.data);
            const result = await session.run(feeds, outputs);
            if (result.audio_logits) logitsHashes.push(await digest(await result.audio_logits.getData()));
            return result;
          }, release: () => session.release(), getDiagnostics: () => session.getDiagnostics() };
        } } };
        runtime = createOmniVoiceRuntime({ ort: wrapped, decoderRuntime: wrapped, tokenizer, fetch: fetch.bind(globalThis) });
        const start = performance.now(); await runtime.init(`${location.origin}/models`);
        result = { setupMs: performance.now() - start, adapter: gpuInfo, peakGpuBufferBytes: peakBytes, retainedGpuBufferBytes: liveBytes };
      } else if (method === 'synthesize') {
        globalThis.__pnOmniRandomStates = []; feedHashes = []; logitsHashes = []; cacheInputs = []; cacheData = new Set(); uploadedBytes = 0; decoderCodes = null; peakBytes = liveBytes;
        const start = performance.now(), audio = await runtime.synthesize(request), elapsedMs = performance.now() - start;
        result = { elapsedMs, samples: audio.pcm.length, sampleRate: audio.sampleRate, timings: audio.timings,
          speaker: audio.speaker, pcmSha256: await digest(audio.pcm), codeSha256: decoderCodes,
          rngSha256: await digest(Uint32Array.from(globalThis.__pnOmniRandomStates)), randomDraws: globalThis.__pnOmniRandomStates.length,
          mainFeedSha256: feedHashes, logitsSha256: logitsHashes, cacheInputs, replayUploadBytes: uploadedBytes, mainCalls: feedHashes.length, peakGpuBufferBytes: peakBytes, retainedGpuBufferBytes: liveBytes,
          diagnostics: runtime.getDiagnostics(), errors: [...errors] };
        if (!audio.pcm.length || audio.sampleRate !== 24000 || !audio.pcm.every(Number.isFinite) || !audio.pcm.some(value => Math.abs(value) > .001)) throw new Error('Invalid PCM.');
        if (feedHashes.length !== 2 * request.numStep || errors.length) throw new Error('Inference pass count or GPU validation changed.');
      } else if (method === 'validateCaches') {
        // Do not charge the larger baseline for development-only validation scans.
        for (const data of cacheData) if (data.some(value => value !== 0)) throw new Error('KV cache contains nonzero data.');
        const pipelines = {};
        for (const session of sessions) for (const plan of session.cachedPlans.values()) for (const command of plan.batch.commands) {
          if (command.pipeline) pipelines[command.pipeline.label] = (pipelines[command.pipeline.label] || 0) + 1;
        }
        cacheData.clear(); result = { passed: true, pipelines };
      } else if (method === 'dispose') {
        await runtime?.dispose(); await api?.dispose();
        result = { cleanup: [...engines].every(engine => engine.closed && !engine.buffers.size && !engine.tensors.size) && liveBytes === 0, errors };
      } else throw new Error('Unknown operation.');
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error.stack || String(error) }); }
  };
}
const workerSource = `(${browserWorker.toString()})();`;
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url, 'http://localhost'), pathname = decodeURIComponent(url.pathname);
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>OmniVoice exact compute A/B</title>'); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (pathname === '/worker.js') { response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end(workerSource); return; }
  if (pathname.endsWith('/src/tts/omnivoice/runtime.js')) {
    assert(['/src/tts/omnivoice/runtime.js', '/baseline/src/tts/omnivoice/runtime.js'].includes(pathname));
    response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end(sources[pathname.startsWith('/baseline/') ? 'baseline' : 'candidate']); return;
  }
  const localPath = pathname.replace(/^\/baseline/u, '');
  if ((control || pathname.startsWith('/baseline/')) && baselineEngineSources.has(localPath)) {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end(baselineEngineSources.get(localPath)); return;
  }
  let filename;
  if (pathname.startsWith('/models/')) {
    const file = pathname.slice(8); assert(OMNIVOICE_DATA.files.some(item => item.path === file)); filename = resolve(modelRoot, file);
  } else {
    const local = pathname.replace(/^\/baseline/u, '');
    assert(local.startsWith('/src/') && local.endsWith('.js')); filename = resolve(root, `.${local}`); assert(filename.startsWith(`${root}${sep}`));
  }
  const info = await stat(filename);
  response.writeHead(200, { ...headers, 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'Content-Length': info.size }); createReadStream(filename).pipe(response);
})().catch(error => { response.writeHead(404); response.end(String(error)); }); });
const report = { ...plan, samples: [], setup: [], cleanup: [], status: 'incomplete' };
const lock = await acquireMeasurementLock({ owner: { purpose: 'OmniVoice complete exact-runtime A/B' } });
let browser;
try {
  for (const file of OMNIVOICE_DATA.files) {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(resolve(modelRoot, file.path))) { digest.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, file.bytes); assert.equal(digest.digest('hex'), file.sha256);
  }
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--mute-audio', ...configuration.args] });
  report.browserVersion = browser.version(); report.browserArguments = ['--mute-audio', ...configuration.args];
  const cdp = await browser.newBrowserCDPSession();
  const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  const delta = (before, after) => after.reduce((sum, item) => sum + Math.max(0, item.cpuTime - (before.find(previous => previous.id === item.id)?.cpuTime ?? 0)), 0);
  for (const [round, arm] of plan.order.entries()) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      globalThis.worker = new Worker('/worker.js', { type: 'module' });
      let next = 0; const pending = new Map();
      worker.onmessage = ({ data }) => { const entry = pending.get(data.id); pending.delete(data.id); data.error ? entry.reject(new Error(data.error)) : entry.resolve(data.result); };
      worker.onerror = event => { for (const entry of pending.values()) entry.reject(new Error(event.message)); pending.clear(); };
      globalThis.callWorker = data => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ ...data, id }); });
    });
    try {
      const beforeSetup = await cpu(), setup = await page.evaluate(arm => callWorker({ method: 'init', arm }), arm), afterSetup = await cpu();
      verifyBrowserAdapter(setup.adapter, configuration); assert(!setup.adapter.isFallbackAdapter);
      assert.deepEqual(setup.adapter, report.setup[0]?.adapter ?? setup.adapter, 'GPU adapter changed between arms');
      report.setup.push({ round, arm, ...setup, browserCpuSeconds: delta(beforeSetup, afterSetup) });
      for (const request of requests) for (let repeat = 0; repeat <= warmRepeats; repeat++) {
        const before = await cpu(), result = await page.evaluate(request => callWorker({ method: 'synthesize', request }), request), after = await cpu();
        const validation = await page.evaluate(() => callWorker({ method: 'validateCaches' }));
        assert(validation.passed);
        if (criterion === 'compute' && baselineEngineSources.size) {
          const routed = Object.keys(validation.pipelines).some(name => /packed half MatMul (32|wide|K32)$/u.test(name));
          assert.equal(routed, !control && arm === 'candidate', 'Optimized dispatch route did not match the selected arm');
        }
        const row = { round, arm, id: request.id, phase: repeat ? 'warm' : 'shape-cold', repeat, browserCpuSeconds: delta(before, after), ...result, pipelines: validation.pipelines };
        report.samples.push(row); console.log(JSON.stringify({ round, arm, id: row.id, phase: row.phase, browserCpuSeconds: row.browserCpuSeconds, elapsedMs: row.elapsedMs, unmaskMs: row.timings.unmaskMs }));
        const first = report.samples.find(sample => sample.id === row.id);
        for (const key of ['pcmSha256', 'codeSha256', 'rngSha256', 'randomDraws', 'mainCalls', 'samples', 'sampleRate']) assert.deepEqual(row[key], first[key], `${key} changed`);
        assert.deepEqual(row.mainFeedSha256, first.mainFeedSha256, 'Non-cache main feeds changed');
        if (criterion === 'compute') assert.deepEqual(row.cacheInputs, first.cacheInputs, 'Compute cache inputs changed');
        assert.deepEqual(row.logitsSha256, first.logitsSha256, 'Main logits changed'); assert.deepEqual(row.speaker, first.speaker, 'Speaker changed');
      }
      assert.deepEqual(errors, []);
    } finally {
      const cleanup = await page.evaluate(() => callWorker({ method: 'dispose' })); report.cleanup.push({ round, arm, ...cleanup });
      await page.evaluate(() => worker.terminate()); await page.close(); assert(cleanup.cleanup && !cleanup.errors.length);
    }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  assert.deepEqual(await pins(), implementationPins, 'Sources changed during A/B');
  report.comparison = (criterion === 'compute' ? compareOmniVoiceComputeSamples : compareOmniVoiceRuntimeSamples)(report.samples, { control });
  report.status = control ? 'control' : report.comparison.accepted ? 'accepted' : 'rejected';
} catch (error) { report.status = 'failed'; report.error = error.stack || String(error); throw error; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); lock.release();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ output, status: report.status, comparison: report.comparison }));
if (!['accepted', 'control'].includes(report.status)) process.exitCode = 1;
