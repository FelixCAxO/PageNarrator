import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKokoroWorkerBackend } from '../../src/tts/kokoro/worker-client.js';
import { installKokoroWorker } from '../../src/tts/kokoro/worker-host.js';
import { createPageNarratorKokoroTts } from '../../src/lib/kokoro-multilingual.js';

const audio = () => ({ audio: Float32Array.of(0.1, 0.2), sampling_rate: 24000, phonemes: 'a' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(overrides = {}, options = {}) {
  const backend = { voices: { af_heart: { language: 'en-us' } }, modelInfo: { modifiedSha256: 'corrected' },
    prepareVoice: vi.fn(async () => ({ prepared: true })), generate: vi.fn(async () => audio()),
    generate_from_ids: vi.fn(async () => audio()), tokenizer: vi.fn(() => ({ input_ids: BigInt64Array.of(0n, 43n, 0n) })),
    stream: vi.fn(async function* (text) { yield { text, phonemes: 'a', audio: audio() }; }), dispose: vi.fn(), ...overrides };
  const workers = [], scopes = [];
  const loadBackend = vi.fn(async () => backend), progress_callback = vi.fn();
  function createWorker() {
    const scope = { postMessage: vi.fn((message, transfer) => {
      const data = structuredClone(message, { transfer }); queueMicrotask(() => { if (!worker.terminated) worker.onmessage({ data }); });
    }) };
    const worker = { terminated: false, terminate: vi.fn(() => { worker.terminated = true; }), postMessage: vi.fn((message, transfer = []) => {
      const data = structuredClone(message, { transfer }); queueMicrotask(() => { if (!worker.terminated) scope.onmessage({ data }); });
    }) };
    installKokoroWorker(scope, { loadBackend }); workers.push(worker); scopes.push(scope); return worker;
  }
  const tts = await createKokoroWorkerBackend('model', { device: 'webgpu', dtype: 'fp32', progress_callback,
    runtime: { getURL: path => `chrome-extension://test/${path}` }, createWorker, ...options });
  const worker = workers[0], scope = scopes[0];
  return { tts, worker, workers, scope, backend, loadBackend, progress_callback };
}

describe('original Kokoro worker transport', () => {
  afterEach(() => vi.useRealTimers());
  it('retires a GPU operation that never responds after abort, rejects queued work, and reopens for a new read', async () => {
    const { tts, backend, workers } = await setup({ generate: vi.fn(() => new Promise(() => {})) }, { shutdownMs: 100 });
    const controller = new AbortController();
    const old = tts.generate('old', { signal: controller.signal });
    await vi.waitFor(() => expect(backend.generate).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    controller.abort();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const queued = expect(tts.generate('queued')).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100);
    await queued;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    backend.generate.mockResolvedValue(audio());
    await expect(tts.generate('fresh')).resolves.toHaveProperty('sampling_rate', 24000);
    expect(workers).toHaveLength(2);
    await tts.dispose();
  });

  it('bounds disposal through the app wrapper even if inference never settles', async () => {
    const { tts: workerTts, backend, worker } = await setup({ generate: vi.fn(() => new Promise(() => {})) }, { shutdownMs: 100 });
    const tts = createPageNarratorKokoroTts(workerTts, { device: 'webgpu' });
    const speech = expect(tts.generate('stalled')).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(backend.generate).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const disposal = tts.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await disposal;
    await speech;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates a cancelled initial worker load without waiting for an init response', async () => {
    const controller = new AbortController(), worker = { postMessage: vi.fn(), terminate: vi.fn() };
    const loading = createKokoroWorkerBackend('model', { runtime: { getURL: () => 'chrome-extension://test/' }, createWorker: () => worker, signal: controller.signal });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('initializes the phase-corrected packaged engine and transfers owned audio, never caller token storage', async () => {
    const { tts, backend, loadBackend } = await setup({}, { device: 'wasm', dtype: 'q8' });
    expect(loadBackend).toHaveBeenCalledWith('model', expect.objectContaining({ device: 'wasm', dtype: 'q8', phaseCorrection: true }));
    expect(tts.modelInfo.modifiedSha256).toBe('corrected');
    const ids = BigInt64Array.of(0n, 43n, 0n);
    expect((await tts.generate_from_ids(ids)).audio).toEqual(Float32Array.of(0.1, 0.2));
    expect(ids).toEqual(BigInt64Array.of(0n, 43n, 0n));
    expect(backend.generate_from_ids.mock.calls[0][0]).toEqual(ids);
    await tts.dispose();
  });
  it('pulls one source-associated chunk at a time and closes a partially consumed iterator', async () => {
    const closed = vi.fn();
    const { tts, backend } = await setup({ stream: vi.fn(async function* (text) {
      try { yield { text, audio: audio() }; yield { text: 'second', audio: audio() }; } finally { closed(); }
    }) });
    const stream = tts.stream('First sentence.', { split_pattern: /\./ });
    expect(backend.stream).not.toHaveBeenCalled();
    expect((await stream.next()).value.text).toBe('First sentence.');
    await stream.return(); expect(closed).toHaveBeenCalledOnce();
    await tts.dispose();
  });
  it('rejects an active abort promptly but serializes the next call and disposal after native cleanup', async () => {
    const native = deferred(), events = [];
    const { tts, backend, worker } = await setup({ generate: vi.fn(async (text, { signal }) => {
      events.push(`start:${text}`);
      if (text === 'old') { await native.promise; expect(signal.aborted).toBe(true); }
      events.push(`end:${text}`); return audio();
    }) });
    const controller = new AbortController();
    const old = tts.generate('old', { signal: controller.signal });
    await vi.waitFor(() => expect(events).toEqual(['start:old']));
    controller.abort(); await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const next = tts.generate('new'); const stopped = tts.dispose();
    expect(tts.dispose()).toBe(stopped); expect(worker.terminate).not.toHaveBeenCalled();
    native.resolve(); await next; await stopped;
    expect(events).toEqual(['start:old', 'end:old', 'start:new', 'end:new']);
    expect(backend.dispose).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('aborts streaming without waiting for a native operation and eventually closes its iterator', async () => {
    const native = deferred(), closed = vi.fn();
    const { tts, backend } = await setup({ stream: vi.fn(async function* () {
      try { await native.promise; yield { text: 'late', audio: audio() }; } finally { closed(); }
    }) });
    const controller = new AbortController(), stream = tts.stream('text', { signal: controller.signal });
    const request = stream.next(); await vi.waitFor(() => expect(backend.stream).toHaveBeenCalledOnce());
    controller.abort(); await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const disposed = tts.dispose(); native.resolve(); await disposed; expect(closed).toHaveBeenCalledOnce();
  });
  it('does not execute queued aborted inference and preserves voice-style error classification', async () => {
    const native = deferred();
    const { tts, backend } = await setup({ generate: vi.fn(async () => { await native.promise; return audio(); }),
      prepareVoice: vi.fn(async () => { throw Object.assign(new Error('Bad pinned style'), { code: 'voice_style_download_failed' }); }) });
    const first = tts.generate('one'), controller = new AbortController();
    const queued = tts.generate('two', { signal: controller.signal });
    controller.abort(); await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    native.resolve(); await first;
    await expect(tts.prepareVoice('af_heart')).rejects.toMatchObject({ code: 'voice_style_download_failed', message: 'Bad pinned style' });
    expect(backend.generate).toHaveBeenCalledOnce(); await tts.dispose();
  });
  it('keeps GPU warmup and one-use opening speech caching in the existing app wrapper', async () => {
    const { tts: workerTts, backend } = await setup();
    const tts = createPageNarratorKokoroTts(workerTts, { device: 'webgpu' });
    await expect(tts.warmup({ voice: 'af_heart', speechText: 'Opening.' })).resolves.toMatchObject({ warmed: true });
    const first = await tts.generate('Opening.'); expect(first.fromWarmup).toBe(true);
    expect(backend.generate).toHaveBeenCalledOnce();
    await tts.generate('Opening.'); expect(backend.generate).toHaveBeenCalledTimes(2);
    await tts.dispose();
  });
  it('warmups without opening text tokenize inside the worker and validate the returned samples', async () => {
    const { tts: workerTts, backend } = await setup();
    const tts = createPageNarratorKokoroTts(workerTts, { device: 'webgpu' });
    await expect(tts.warmup({ voice: 'af_heart' })).resolves.toMatchObject({ warmed: true });
    expect(backend.tokenizer).toHaveBeenCalledWith('a', { truncation: true });
    expect(backend.generate_from_ids).toHaveBeenCalledOnce(); await tts.dispose();
  });
  it('forwards active abort signals through the existing app wrapper', async () => {
    const controller = new AbortController(), seen = [];
    const tts = createPageNarratorKokoroTts({ prepareVoice: async () => {}, generate: async (_, options) => { seen.push(options.signal); return audio(); },
      async *stream(_, options) { seen.push(options.signal); yield { text: 'a', audio: audio() }; } });
    await tts.generate('a', { signal: controller.signal });
    for await (const _ of tts.stream('a', { signal: controller.signal })) { /* Drain the source iterator. */ }
    expect(seen).toEqual([controller.signal, controller.signal]); await tts.dispose();
  });
  it('terminates active CPU work, rejects queued RPCs, then lazily recreates the verified engine', async () => {
    const native = deferred();
    const { tts, worker, workers, backend, loadBackend } = await setup({ generate: vi.fn(async text => {
      if (text === 'old') await native.promise; return audio();
    }) }, { device: 'wasm', dtype: 'q8' });
    const controller = new AbortController(), old = tts.generate('old', { signal: controller.signal });
    await vi.waitFor(() => expect(backend.generate).toHaveBeenCalledOnce());
    const queued = tts.generate('queued'); const queuedRejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); await Promise.resolve();
    controller.abort(); await expect(old).rejects.toMatchObject({ name: 'AbortError' }); await queuedRejection;
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(workers).toHaveLength(1);
    expect((await tts.generate('resumed')).audio.length).toBe(2);
    expect(workers).toHaveLength(2); expect(loadBackend).toHaveBeenCalledTimes(2);
    native.resolve(); await tts.dispose(); expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
  it('CPU app disposal terminates an active native call instead of waiting for synchronous WASM', async () => {
    const native = deferred();
    const { tts: base, worker, backend } = await setup({ generate: vi.fn(async () => { await native.promise; return audio(); }) }, { device: 'wasm', dtype: 'q8' });
    const tts = createPageNarratorKokoroTts(base, { device: 'wasm' });
    const active = tts.generate('old'); const failed = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(backend.generate).toHaveBeenCalledOnce());
    await tts.dispose(); await failed; expect(worker.terminate).toHaveBeenCalledOnce(); native.resolve();
  });
  it('removes cancellation listeners before delivering completed CPU audio', async () => {
    const { tts, worker, workers } = await setup({}, { device: 'wasm', dtype: 'q8' });
    const controller = new AbortController();
    await tts.generate('finished', { signal: controller.signal }); controller.abort();
    expect(worker.terminate).not.toHaveBeenCalled();
    await tts.generate('again'); expect(workers).toHaveLength(1); await tts.dispose();
  });
  it('rejects pending work and terminates exactly once on a worker crash', async () => {
    const native = deferred();
    const { tts, worker } = await setup({ generate: vi.fn(async () => { await native.promise; return audio(); }) });
    const request = tts.generate('one'); worker.onerror({ message: 'Device failed' });
    await expect(request).rejects.toThrow('Device failed'); await tts.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce(); await expect(tts.generate('again')).rejects.toThrow('closed'); native.resolve();
  });
});
