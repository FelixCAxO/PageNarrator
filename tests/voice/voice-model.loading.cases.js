import { makeLoader } from './voice-model.fixtures.js';
import { describe, expect, it, vi } from "vitest";
import { createVoiceModelLoader } from "../../src/lib/voice-model.js";
import { createPageNarratorKokoroTts } from '../../src/lib/kokoro-multilingual.js';

describe('voice-model loader', () => {
  it('lets cold GPU warmup finish after the slow-load threshold without switching to WASM', async () => {
    vi.useFakeTimers();
    try {
      const model = { warmup: () => new Promise((resolve) => setTimeout(resolve, 35_000)) };
      const loadKokoro = vi.fn(async () => model);
      const onFallback = vi.fn();
      const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro });
      const pending = ensure({ warmupVoice: 'af_heart', backendPlan: { device: 'webgpu', dtype: 'fp32' }, onFallback });
      await vi.advanceTimersByTimeAsync(35_000);
      await expect(pending).resolves.toBe(model);
      expect(onFallback).not.toHaveBeenCalled();
      expect(loadKokoro).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts on WebGPU when navigator.gpu is available and reports ready', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'gpu-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {} },
      loadKokoro: loader.fn,
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 7, supportsFp16: true }),
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device]),
      onProgress: (event) => events.push(['progress', event]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'gpu-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
    expect(events).toEqual([['start', 'webgpu'], ['ready']]);
  });

  it('starts backend-independent model preparation while WebGPU calibration is still pending', async () => {
    const events = [];
    let resolveCalibration;
    const calibrationReady = new Promise((resolve) => {
      resolveCalibration = resolve;
    });
    const loader = makeLoader(() => {
      events.push('load-kokoro');
      return { tag: 'gpu-tts' };
    });

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      loadKokoro: loader.fn,
      prepareModelLoad: async ({ modelId, warmupVoice }) => {
        events.push(['prepare-start', modelId, warmupVoice]);
      },
      probeWebGpu: async () => {
        events.push('calibration-start');
        await calibrationReady;
        events.push('calibration-finish');
        return { tier: 'fast', elapsedMs: 7, supportsFp16: true };
      },
    });

    const load = ensure({ warmupVoice: 'bf_emma' });
    await Promise.resolve();

    expect(events).toEqual([
      ['prepare-start', 'onnx-community/Kokoro-82M-v1.0-ONNX', 'bf_emma'],
      'calibration-start',
    ]);

    resolveCalibration();
    await expect(load).resolves.toEqual({ tag: 'gpu-tts' });
    expect(events).toEqual([
      ['prepare-start', 'onnx-community/Kokoro-82M-v1.0-ONNX', 'bf_emma'],
      'calibration-start',
      'calibration-finish',
      'load-kokoro',
    ]);
  });

  it('uses a supplied backend plan without rerunning WebGPU calibration during model load', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'preplanned-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => {
        throw new Error('calibration should be reused, not repeated');
      },
    });

    const tts = await ensure({
      backendPlan: {
        device: 'wasm',
        dtype: 'q8',
        reason: 'precomputed-plan',
        cpuBudgetTarget: true,
      },
      onStart: (event) => events.push(event),
    });

    expect(tts).toEqual({ tag: 'preplanned-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('wasm');
    expect(loader.calls[0].options.dtype).toBe('q8');
    expect(events).toEqual([{
      device: 'wasm',
      dtype: 'q8',
      reason: 'precomputed-plan',
      cpuBudgetTarget: true,
    }]);
  });

  it('warms the selected Kokoro voice after model load before reporting ready', async () => {
    const events = [];
    const loader = makeLoader(() => ({
      tag: 'gpu-tts',
      async warmup(options) {
        events.push(['warmup', options.voice]);
      },
    }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 7, supportsFp16: true }),
    });

    const tts = await ensure({
      warmupVoice: 'bf_emma',
      onStart: (event) => events.push(['start', event.device]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toMatchObject({ tag: 'gpu-tts' });
    expect(events).toEqual([
      ['start', 'webgpu'],
      ['warmup', 'bf_emma'],
      ['ready'],
    ]);
  });

  it('disposes a loaded WebGPU model when warmup fails before trying the WASM fallback', async () => {
    const disposed = [];
    const events = [];
    const loader = makeLoader((count) => {
      if (count === 1) {
        return {
          tag: 'webgpu-tts',
          async warmup() {
            throw new Error('shader compile failed');
          },
          async dispose() {
            disposed.push('webgpu');
          },
        };
      }
      return {
        tag: 'wasm-tts',
        async warmup(options) {
          events.push(['fallback-warmup', options.voice]);
        },
      };
    });

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 7, supportsFp16: true }),
    });

    const model = await ensure({
      warmupVoice: 'af_heart',
      onFallback: (error, plan) => events.push(['fallback', error.code, error.voiceLoadStep, error.message, plan.device]),
    });

    expect(model).toMatchObject({ tag: 'wasm-tts' });
    expect(disposed).toEqual(['webgpu']);
    expect(events).toEqual([
      ['fallback', 'voice_model_warmup_failed', 'warmup', 'shader compile failed', 'wasm'],
      ['fallback-warmup', 'af_heart'],
    ]);
    expect(loader.calls.map((call) => call.options.device)).toEqual(['webgpu', 'wasm']);
  });

  it('waits for timed-out GPU inference to settle before disposing or loading a fallback model', async () => {
    vi.useFakeTimers();
    try {
      let finishInference;
      const inference = new Promise((resolve) => { finishInference = resolve; });
      const dispose = vi.fn();
      const gpuModel = createPageNarratorKokoroTts({
        tokenizer: () => ({ input_ids: {} }),
        generate_from_ids: () => inference,
        model: { dispose },
      });
      const fallbackModel = {};
      const loadKokoro = vi.fn(async () => loadKokoro.mock.calls.length === 1 ? gpuModel : fallbackModel);
      const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro, warmupTimeoutMs: 25 });
      const pending = ensure({ warmupVoice: 'test_voice', backendPlan: { device: 'webgpu', dtype: 'fp32' } });

      await vi.advanceTimersByTimeAsync(25);
      const disposedBeforeSettlement = dispose.mock.calls.length;
      const loadsBeforeSettlement = loadKokoro.mock.calls.length;
      finishInference({ sampling_rate: 24_000, audio: new Float32Array([0.25]) });

      await expect(pending).resolves.toBe(fallbackModel);
      expect(disposedBeforeSettlement).toBe(0);
      expect(loadsBeforeSettlement).toBe(1);
      expect(dispose).toHaveBeenCalledOnce();
      expect(loadKokoro).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks Kokoro model load failures with a load-step error code', async () => {
    const errors = [];
    const loadError = new Error('model asset missing');
    loadError.code = 'ENOENT';
    const loader = makeLoader(() => {
      throw loadError;
    });

    const ensure = createVoiceModelLoader({
      navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
      loadKokoro: loader.fn,
    });

    await expect(ensure({
      backendPlan: {
        device: 'wasm',
        dtype: 'q8',
        reason: 'no-webgpu',
        cpuBudgetTarget: true,
      },
      onError: (error) => errors.push(error),
    })).rejects.toMatchObject({
      code: 'voice_model_load_failed',
      voiceLoadStep: 'load',
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(loadError);
    expect(errors[0]).toMatchObject({
      code: 'voice_model_load_failed',
      originalCode: 'ENOENT',
      voiceLoadStep: 'load',
    });
  });

  it('marks backend-plan failures with a backend-plan-step error code', async () => {
    const errors = [];
    const backendError = new Error('backend plan missing');
    const loader = makeLoader(() => ({ tag: 'tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      loadKokoro: loader.fn,
    });

    await expect(ensure({
      backendPlan: Promise.reject(backendError),
      onError: (error) => errors.push(error),
    })).rejects.toMatchObject({
      code: 'voice_model_backend_plan_failed',
      voiceLoadStep: 'backendPlan',
    });

    expect(errors).toEqual([backendError]);
    expect(loader.calls).toEqual([]);
  });

  it('reports model preparation failures with a prepare-step error code without blocking load', async () => {
    const events = [];
    const prepareError = new Error('voice style cache failed');
    const loader = makeLoader(() => ({ tag: 'tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
      loadKokoro: loader.fn,
      prepareModelLoad: async () => {
        throw prepareError;
      },
    });

    await expect(ensure({
      backendPlan: {
        device: 'wasm',
        dtype: 'q8',
        reason: 'no-webgpu',
        cpuBudgetTarget: true,
      },
      onError: (error) => events.push(['prepare-error', error.code, error.voiceLoadStep, error.message]),
    })).resolves.toMatchObject({ tag: 'tts' });
    await Promise.resolve();

    expect(events).toEqual([
      ['prepare-error', 'voice_model_prepare_failed', 'prepare', 'voice style cache failed'],
    ]);
    expect(prepareError).toMatchObject({
      code: 'voice_model_prepare_failed',
      voiceLoadStep: 'prepare',
    });
  });

  it('does not report ready when a required voice style download fails on WASM', async () => {
    const error = Object.assign(new Error('Style download failed'), { code: 'voice_style_download_failed' });
    const onReady = vi.fn();
    const dispose = vi.fn();
    const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro: async () => ({ warmup: async () => { throw error; }, dispose }) });
    await expect(ensure({ warmupVoice: 'af_heart', onReady, backendPlan: { device: 'wasm', dtype: 'q8' } })).rejects.toMatchObject({
      code: 'voice_model_load_failed', originalCode: 'voice_style_download_failed',
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['wasm', 'webgpu'])('rejects a shared preparation/style failure on %s without reporting ready or downloading a fallback model', async (device) => {
    let rejectStyle, startWarmup;
    const style = new Promise((_, reject) => { rejectStyle = reject; });
    const warming = new Promise((resolve) => { startWarmup = resolve; });
    const dispose = vi.fn();
    const onReady = vi.fn();
    const onFallback = vi.fn();
    const onError = vi.fn();
    const loadKokoro = vi.fn(async () => ({
      warmup() { startWarmup(); return style; },
      dispose,
    }));
    const ensure = createVoiceModelLoader({ navigator: {}, loadKokoro, prepareModelLoad: () => style });
    const pending = ensure({ warmupVoice: 'af_heart', onReady, onFallback, onError, backendPlan: { device, dtype: device === 'wasm' ? 'q8' : 'fp32' } });
    await warming;
    rejectStyle(Object.assign(new Error('Style download failed'), { code: 'voice_style_download_failed' }));

    await expect(pending).rejects.toMatchObject({ originalCode: 'voice_style_download_failed' });
    expect(onReady).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(loadKokoro).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(await ensure.releaseVoiceModel()).toBe(false);
  });

  it('keeps a loaded WASM model when warmup stalls instead of failing the read', async () => {
    vi.useFakeTimers();
    try {
      const disposed = [];
      const events = [];
      const loader = makeLoader(() => ({
        tag: 'stalled-wasm-tts',
        warmup: () => new Promise(() => {}),
        async dispose() {
          disposed.push('stalled-wasm-tts');
        },
      }));

      const ensure = createVoiceModelLoader({
        navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
        loadKokoro: loader.fn,
        warmupTimeoutMs: 25,
      });

      const pending = ensure({
        warmupVoice: 'af_heart',
        backendPlan: {
          device: 'wasm',
          dtype: 'q8',
          reason: 'no-webgpu',
          cpuBudgetTarget: true,
        },
        onError: (error) => events.push(['error', error.code, error.message]),
      });

      await vi.advanceTimersByTimeAsync(25);

      // A stalled warmup is non-fatal for the last-resort WASM model: keep it so
      // synthesis can compile on demand rather than dropping to a browser voice.
      await expect(pending).resolves.toMatchObject({ tag: 'stalled-wasm-tts' });
      expect(disposed).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the cached model when a reused warmup stalls', async () => {
    vi.useFakeTimers();
    try {
      const disposed = [];
      let cachedWarmups = 0;
      const loader = makeLoader(() => ({
        tag: 'cached-wasm-tts',
        warmup: () => {
          cachedWarmups += 1;
          return cachedWarmups === 1 ? Promise.resolve() : new Promise(() => {});
        },
        async dispose() {
          disposed.push('cached-wasm-tts');
        },
      }));

      const ensure = createVoiceModelLoader({
        navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
        loadKokoro: loader.fn,
        warmupTimeoutMs: 25,
      });

      await expect(ensure({
        warmupVoice: 'af_heart',
        backendPlan: {
          device: 'wasm',
          dtype: 'q8',
          reason: 'no-webgpu',
          cpuBudgetTarget: true,
        },
      })).resolves.toMatchObject({ tag: 'cached-wasm-tts' });

      const reused = ensure({ warmupVoice: 'bf_emma' });
      await vi.advanceTimersByTimeAsync(25);

      // The reused model already worked; a stalled re-warmup keeps it instead of
      // disposing and reloading.
      await expect(reused).resolves.toMatchObject({ tag: 'cached-wasm-tts' });
      expect(disposed).toEqual([]);
      expect(loader.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
