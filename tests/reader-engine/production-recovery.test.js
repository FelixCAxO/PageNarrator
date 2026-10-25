import { expect, it, vi } from 'vitest';
import { createVoiceModelLoader } from '../../src/lib/voice-model.js';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';

const backendPlan = { device: 'webgpu', dtype: 'fp32' };

it('loads a healthy model once without announcing a fallback', async () => {
  const model = { dispose: vi.fn() };
  const loadKokoro = vi.fn(async () => model);
  const onFallback = vi.fn();
  const onError = vi.fn();
  const ensure = createVoiceModelLoader({ loadKokoro });
  expect(await ensure({ backendPlan, onFallback, onError })).toBe(model);
  expect(await ensure({ backendPlan, onFallback, onError })).toBe(model);
  expect(loadKokoro).toHaveBeenCalledOnce();
  expect(onFallback).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  await ensure.releaseVoiceModel();
  expect(model.dispose).toHaveBeenCalledOnce();
});

it('disposes failed GPU warmup before one WASM fallback and retains the recovered model', async () => {
  const order = [];
  const failed = { warmup: async () => { throw new Error('GPUDevice lost'); }, dispose: vi.fn(() => order.push('dispose-gpu')) };
  const recovered = { warmup: vi.fn(), dispose: vi.fn() };
  const loadKokoro = vi.fn(async (_id, { device }) => {
    order.push(device);
    return device === 'webgpu' ? failed : recovered;
  });
  const onError = vi.fn();
  const ensure = createVoiceModelLoader({ loadKokoro });
  expect(await ensure({ backendPlan, warmupVoice: 'af_heart', onError,
    onFallback: (_error, plan) => order.push(`fallback-${plan.device}`),
    onReady: () => order.push('ready'),
  })).toBe(recovered);
  expect(order).toEqual(['webgpu', 'dispose-gpu', 'fallback-wasm', 'wasm', 'ready']);
  expect(await ensure({ backendPlan })).toBe(recovered);
  expect(loadKokoro).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
  await ensure.releaseVoiceModel();
  expect(failed.dispose).toHaveBeenCalledOnce();
  expect(recovered.dispose).toHaveBeenCalledOnce();
});

it('stops after both backends fail, reports one terminal error, and permits an explicit retry', async () => {
  const loadKokoro = vi.fn(async () => { throw new Error('backend unavailable'); });
  const onFallback = vi.fn();
  const onError = vi.fn();
  const onReady = vi.fn();
  const ensure = createVoiceModelLoader({ loadKokoro });
  await expect(ensure({ backendPlan, onFallback, onError, onReady })).rejects.toMatchObject({ code: 'voice_model_load_failed' });
  expect(loadKokoro.mock.calls.map(([, options]) => options.device)).toEqual(['webgpu', 'wasm']);
  expect(onFallback).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledOnce();
  expect(onReady).not.toHaveBeenCalled();
  const recovered = {};
  loadKokoro.mockResolvedValue(recovered);
  expect(await ensure({ backendPlan, onReady })).toBe(recovered);
  expect(loadKokoro).toHaveBeenCalledTimes(3);
  expect(onReady).toHaveBeenCalledOnce();
});

function kokoroRead() {
  const state = {};
  const states = [];
  const readRunTracker = createReadRunTracker();
  const dependencies = {
    state, readRunTracker,
    setReadingState: (next, details) => { state.readingState = next; states.push({ state: next, ...details }); },
    extractActiveTab: async () => ({ tabId: 3, url: 'https://example.test/article', source: 'article',
      text: 'This article has a complete sentence for the built-in voice to narrate.',
      chunks: [{ speech: 'This article has a complete sentence for the built-in voice to narrate.' }] }),
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
    resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro', detectCode: 'en' }),
    ensureModel: vi.fn(async () => {}),
    ensureSpeechPreloadWindow: vi.fn(() => Promise.resolve(null)),
    readPreloadedSpeech: vi.fn(async () => ({ blob: new Blob(['audio']) })),
    playKokoroSpeech: vi.fn(async () => {}),
    clearActiveSpeechPreloads: vi.fn(), clearCurrentAudioEventListeners: vi.fn(),
    releasePlaybackAudioPool: vi.fn(), releaseLoadedVoiceModel: vi.fn(async () => false),
    saveResumeChunk: vi.fn(async () => {}),
  };
  return { dependencies, state, states, readRunTracker };
}

it.each(['ensureModel', 'readPreloadedSpeech'])('terminates %s failure without changing voices, advancing the cursor or retrying', async (boundary) => {
  const { dependencies, state, states } = kokoroRead();
  dependencies[boundary].mockRejectedValue(Object.assign(new Error('Voice preparation unavailable'), { code: 'PN_TTS_GENERATION_FAILED' }));
  await createReadLoopOrchestrator(dependencies).readPage();
  expect(dependencies[boundary]).toHaveBeenCalledOnce();
  expect(states.at(-1)).toMatchObject({ state: 'error', message: 'Voice preparation unavailable', errorCode: 'PN_TTS_GENERATION_FAILED' });
  expect(dependencies.playKokoroSpeech).not.toHaveBeenCalled();
  expect(dependencies.saveResumeChunk).not.toHaveBeenCalled();
  expect(state.currentChunk).toBe(0);
  for (const cleanup of ['clearActiveSpeechPreloads', 'clearCurrentAudioEventListeners', 'releasePlaybackAudioPool', 'releaseLoadedVoiceModel']) {
    expect(dependencies[cleanup]).toHaveBeenCalledOnce();
  }
});

it('aborts pending speech preload without retry, fallback, playback or an error state', async () => {
  const { dependencies, state, states, readRunTracker } = kokoroRead();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  dependencies.readPreloadedSpeech.mockImplementation((_preload, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    entered();
  }));
  const read = createReadLoopOrchestrator(dependencies).readPage();
  await started;
  readRunTracker.abortCurrentRun();
  await read;
  expect(state.readingState).toBe('idle');
  expect(states.some(({ state: next }) => next === 'error')).toBe(false);
  expect(dependencies.ensureModel).toHaveBeenCalledOnce();
  expect(dependencies.readPreloadedSpeech).toHaveBeenCalledOnce();
  expect(dependencies.saveResumeChunk).not.toHaveBeenCalled();
  expect(dependencies.clearActiveSpeechPreloads).toHaveBeenCalledOnce();
  expect(dependencies.releaseLoadedVoiceModel).toHaveBeenCalledOnce();
});
