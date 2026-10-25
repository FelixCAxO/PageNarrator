import { describe, expect, it, vi } from 'vitest';
import { createPageNarratorKokoroTts } from '../../src/lib/kokoro-multilingual.js';
import { createVoiceModelLoader } from '../../src/lib/voice-model.js';
import { synthesizeSpeechChunk, synthesizeSpeechSegments } from '../../src/lib/speech-audio.js';
import { createReaderEngineSpeechPreloadController } from '../../src/lib/reader-engine-speech-preload-controller.js';
import { clearSpeechPreloadState } from '../../src/lib/reader-engine-read-lifecycle.js';
import { cacheKokoroVoiceStyle } from '../../src/lib/voice-registry.js';

it('fallback streaming retains closing quotes without a punctuation-only native call', async () => {
  const generate = vi.fn(async () => ({ audio: new Float32Array(24), sampling_rate: 24000 }));
  const tts = createPageNarratorKokoroTts({ generate }, { runtime: null });
  const segments = [];
  for await (const segment of tts.stream('“The woodland remains quiet.”')) segments.push(segment);
  expect(segments.map(segment => segment.text)).toEqual(['“The woodland remains quiet.”']);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][0]).toBe('“The woodland remains quiet.”');
  await tts.dispose();
});

vi.mock('../../src/lib/voice-registry.js', async (importOriginal) => ({
  ...await importOriginal(), cacheKokoroVoiceStyle: vi.fn(async () => {}),
}));

describe('Kokoro wrapper', () => {
  it('uses the original backend style verifier before synthesis instead of the retired cache bridge', async () => {
    const before = cacheKokoroVoiceStyle.mock.calls.length;
    const prepareVoice = vi.fn(async () => ({ prepared: true })), generate = vi.fn(async () => ({ audio: [1] }));
    const tts = createPageNarratorKokoroTts({ prepareVoice, generate }, { runtime: null });
    await tts.generate('one', { voice: 'af_heart' });
    expect(prepareVoice).toHaveBeenCalledExactlyOnceWith('af_heart'); expect(generate).toHaveBeenCalledTimes(1);
    expect(cacheKokoroVoiceStyle.mock.calls.length).toBe(before); await tts.dispose();
  });
  it.each(['generate', 'stream'])('warms the GPU with real opening speech and reuses it once through %s', async (method) => {
    const audio = { audio: new Float32Array([0, 0.1, 0]), sampling_rate: 24000, phonemes: 'opening' };
    const baseTts = { tokenizer: vi.fn(), generate_from_ids: vi.fn(), generate: vi.fn(async () => audio) };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });
    await expect(tts.warmup({ voice: 'af_heart', speechText: 'Opening heading' })).resolves.toMatchObject({ warmed: true });
    expect(baseTts.generate).toHaveBeenCalledExactlyOnceWith('Opening heading', { voice: 'af_heart', speed: 1 });
    expect(baseTts.tokenizer).not.toHaveBeenCalled();
    expect(baseTts.generate_from_ids).not.toHaveBeenCalled();
    if (method === 'generate') await expect(tts.generate('Opening heading')).resolves.toBe(audio);
    else {
      const stream = tts.stream('Opening heading');
      await expect(stream.next()).resolves.toMatchObject({ value: { text: 'Opening heading', phonemes: 'opening', audio, fromWarmup: true } });
      await expect(stream.next()).resolves.toMatchObject({ done: true });
    }
    expect(baseTts.generate).toHaveBeenCalledTimes(1);
    await tts.generate('Opening heading');
    expect(baseTts.generate).toHaveBeenCalledTimes(2);
  });

  it.each([{ text: 'Different section' }, { voice: 'am_michael' }, { speed: 2 }])('never reuses opening audio for a mismatched request: %j', async (override) => {
    const audio = { audio: new Float32Array([0.1]), sampling_rate: 24000 };
    const baseTts = { tokenizer: vi.fn(), generate_from_ids: vi.fn(), generate: vi.fn(async () => audio) };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });
    await tts.warmup({ voice: 'af_heart', speechText: 'Opening heading' });
    await tts.generate(override.text || 'Opening heading', override);
    await tts.generate('Opening heading');
    expect(baseTts.generate).toHaveBeenCalledTimes(3);
  });

  it('keeps the GPU fallback when real opening warmup audio is invalid', async () => {
    const dispose = vi.fn();
    const loadKokoro = vi.fn(async (_, { device }) => createPageNarratorKokoroTts({
      tokenizer: vi.fn(), generate_from_ids: vi.fn(),
      generate: vi.fn(async () => ({ audio: Float32Array.of(device === 'webgpu' ? NaN : 0.1), sampling_rate: 24000 })),
      dispose,
    }, { runtime: null, device }));
    const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro });
    const onFallback = vi.fn();
    const tts = await ensure({ warmupVoice: 'af_heart', warmupText: 'Opening heading', backendPlan: { device: 'webgpu', dtype: 'fp32' }, onFallback });
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'voice_model_warmup_failed' }), expect.objectContaining({ device: 'wasm' }));
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(tts.generate('Opening heading')).resolves.toMatchObject({ audio: Float32Array.of(0.1) });
  });

  it('prepares CPU voice data without running a throwaway inference before real speech', async () => {
    const audio = { audio: new Float32Array([0, 0.1, 0]), sampling_rate: 24000 };
    const baseTts = { tokenizer: vi.fn(() => ({ input_ids: [1] })),
      generate_from_ids: vi.fn(async () => audio), generate: vi.fn(async () => audio) };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null, device: 'wasm' });
    const preparations = cacheKokoroVoiceStyle.mock.calls.length;
    cacheKokoroVoiceStyle.mockRejectedValueOnce(Object.assign(new Error('Missing voice data'), { code: 'voice_style_download_failed' }));
    await expect(tts.warmup({ voice: 'af_heart' })).rejects.toMatchObject({ code: 'voice_style_download_failed' });
    await expect(tts.warmup({ voice: 'af_heart' })).resolves.toMatchObject({ warmed: false, voice: 'af_heart' });
    expect(cacheKokoroVoiceStyle.mock.calls.length).toBe(preparations + 2);
    expect(baseTts.tokenizer).not.toHaveBeenCalled();
    expect(baseTts.generate_from_ids).not.toHaveBeenCalled();
    await expect(tts.generate('Real opening heading')).resolves.toBe(audio);
    expect(baseTts.generate).toHaveBeenCalledExactlyOnceWith('Real opening heading', { voice: 'af_heart', speed: 1 });
  });

  it('rejects retired requests before preparing voice styles', async () => {
    const tts = createPageNarratorKokoroTts({}, { runtime: null });
    await tts.dispose();
    const preparationCalls = cacheKokoroVoiceStyle.mock.calls.length;
    const results = await Promise.allSettled([
      tts.generate('new', { voice: 'af_heart' }),
      tts.generate_from_ids([1], { voice: 'af_heart' }),
      tts.stream('new', { voice: 'af_heart' }).next(),
      tts.warmup({ voice: 'af_heart' }),
    ]);
    expect(results.every(({ status, reason }) => status === 'rejected' && reason.message.includes('disposed'))).toBe(true);
    expect(cacheKokoroVoiceStyle.mock.calls.length).toBe(preparationCalls);
  });

  it.each(['generate', 'generate_from_ids', 'stream'])('rejects already-aborted %s requests before preparing voice styles', async (method) => {
    const signal = new AbortController();
    signal.abort();
    const tts = createPageNarratorKokoroTts({}, { runtime: null });
    const preparationCalls = cacheKokoroVoiceStyle.mock.calls.length;
    const request = tts[method](method === 'generate_from_ids' ? [1] : 'obsolete', { voice: 'af_heart', signal: signal.signal });
    await expect(method === 'stream' ? request.next() : request).rejects.toMatchObject({ name: 'AbortError' });
    expect(cacheKokoroVoiceStyle.mock.calls.length).toBe(preparationCalls);
  });

  it('retires queued inference and waits for active inference before disposing once', async () => {
    let release;
    const audio = { audio: new Float32Array(24), sampling_rate: 24 };
    const baseTts = {
      generate: vi.fn((text) => text === 'running' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(audio)),
      dispose: vi.fn(),
    };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });
    const running = tts.generate('running');
    await vi.waitFor(() => expect(baseTts.generate).toHaveBeenCalledOnce());
    const queued = tts.generate('queued').catch((error) => error);
    const disposal = tts.dispose();
    const repeatedDisposal = tts.dispose();
    const newResult = tts.generate('new').catch((error) => error);
    await Promise.resolve();
    const disposedWhileRunning = baseTts.dispose.mock.calls.length;
    release(audio);
    await expect(running).resolves.toBe(audio);
    const [queuedResult, resultAfterDisposal] = await Promise.all([queued, newResult, disposal, repeatedDisposal]);
    expect(disposedWhileRunning).toBe(0);
    expect(queuedResult).toEqual(expect.objectContaining({ message: expect.stringContaining('disposed') }));
    expect(resultAfterDisposal).toEqual(expect.objectContaining({ message: expect.stringContaining('disposed') }));
    expect(baseTts.generate).toHaveBeenCalledTimes(1);
    expect(baseTts.dispose).toHaveBeenCalledOnce();
  });

  it.each([['empty', []], ['NaN', [Number.NaN]], ['infinite', [Infinity]]])('falls back to WASM when WebGPU warmup produces %s audio', async (_, samples) => {
    const dispose = vi.fn();
    const loadKokoro = vi.fn(async (modelId, { device }) => createPageNarratorKokoroTts({
      tokenizer: () => ({ input_ids: [1] }),
      generate_from_ids: async () => ({ audio: Float32Array.from(device === 'webgpu' ? samples : [0, 0.1, 0]), sampling_rate: 24000 }),
      ...(device === 'webgpu' ? { dispose } : {}),
    }, { runtime: null }));
    const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro });
    const onFallback = vi.fn();
    const onReady = vi.fn();
    const tts = await ensure({ warmupVoice: 'af_heart', backendPlan: { device: 'webgpu', dtype: 'fp32' }, onFallback, onReady });
    expect(loadKokoro.mock.calls.map(([, options]) => [options.device, options.dtype])).toEqual([['webgpu', 'fp32'], ['wasm', 'q8']]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'voice_model_warmup_failed' }), expect.objectContaining({ device: 'wasm' }));
    expect(onReady).toHaveBeenCalledOnce();
    await expect(tts.warmup({ voice: 'af_heart' })).resolves.toMatchObject({ warmed: true });
  });

  it('serializes generation and retries a failed warmup', async () => {
    let warmupAttempts = 0;
    const baseTts = {
      tokenizer: () => ({ input_ids: [1] }),
      generate: vi.fn(async () => ({ audio: [1] })),
      generate_from_ids: vi.fn(async () => {
        warmupAttempts += 1;
        if (warmupAttempts === 1) throw new Error('transient');
        return { audio: new Float32Array(24), sampling_rate: 24 };
      }),
    };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });

    await expect(tts.warmup({ voice: 'af_heart' })).rejects.toThrow('transient');
    await expect(tts.warmup({ voice: 'af_heart' })).resolves.toMatchObject({ warmed: true, voice: 'af_heart' });
    await expect(tts.generate('hello', { voice: 'af_heart' })).resolves.toEqual({ audio: [1] });
  });

  it('rejects queued work that was aborted before inference', async () => {
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    const baseTts = { generate: vi.fn(() => first) };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });
    const running = tts.generate('first');
    const controller = new AbortController();
    const queued = tts.generate('second', { signal: controller.signal });
    controller.abort();
    release({ audio: [] });
    await running;
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(baseTts.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['chunk', 'progressive'])('does not run queued %s stream inference after Stop', async (kind) => {
    let release;
    const next = vi.fn(async () => ({ done: true }));
    const returned = vi.fn(async () => ({ done: true }));
    const baseTts = {
      generate: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      stream: () => ({ next, return: returned, [Symbol.asyncIterator]() { return this; } }),
    };
    const tts = createPageNarratorKokoroTts(baseTts, { runtime: null });
    const running = tts.generate('already running');
    await vi.waitFor(() => expect(baseTts.generate).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const options = { voice: 'af_heart', signal: controller.signal };
    const pending = kind === 'chunk'
      ? synthesizeSpeechChunk(tts, 'obsolete section', options)
      : synthesizeSpeechSegments(tts, 'obsolete section', options).next();
    const stopped = kind === 'chunk'
      ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      : expect(pending).resolves.toMatchObject({ done: true });
    await Promise.resolve();
    controller.abort();
    await stopped;
    release({ audio: new Float32Array(24), sampling_rate: 24 });
    await running;
    await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce());
    expect(next).not.toHaveBeenCalled();
    expect(baseTts.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['chunk', 'progressive'])('cancels discarded %s preloads without stopping the new voice', async (kind) => {
    let release;
    const nativeCalls = [];
    const audio = { audio: new Float32Array(24), sampling_rate: 24 };
    const tts = createPageNarratorKokoroTts({
      async generate(text) {
        nativeCalls.push(text);
        return text === 'blocking' ? new Promise((resolve) => { release = resolve; }) : audio;
      },
      stream(text) {
        return {
          async next() { nativeCalls.push(text); return { done: false, value: { text, audio } }; },
          async return() { return { done: true }; },
          [Symbol.asyncIterator]() { return this; },
        };
      },
    }, { runtime: null });
    const running = tts.generate('blocking');
    await vi.waitFor(() => expect(nativeCalls).toEqual(['blocking']));
    const run = new AbortController();
    const controller = createReaderEngineSpeechPreloadController({
      state: { tts, getSelectedVoiceId: () => 'af_heart', selectedLanguageCode: 'en', activeChunks: [{ speech: 'obsolete 0' }, { speech: 'obsolete 1' }] },
      getActiveTtsProfileConfig: () => ({ progressiveSegments: kind === 'progressive', preloadAhead: 1 }),
      readRunTracker: { isCurrentRun: () => true },
      trackActiveVoiceSynthesisPromise: (promise) => promise,
      trackActiveVoiceSynthesisSegments: (segments) => segments,
      suppressError() {},
    });
    const oldVoice = { engine: 'kokoro', id: 'af_heart' };
    const preloads = new Map();
    const preloadState = {};
    controller.ensureSpeechPreloadWindow({
      speechPreloads: preloads, preloadState, queuedHighlightIndices: new Set(), currentIndex: 0,
      selectedVoice: oldVoice, syncPageHighlights: false, minimumAhead: 1, signal: run.signal,
    });
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    clearSpeechPreloadState({ speechPreloads: preloads, preloadState, preserveVoiceId: 'am_michael' });
    const replacement = controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'am_michael' }, { speech: 'replacement' }, { signal: run.signal },
    );
    release(audio);
    await running;
    const speech = await controller.readPreloadedSpeech(replacement);
    if (kind === 'progressive') await speech.segments.return();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preloadState.failedPreloadRetryUntilByIndex?.size || 0).toBe(0);
    clearSpeechPreloadState({ speechPreloads: preloads, preloadState });
    expect(run.signal.aborted).toBe(false);
    expect(nativeCalls).toEqual(['blocking', 'replacement']);
  });
});
