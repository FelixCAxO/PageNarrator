import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createKokoroDataLoader } from '../../src/tts/kokoro/data-loader.js';
import { createReaderEngineVoiceRuntimeController } from '../../src/lib/reader-engine-voice-runtime-controller.js';

function createController(overrides = {}) {
  const calls = [];
  const state = {
    tts: null,
    readingState: 'idle',
    currentAudio: null,
    activeSectionPauseDelay: null,
    modelSetupState: null,
  };
  const controller = createReaderEngineVoiceRuntimeController({
    state,
    documentRef: { hidden: false },
    ttsService: {
      prepareRuntime: async () => {
        calls.push(['prepareRuntime']);
        return { preferredBackend: 'webgpu', backendPlan: { device: 'webgpu' } };
      },
      getRuntimeDiagnostics: () => null,
    },
    voiceRegistry: {
      configureOnnxRuntime: async () => calls.push(['configureRuntime']),
      ensureVoiceModel: async (options) => {
        calls.push(['ensureVoiceModel', options.webGpuRuntimeAvailable, options.backendPlan]);
        options.onStart?.({ device: 'webgpu' });
        options.onProgress?.({ status: 'progress', progress: 50, file: 'model.onnx' });
        options.onReady?.();
        return { warmup: async ({ voice }) => calls.push(['warmup', voice]) };
      },
      releaseVoiceModel: async () => {
        calls.push(['releaseVoiceModel']);
        return true;
      },
    },
    createInFlightActivityTracker: () => ({
      isActive: () => false,
      trackPromise: async (promise) => {
        calls.push(['trackPromise']);
        return promise;
      },
      trackAsyncIterable: (segments) => segments,
    }),
    createVoiceModelIdleReleaseController: ({ releaseVoiceModel }) => ({
      cancel: () => calls.push(['cancelIdleRelease']),
      schedule: () => calls.push(['scheduleIdleRelease']),
      handleVisibilityChange: ({ hidden }) => calls.push(['visibility', hidden]),
      releaseVoiceModel,
    }),
    shouldCleanupReadOnPanelHide: ({ state: readingState }) => readingState === 'reading',
    shouldForceWasmVoiceModel: () => false,
    render: {
      renderSetup: (setup) => calls.push(['renderSetup', setup.phase]),
      setReadingState: (readingState) => calls.push(['setReadingState', readingState]),
      renderGovernorDecision: (decision) => calls.push(['governor', decision]),
      renderBackendStatus: (event) => calls.push(['backendStatus', event.device]),
      recordBackendPlan: (event) => calls.push(['recordBackendPlan', event.device]),
      recordModelLoad: (event) => calls.push(['recordModelLoad', Number.isFinite(event.loadMs)]),
      recordModelFallback: () => calls.push(['fallback']),
    },
    logger: { warn: (...args) => calls.push(['warn', ...args]) },
    getNowMs: (() => {
      let now = 10;
      return () => {
        now += 5;
        return now;
      };
    })(),
    ...overrides,
  });
  return { calls, controller, state };
}

describe('createReaderEngineVoiceRuntimeController', () => {
  afterEach(() => vi.useRealTimers());

  it('shows streamed Kokoro bytes before verification finishes, and keeps corrupt downloads failed', async () => {
    const data = new Uint8Array(2_000_000).fill(7);
    const manifest = { modelId: 'fixture', revision: 'pinned', files: [{ path: 'model.onnx', bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') }] };
    const { controller, state } = createController();
    let finish;
    const remainder = new Promise(resolve => { finish = resolve; });
    const events = [];
    const load = createKokoroDataLoader({ manifest, cacheStorage: null,
      fetcher: async () => new Response(new ReadableStream({ async start(stream) {
        stream.enqueue(data.slice(0, 1_000_000));
        await remainder;
        stream.enqueue(data.slice(1_000_000));
        stream.close();
      } })),
      onProgress(event) { events.push(event); controller.handleModelProgress(event); },
    });
    const loading = load('model.onnx');
    await vi.waitFor(() => expect(state.modelSetupState?.detail).toBe('Downloading model.onnx: 1.0 / 2.0 MB'));
    expect(state.modelSetupState.progress).toBeGreaterThan(5);
    expect(state.modelSetupState.progress).toBeLessThan(90);
    expect(events.some(event => event.status === 'done')).toBe(false);
    finish();
    await expect(loading).resolves.toEqual(data);
    expect(state.modelSetupState).toMatchObject({ phase: 'loading', progress: 90, detail: 'Verified model.onnx. Preparing voice…' });
    const corrupt = createKokoroDataLoader({ manifest, cacheStorage: null, fetcher: async () => new Response(new Uint8Array(data.length)),
      onProgress: event => events.push(event) });
    await expect(corrupt('model.onnx')).rejects.toThrow('hash mismatch');
    expect(events.filter(event => event.status === 'done')).toHaveLength(1);
    const concurrent = createController();
    concurrent.controller.handleModelProgress({ status: 'download', file: 'weights', loaded: 0, total: 10_000_000 });
    concurrent.controller.handleModelProgress({ status: 'download', file: 'tokenizer', loaded: 0, total: 1_000_000 });
    concurrent.controller.handleModelProgress({ status: 'done', file: 'tokenizer', loaded: 1_000_000, total: 1_000_000 });
    expect(concurrent.state.modelSetupState.detail).toBe('Downloading voice files: 1.0 / 11.0 MB');
    expect(concurrent.state.modelSetupState.progress).toBeLessThan(20);
    concurrent.controller.handleModelProgress({ status: 'done', file: 'weights', loaded: 10_000_000, total: 10_000_000 });
    expect(concurrent.state.modelSetupState.detail).toBe('Verified weights. Preparing voice…');
  });

  it('loads OmniVoice only when selected and releases it before returning to Kokoro', async () => {
    let engine = 'kokoro';
    const model = { capabilities: { id: 'omnivoice' }, init: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const loadOmniVoice = vi.fn(async () => ({ createOmniVoiceTts: () => model }));
    const { controller, state } = createController({ resolveSelectedVoice: () => ({ engine }), loadOmniVoice });
    await controller.ensureModel();
    expect(loadOmniVoice).not.toHaveBeenCalled();
    engine = 'omnivoice';
    expect(await controller.ensureModel()).toBe(model);
    expect(state.tts).toBe(model);
    expect(model.init).toHaveBeenCalledTimes(1);
    engine = 'kokoro';
    await controller.ensureModel();
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(state.tts).not.toBe(model);
  });

  it('shows a failed OmniVoice setup and releases its partial sessions', async () => {
    const model = { init: vi.fn(async () => { throw new Error('WebGPU unavailable'); }), dispose: vi.fn(async () => {}) };
    const { controller, state } = createController({ resolveSelectedVoice: () => ({ engine: 'omnivoice' }), loadOmniVoice: async () => ({ createOmniVoiceTts: () => model }) });
    await expect(controller.ensureModel()).rejects.toThrow('WebGPU unavailable');
    expect(state.tts).toBeNull();
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(state.modelSetupState).toMatchObject({ phase: 'error', detail: 'WebGPU unavailable' });
  });

  it('replaces a loaded OmniVoice model whose recovery reload failed', async () => {
    const broken = { capabilities: { id: 'omnivoice' }, init: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const fresh = { ...broken, init: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const createOmniVoiceTts = vi.fn().mockReturnValueOnce(broken).mockReturnValue(fresh);
    const { controller, state } = createController({ resolveSelectedVoice: () => ({ engine: 'omnivoice' }),
      loadOmniVoice: async () => ({ createOmniVoiceTts }) });
    await controller.ensureModel();
    broken.init.mockRejectedValue(new Error('GPU lost'));
    await expect(controller.ensureModel()).rejects.toThrow('GPU lost');
    expect(broken.dispose).toHaveBeenCalledOnce();
    expect(state.tts).toBeNull();
    expect(await controller.ensureModel()).toBe(fresh);
  });

  it('waits for OmniVoice disposal before allocating another model for a new read', async () => {
    let finishDisposal;
    const dispose = vi.fn(() => new Promise(resolve => { finishDisposal = resolve; }));
    const createOmniVoiceTts = vi.fn(() => ({ capabilities: { id: 'omnivoice' }, init: vi.fn(async () => {}), dispose }));
    const { controller } = createController({ resolveSelectedVoice: () => ({ engine: 'omnivoice' }),
      loadOmniVoice: async () => ({ createOmniVoiceTts }) });
    await controller.ensureModel();
    const release = controller.releaseLoadedVoiceModel();
    const reload = controller.ensureModel();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(createOmniVoiceTts).toHaveBeenCalledTimes(1);
    finishDisposal();
    await release;
    await reload;
    expect(createOmniVoiceTts).toHaveBeenCalledTimes(2);
  });

  it('loads the Kokoro model once and records setup progress', async () => {
    const { calls, controller, state } = createController();

    const tts = await controller.ensureModel({ warmupVoice: 'af_heart' });

    expect(tts).toBe(state.tts);
    expect(calls).toContainEqual(['configureRuntime']);
    expect(calls).toContainEqual(['prepareRuntime']);
    expect(calls).toContainEqual(['ensureVoiceModel', true, { device: 'webgpu' }]);
    expect(calls).toContainEqual(['backendStatus', 'webgpu']);
    expect(calls).toContainEqual(['renderSetup', 'ready']);
    expect(calls).toContainEqual(['recordModelLoad', true]);
  });

  it('forwards the opening text to GPU model warmup', async () => {
    const ensureVoiceModel = vi.fn(async () => ({}));
    const { controller } = createController({ voiceRegistry: { configureOnnxRuntime: async () => {}, ensureVoiceModel } });
    await controller.ensureModel({ warmupVoice: 'af_heart', warmupText: 'Opening heading' });
    expect(ensureVoiceModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: 'af_heart', warmupText: 'Opening heading' }));
  });

  it('warms the cached model without reloading it', async () => {
    const { calls, controller } = createController();

    await controller.ensureModel();
    calls.length = 0;
    await controller.ensureModel({ warmupVoice: 'bm_george' });

    expect(calls).toEqual([
      ['warmup', 'bm_george'],
      ['trackPromise'],
    ]);
  });

  it('releases active voice runtimes only when the read state is idle', async () => {
    const { calls, controller, state } = createController();

    await controller.ensureModel();
    expect(await controller.releaseLoadedVoiceModel()).toBe(true);

    state.tts = {};
    state.readingState = 'reading';
    expect(await controller.releaseLoadedVoiceModel()).toBe(false);
    expect(calls).toContainEqual(['releaseVoiceModel']);
  });
  it('does not revive a partially disposed model after release fails', async () => {
    let loadCount = 0;
    const registry = {
      configureOnnxRuntime: async () => {},
      ensureVoiceModel: async () => ({ id: ++loadCount }),
      releaseVoiceModel: async () => { throw new Error('Session disposal failed'); },
    };
    const { controller, state } = createController({ voiceRegistry: registry });
    const first = await controller.ensureModel();

    expect(await controller.releaseLoadedVoiceModel()).toBe(false);
    expect(state.tts).toBeNull();
    expect(await controller.ensureModel()).not.toBe(first);
    expect(loadCount).toBe(2);
  });
});
