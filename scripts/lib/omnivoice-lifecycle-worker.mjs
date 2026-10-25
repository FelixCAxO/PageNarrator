// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only lifecycle proof: original runtime, original inference, retained pinned data.
import * as inference from '../../src/engines/browser-inference.js';
import { BytePairTokenizer } from '../../src/engines/bytepair-tokenizer.js';
import { createOmniVoiceRuntime } from '../../src/tts/omnivoice/runtime.js';
import { createOmniVoiceDataFetch } from '../../src/tts/omnivoice/data-loader.js';
import { OMNIVOICE_DATA } from '../../src/tts/omnivoice/model-data.js';
import { loadBundledRuntime } from '../../src/tts/omnivoice/loader.js';

const base = `https://huggingface.co/${OMNIVOICE_DATA.modelId}/resolve/${OMNIVOICE_DATA.revision}`;
const nativeFetch = fetch.bind(globalThis), requests = [], engines = [], sessions = [], runtimes = [], validationErrors = [];
const request = { text: 'The garden gate is open. Please bring the blue book.', lang: 'en', instruct: '', speed: 1, seed: 42, numStep: 24 };
let offline = false, corruptDownload = false, onRunStart = null, mainCalls = 0;
let integratedLoader = false;
const assert = (value, message) => { if (!value) throw new Error(message); };
const download = async (url, options) => {
  if (!String(url).startsWith(`${base}/`)) return nativeFetch(url, options);
  assert(url.startsWith(`${base}/`), 'Unpinned model origin.'); const path = url.slice(base.length + 1);
  assert(OMNIVOICE_DATA.files.some(file => file.path === path), 'Unpinned model file.'); requests.push({ path, blocked: offline });
  if (offline) throw new Error('Model downloads deliberately unavailable offline.');
  if (corruptDownload && path === 'omnivoice-main-kv-fp16-b1.onnx') return new Response(Uint8Array.of(1, 2, 3));
  return nativeFetch(new URL(`/data/${path}`, location.href), options);
};
const fetchData = createOmniVoiceDataFetch({ fetcher: download });
const createSession = inference.InferenceSession.create.bind(inference.InferenceSession);
const adapter = { Tensor: inference.Tensor, InferenceSession: { async create(source, options) {
  const session = await createSession(source, { ...options, maxCachedPlans: 2 });
  sessions.push(session); const engine = session.session.engine; engines.push(engine);
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  const run = session.run.bind(session);
  session.run = (feeds, outputs) => {
    if (feeds.input_ids) {
      mainCalls++; const length = feeds.input_ids.dims[2];
      assert(feeds.attention_mask.dims.join(',') === `1,1,${length},${length}` && feeds.attention_mask.data.every(n => n === 1), 'Main inference lost full bidirectional attention.');
      const callback = onRunStart; onRunStart = null; callback?.();
    }
    return run(feeds, outputs);
  };
  return session;
} } };
async function open() {
  if (integratedLoader) {
    const runtime = await loadBundledRuntime(); runtimes.push(runtime); await runtime.init(base); return runtime;
  }
  const json = async name => (await fetchData(`${base}/${name}`)).json();
  const tokenizer = new BytePairTokenizer(...await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(json)));
  const runtime = createOmniVoiceRuntime({ ort: adapter, decoderRuntime: adapter, tokenizer, fetch: fetchData });
  runtimes.push(runtime); await runtime.init(base); return runtime;
}
async function audio(runtime) {
  const before = mainCalls, value = await runtime.synthesize(request);
  assert(mainCalls - before === 48, 'Diffusion must execute both full main graphs on all 24 steps.');
  assert(value.sampleRate === 24000 && value.pcm.length > 100 && value.pcm.every(Number.isFinite), 'Invalid synthesized audio.');
  let sum = 0; for (const n of value.pcm) sum += n * n; assert(sum > .001, 'Silent synthesized audio.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value.pcm));
  return { samples: value.pcm.length, pcmSha256: Array.from(digest, n => n.toString(16).padStart(2, '0')).join('') };
}
async function rejected(promise, pattern) {
  try { await promise; } catch (error) { assert(pattern.test(`${error.name}: ${error.message}`), `Unexpected failure: ${error}`); return String(error); }
  throw new Error('Expected operation to reject.');
}
async function phase(name) {
  if (name === 'offline-restart') {
    offline = true; const runtime = await open(), result = await audio(runtime); await runtime.dispose();
    assert(requests.length === 0, 'Offline verified cache attempted downloads.'); return result;
  }
  if (name === 'corrupt-recover') {
    const cache = await caches.open('pagenarrator-omnivoice-v1'), graph = `${base}/omnivoice-main-kv-fp16-b1.onnx`, config = `${base}/tokenizer_config.json`;
    const bytes = new Uint8Array(await (await cache.match(config)).arrayBuffer()); bytes[0] ^= 1;
    await cache.put(graph, new Response(Uint8Array.of(1, 2, 3))); await cache.put(config, new Response(bytes));
    offline = true; await rejected(open(), /offline/); assert(sessions.length === 0, 'Corrupt preparation allocated inference.');
    offline = false; const runtime = await open(), result = await audio(runtime); await runtime.dispose();
    const downloaded = requests.filter(item => !item.blocked).map(item => item.path).sort();
    assert(downloaded.join() === ['omnivoice-main-kv-fp16-b1.onnx', 'tokenizer_config.json'].sort().join(), 'Recovery downloaded unexpected data.'); return result;
  }
  if (name === 'corrupt-download') {
    const cache = await caches.open('pagenarrator-omnivoice-v1'), graph = `${base}/omnivoice-main-kv-fp16-b1.onnx`;
    await cache.delete(graph); corruptDownload = true; await rejected(open(), /size|hash/);
    assert(!await cache.match(graph), 'Corrupt download entered the cache.'); corruptDownload = false;
    const runtime = await open(), result = await audio(runtime); await runtime.dispose(); return result;
  }
  const runtime = await open(), first = await audio(runtime);
  if (name === 'device-loss') {
    const engine = engines[0]; engine.device.destroy(); await engine.device.lost; await runtime.dispose();
    offline = true; const recovered = await open(), result = await audio(recovered); await recovered.dispose();
    assert(requests.length === 0, 'Device-loss reopening downloaded verified data.'); return { first, recovered: result, recovery: 'Explicit disposal and fresh runtime; no automatic recovery claim.' };
  }
  if (name === 'repeated-open') {
    await runtime.dispose(); for (let i = 0; i < 2; i++) { const next = await open(); assert((await audio(next)).pcmSha256 === first.pcmSha256, 'Repeated opening changed fixed PCM.'); await next.dispose(); } return first;
  }
  let pending = runtime.synthesize(request); await rejected(runtime.synthesize(request), /already running/); await pending;
  onRunStart = () => runtime.abortGeneration(); await rejected(runtime.synthesize(request), /AbortError|stopped/);
  assert((await audio(runtime)).pcmSha256 === first.pcmSha256, 'Cancellation recovery changed fixed PCM.');
  let disposal; onRunStart = () => { disposal = runtime.dispose(); }; pending = runtime.synthesize(request);
  await rejected(pending, /AbortError|stopped/); assert(disposal, 'Disposal did not overlap active main inference.'); await disposal;
  await rejected(runtime.synthesize(request), /disposed/); return first;
}
self.onmessage = async ({ data: { phase: name, integrated } }) => {
  let result, failure;
  integratedLoader = integrated;
  if (integrated) { globalThis.fetch = download; inference.InferenceSession.create = adapter.InferenceSession.create; }
  const gpuAdapter = await navigator.gpu.requestAdapter(), info = gpuAdapter?.info;
  try { result = await phase(name); } catch (error) { failure = String(error.stack || error); }
  const cleanup = await Promise.allSettled(runtimes.map(runtime => runtime.dispose()));
  const resourceCleanup = engines.every(engine => engine.closed && engine.buffers.size === 0 && engine.tensors.size === 0)
    && sessions.every(session => session.session.model === null) && cleanup.every(item => item.status === 'fulfilled');
  self.postMessage({ phase: name, status: !failure && resourceCleanup && !validationErrors.length ? 'pass' : 'fail', result, failure,
    resourceCleanup, validationErrors, downloads: requests, mainCalls,
    adapter: info ? { vendor: info.vendor, architecture: info.architecture, isFallbackAdapter: info.isFallbackAdapter } : null });
};
