import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';
import { createReaderEngineReadControlsController } from '../../src/lib/reader-engine-read-controls-controller.js';
import { createReaderEngineVoiceRuntimeController } from '../../src/lib/reader-engine-voice-runtime-controller.js';
import { createVoiceModelLoader } from '../../src/lib/voice-model.js';
import { createKokoroDataLoader } from '../../src/tts/kokoro/data-loader.js';

it('Stop cancels the real setup download, settles the read, and permits a clean retry', async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4), cancel = vi.fn(), signals = [];
  const manifest = { modelId: 'fixture', revision: 'pinned', files: [{ path: 'weights.bin', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const fetcher = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(bytes.slice(0, 2)); }, cancel,
  }))).mockImplementation(async () => new Response(bytes));
  const model = { warmup: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const loader = createVoiceModelLoader({ loadKokoro: async (_id, { signal, progress_callback }) => {
    signals.push(signal);
    await createKokoroDataLoader({ manifest, fetcher, cacheStorage: null, signal, onProgress: progress_callback })('weights.bin');
    return model;
  } });
  const state = { readingState: 'idle', tts: null };
  const voice = { id: 'af_heart', engine: 'kokoro', lang: 'en-US', detectCode: 'en' };
  const plan = { device: 'wasm', dtype: 'q8' };
  const runtime = createReaderEngineVoiceRuntimeController({ state, documentRef: {}, resolveSelectedVoice: () => voice,
    ttsService: { prepareRuntime: async () => ({ preferredBackend: 'wasm', backendPlan: plan }) },
    voiceRegistry: { configureOnnxRuntime: async () => {}, ensureVoiceModel: loader, releaseVoiceModel: loader.releaseVoiceModel } });
  const readRunTracker = createReadRunTracker(), states = [];
  const setReadingState = value => { state.readingState = value; states.push(value); };
  const reader = createReadLoopOrchestrator({ state, readRunTracker, setReadingState,
    prepareTtsBackendPlanForChunking: runtime.prepareTtsBackendPlanForChunking,
    ensureModel: runtime.ensureModel, resolveSelectedVoice: () => voice,
    extractActiveTab: async () => ({ tabId: 1, url: 'https://example.test/', source: 'html', text: 'Hello world.', chunks: [{ speech: 'Hello world.' }] }),
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 320, targetMinLength: 180, preloadAhead: 0 }),
    ensureSpeechPreloadWindow: () => Promise.resolve({ result: {} }), readPreloadedSpeech: async () => ({}),
  });
  const controls = createReaderEngineReadControlsController({ state, readRunTracker, setReadingState,
    clearPageHighlight: async () => {}, clearActiveSpeechPreloads: () => {} });
  state.activeReadPromise = reader.readPage();
  await vi.waitFor(() => expect(state.modelSetupState?.detail).toContain('0.0 / 0.0 MB'));
  await controls.stopReading();
  expect(state.readingState).toBe('idle');
  expect(state.modelSetupState).toEqual({ phase: 'idle' });
  expect(signals[0].aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.tts).toBeNull();
  expect(states).not.toContain('reading');
  await reader.readPage();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state.readingState).toBe('finished');
  expect(state.tts).toBe(model);
  await runtime.releaseLoadedVoiceModel({ force: true });
});

it('ignores late setup callbacks from a cancelled session', async () => {
  const controller = new AbortController();
  let oldCallbacks;
  const registry = { configureOnnxRuntime: async () => {}, ensureVoiceModel: vi.fn(options => {
    oldCallbacks = options;
    return new Promise(() => {});
  }) };
  const state = {};
  const runtime = createReaderEngineVoiceRuntimeController({ state, voiceRegistry: registry,
    ttsService: { prepareRuntime: async () => ({ preferredBackend: 'wasm', backendPlan: { device: 'wasm' } }) } });
  const old = runtime.ensureModel({ signal: controller.signal });
  await vi.waitFor(() => expect(oldCallbacks).toBeDefined());
  controller.abort();
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  state.modelSetupState = { phase: 'ready' };
  oldCallbacks.onStart({ device: 'webgpu' });
  oldCallbacks.onProgress({ status: 'progress', progress: 50 });
  oldCallbacks.onError(new Error('late error'));
  oldCallbacks.onReady();
  expect(state.modelSetupState).toEqual({ phase: 'ready' });
  expect(state.tts).toBeUndefined();
});

it('waits for cancelled warmup cleanup before retrying without inheriting the old abort', async () => {
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const partial = { warmup: vi.fn(() => new Promise(() => {})), dispose: vi.fn(() => cleanup) };
  const fresh = { warmup: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const loadKokoro = vi.fn().mockResolvedValueOnce(partial).mockResolvedValue(fresh);
  const loader = createVoiceModelLoader({ loadKokoro });
  const plan = { device: 'wasm', dtype: 'q8' }, state = {};
  const runtime = createReaderEngineVoiceRuntimeController({ state,
    ttsService: { prepareRuntime: async () => ({ preferredBackend: 'wasm', backendPlan: plan }) },
    voiceRegistry: { configureOnnxRuntime: async () => {}, ensureVoiceModel: loader, releaseVoiceModel: loader.releaseVoiceModel } });
  const cancelled = new AbortController();
  const loading = runtime.ensureModel({ warmupVoice: 'af_heart', signal: cancelled.signal });
  await vi.waitFor(() => expect(partial.warmup).toHaveBeenCalledOnce());
  cancelled.abort();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(partial.dispose).toHaveBeenCalledOnce());
  const retry = runtime.ensureModel({ warmupVoice: 'af_heart', signal: new AbortController().signal });
  expect(loadKokoro).toHaveBeenCalledOnce();
  finishCleanup();
  await expect(retry).resolves.toBe(fresh);
  expect(loadKokoro).toHaveBeenCalledTimes(2);
  expect(state.tts).toBe(fresh);
  expect(state.modelSetupState).toEqual({ phase: 'ready' });
  await runtime.releaseLoadedVoiceModel({ force: true });
});
