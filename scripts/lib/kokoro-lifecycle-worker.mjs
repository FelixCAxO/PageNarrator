// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only worker: every synthesis uses the actual original engine and retained graph.
import * as inference from '../../src/engines/browser-inference.js';
import { createKokoroDataLoader, loadBrowserKokoroBackend } from '../../src/tts/kokoro/model-loader.js';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';
import { createPackagedKokoroCpuEngine } from '../../src/tts/kokoro/cpu-engine.js';
import { createPageNarratorKokoroTts } from '../../src/lib/kokoro-multilingual.js';
import { KOKORO_DATA } from '../../src/tts/kokoro/model-data.js';

const nativeFetch = globalThis.fetch.bind(globalThis), base = `https://huggingface.co/${KOKORO_DATA.modelId}/resolve/${KOKORO_DATA.revision}/`;
const runtime = { getURL: path => new URL(`/public/${path}`, location.href).href };
let offline = false, onRunStart = null, phaseCorrection = false;
const downloads = [], progress = [], engines = [], sessions = [], phonemizers = [], backends = [], validationErrors = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith(base)) {
    const path = target.slice(base.length);
    assert(KOKORO_DATA.files.some(file => file.path === path), `Unpinned data request: ${path}.`);
    downloads.push({ path, blocked: offline });
    if (offline) throw new Error('Offline model-data fetch is intentionally unavailable.');
    return nativeFetch(new URL(`/data/${path}`, location.href), options);
  }
  assert(new URL(target, location.href).origin === location.origin, `Unexpected external request: ${target}.`);
  return nativeFetch(url, options);
};
const adapter = { Tensor: inference.Tensor, InferenceSession: { async create(source, options) {
  const session = await inference.InferenceSession.create(source, options);
  sessions.push(session);
  if (!engines.includes(session.session.engine)) {
    const engine = session.session.engine; engines.push(engine);
    engine.device?.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  }
  const run = session.run.bind(session);
  session.run = (feeds, outputs) => { const callback = onRunStart; onRunStart = null; callback?.(); return run(feeds, outputs); };
  return session;
} } };
async function open(device) {
  const backend = await loadBrowserKokoroBackend(KOKORO_DATA.modelId, { device, dtype: device === 'wasm' ? 'q8' : 'fp32', runtime,
    phaseCorrection,
    inference: adapter, loadData: createKokoroDataLoader({ fetcher: globalThis.fetch, onProgress: entry => progress.push(entry) }),
    phonemizerFactory: async options => { const value = await createEnglishPhonemizer(options); phonemizers.push(value); return value; },
    cpuEngineFactory: async options => { const value = await createPackagedKokoroCpuEngine(options); engines.push(value); return value; },
  });
  if (phaseCorrection) assert(backend.modelInfo?.version === 'kokoro-exact-zero-phase-v2' && backend.modelInfo.modifiedSha256 !== backend.modelInfo.originalSha256, 'Guarded derived graph identity was not exposed.');
  backends.push(backend); return backend;
}
function audio(value) {
  assert(value?.audio instanceof Float32Array && value.audio.length > 100 && value.audio.every(Number.isFinite), 'Actual synthesis produced invalid PCM.');
  let sum = 0; for (const sample of value.audio) sum += sample * sample;
  const rms = Math.sqrt(sum / value.audio.length); assert(rms > .001, 'Actual synthesis was silent.');
  return { samples: value.audio.length, rms, samplingRate: value.sampling_rate };
}
async function rejected(task, pattern) {
  try { await task; } catch (error) { assert(pattern.test(error.message) || pattern.test(error.name), `Unexpected rejection: ${error.name}: ${error.message}`); return { name: error.name, message: error.message }; }
  throw new Error('The operation unexpectedly succeeded.');
}
function resources() {
  return { engines: engines.map(engine => ({ closed: engine.closed, buffers: engine.buffers.size, tensors: engine.tensors.size,
    nativeMemoryReleased: 'memory' in engine ? engine.memory === null : undefined })),
  modelsReleased: sessions.every(session => session.session.model === null),
  phonemizersReleased: phonemizers.every(value => value.diagnostics().nativeMemoryBytes === 0) };
}
async function cleanup() {
  const results = await Promise.allSettled(backends.map(backend => backend.dispose()));
  const failures = results.filter(result => result.status === 'rejected');
  assert(!failures.length, `Backend cleanup rejected: ${failures.map(result => result.reason).join('; ')}`);
  const state = resources();
  assert(state.engines.every(engine => engine.closed && !engine.buffers && !engine.tensors && engine.nativeMemoryReleased !== false)
    && state.modelsReleased && state.phonemizersReleased, `Resources survived disposal: ${JSON.stringify(state)}`);
  return state;
}

async function normal(device) {
  const backend = await open(device), wrapper = createPageNarratorKokoroTts(backend, { runtime, device });
  const warmed = await wrapper.warmup({ speechText: 'Hello.', voice: 'af_heart', speed: 1 });
  const warmAudio = await wrapper.generate('Hello.', { voice: 'af_heart', speed: 1 });
  assert(device === 'wasm' || (warmed.warmed && warmAudio.fromWarmup), 'The existing wrapper did not consume its real GPU warmup audio.');
  const first = audio(warmAudio);
  const controller = new AbortController(); controller.abort();
  const preAbort = await rejected(backend.generate('Hello.', { signal: controller.signal }), /AbortError|aborted/);
  const activeController = new AbortController();
  onRunStart = () => queueMicrotask(() => activeController.abort());
  const activeAbort = await rejected(backend.generate('Hello.', { signal: activeController.signal }), /AbortError|aborted/);
  const recovered = audio(await backend.generate('Hello.'));
  // The existing scheduler must serialize real runs and retire queued work on disposal.
  const serial = await Promise.all([wrapper.generate('Hello.'), wrapper.generate('Good morning.')]); serial.forEach(audio);
  const queuedController = new AbortController(); let queued, queuedOutcome;
  onRunStart = () => {
    queued = wrapper.generate('Good morning.', { signal: queuedController.signal });
    queuedOutcome = rejected(queued, /AbortError|aborted/); queuedController.abort();
  };
  audio(await wrapper.generate('Hello.')); const queuedAbort = await queuedOutcome;
  assert(queued && queuedAbort, 'The wrapper abort check did not overlap an actual active run.');
  await wrapper.dispose(); await wrapper.dispose();
  await rejected(wrapper.generate('Hello.'), /disposed/);
  const second = await open(device);
  let disposal;
  onRunStart = () => { disposal = second.dispose(); };
  const disposeDuringInference = await rejected(second.generate('Hello.'), /disposed/);
  assert(disposal, 'Disposal did not overlap an actual inference.'); await disposal;
  return { first, preAbort, activeAbort, recovered, serializedRuns: serial.length, queuedAbort, disposeDuringInference };
}
async function offlineRestart(device) {
  offline = true;
  const backend = await open(device), result = audio(await backend.generate('Hello.'));
  assert(!downloads.length, 'An offline restart attempted a model download despite the complete verified cache.');
  await backend.dispose(); return { audio: result, blockedRequests: downloads.length };
}
async function corruptAndRecover(device) {
  const graphFile = device === 'wasm' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx', voiceFile = 'voices/af_heart.bin';
  await (await caches.open('transformers-cache')).put(`${base}${graphFile}`, new Response(Uint8Array.of(1, 2, 3, 4)));
  const voiceCache = await caches.open('kokoro-voices'), corruptStyle = new Uint8Array(await (await voiceCache.match(`${base}${voiceFile}`)).arrayBuffer());
  corruptStyle[0] ^= 1; // Preserve byte length and finite values: recovery must detect the SHA mismatch.
  await voiceCache.put(`${base}${voiceFile}`, new Response(corruptStyle));
  offline = true;
  const offlineFailure = await rejected(open(device), /offline/i);
  assert(!engines.length && phonemizers.length === 1 && phonemizers[0].diagnostics().nativeMemoryBytes === 0,
    'A corrupt offline model preparation retained an executable backend or phonemizer.');
  offline = false;
  const backend = await open(device), wrapper = createPageNarratorKokoroTts(backend, { runtime, device });
  const result = audio(await wrapper.generate('Hello.')); await wrapper.dispose();
  assert(progress.filter(entry => entry.status === 'cache-invalid').some(entry => entry.file === graphFile)
    && progress.filter(entry => entry.status === 'cache-invalid').some(entry => entry.file === voiceFile), 'Both corrupt cache entries must be detected.');
  assert(downloads.filter(entry => !entry.blocked).map(entry => entry.path).sort().join() === [graphFile, voiceFile].sort().join(),
    `Recovery fetched unexpected data: ${JSON.stringify(downloads)}`);
  return { offlineFailure, replacedGraphAndStyle: true, corruption: 'Truncated graph and same-length bit-flipped style',
    synthesisPath: 'Existing app wrapper calling original prepareVoice hash verifier', audio: result };
}
async function deviceLoss() {
  const backend = await open('webgpu'), before = audio(await backend.generate('Hello.')), engine = engines.at(-1);
  engine.device.destroy(); const loss = await engine.device.lost;
  const failure = await rejected(backend.generate('Hello.'), /lost|disposed|destroyed|failed/i);
  await backend.dispose();
  const replacement = await open('webgpu'), after = audio(await replacement.generate('Hello.')); await replacement.dispose();
  assert(engines.at(-1) !== engine && !downloads.length, 'Device-loss recovery must recreate compute and reuse verified model data.');
  return { trigger: 'Explicit GPUDevice.destroy(), not a spontaneous hardware failure', reason: loss.reason, before, failure, after,
    recovery: 'Explicit disposal and reopening; this does not claim automatic application recovery' };
}

self.onmessage = async ({ data }) => {
  const { phase, device } = data; phaseCorrection = data.phaseCorrection === true;
  try {
    const details = phase === 'normal' ? await normal(device) : phase === 'offline-restart' ? await offlineRestart(device)
      : phase === 'corrupt-recover' ? await corruptAndRecover(device) : phase === 'device-loss' ? await deviceLoss() : null;
    assert(details, 'Unknown lifecycle phase.');
    const state = await cleanup(); assert(!validationErrors.length, `Unexpected GPU validation failures: ${validationErrors.join('; ')}`);
    self.postMessage({ status: 'pass', phase, device, phaseCorrection, transformedModels: backends.map(backend => backend.modelInfo).filter(Boolean), details, resources: state, downloads, progress, validationErrors });
  } catch (error) {
    let cleanupFailure;
    try { await cleanup(); } catch (failure) { cleanupFailure = failure.message; }
    self.postMessage({ status: 'fail', phase, device, failure: `${error.name}: ${error.message}`, stack: error.stack,
      cleanupFailure, resources: resources(), downloads, progress, validationErrors });
  }
};
