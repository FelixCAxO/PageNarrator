import { makeLoader } from './voice-model.fixtures.js';
import { describe, expect, it } from "vitest";
import { createVoiceModelLoader } from "../../src/lib/voice-model.js";

describe('voice-model loader', () => {
  it('can still force WASM when a build omits WebGPU/JSEP support', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'wasm-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8 },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: false,
      probeWebGpu: async () => {
        throw new Error('calibration should be skipped without a WebGPU runtime');
      },
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device, event.dtype, event.reason]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('wasm');
    expect(loader.calls[0].options.dtype).toBe('q8');
    expect(events).toEqual([['start', 'wasm', 'q8', 'webgpu-runtime-unavailable'], ['ready']]);
  });

  it('can force WASM for a single load when the active performance profile avoids WebGPU', async () => {
    const loader = makeLoader(() => ({ tag: 'profile-forced-wasm' }));
    let calibrated = false;

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => {
        calibrated = true;
        throw new Error('calibration should be skipped for forced WASM');
      },
    });

    const events = [];
    const tts = await ensure({
      webGpuRuntimeAvailable: false,
      onStart: (event) => events.push(event),
    });

    expect(tts).toEqual({ tag: 'profile-forced-wasm' });
    expect(calibrated).toBe(false);
    expect(events[0]).toMatchObject({ device: 'wasm', reason: 'webgpu-runtime-unavailable' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('wasm');
    expect(loader.calls[0].options.dtype).toBe('q8');
  });

  it('tries WebGPU despite a weak diagnostic score', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'wasm-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8 },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: true,
      probeWebGpu: async () => ({ tier: 'weak', elapsedMs: 52, supportsFp16: true }),
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device, event.dtype, event.reason]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
    expect(events).toEqual([['start', 'webgpu', 'fp32', 'webgpu-available'], ['ready']]);
  });

  it('tries WebGPU on an integrated-like constrained profile', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'wasm-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8 },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: true,
      probeWebGpu: async () => ({
        tier: 'fast',
        elapsedMs: 8,
        supportsFp16: true,
        gpuClass: 'integrated-probable',
        limits: {},
        memory: { sufficient: true },
      }),
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device, event.dtype, event.reason]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
    expect(events).toEqual([['start', 'webgpu', 'fp32', 'webgpu-available'], ['ready']]);
  });

  it('uses fp32 on marginal calibrated WebGPU for Kokoro runtime compatibility', async () => {
    const loader = makeLoader(() => ({ tag: 'marginal-gpu-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8 },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: true,
      probeWebGpu: async () => ({ tier: 'marginal', elapsedMs: 22, supportsFp16: true }),
    });

    await ensure();

    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
  });

  it('falls back to WASM when WebGPU loading throws', async () => {
    const events = [];
    const loader = makeLoader((count) => {
      if (count === 1) throw new Error('webgpu boom');
      return { tag: 'wasm-tts' };
    });

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {} },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: true,
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 7, supportsFp16: true }),
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device]),
      onFallback: (error) => events.push(['fallback', error.message]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(2);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
    expect(loader.calls[1].options.device).toBe('wasm');
    expect(loader.calls[1].options.dtype).toBe('q8');
    expect(events).toEqual([['start', 'webgpu'], ['fallback', 'webgpu boom'], ['ready']]);
  });

  it('skips WebGPU entirely when navigator.gpu is not exposed', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'wasm-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: {},
      loadKokoro: loader.fn,
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('wasm');
    expect(events).toEqual([['start', 'wasm'], ['ready']]);
  });

  it('uses WASM setup when Chrome exposes WebGPU but has no adapter', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'wasm-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: {
        gpu: {
          requestAdapter: async () => {
            throw new Error('No available adapters.');
          },
        },
        deviceMemory: 16,
        hardwareConcurrency: 8,
      },
      loadKokoro: loader.fn,
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device, event.reason]),
      onError: (error) => events.push(['error', error.message]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'wasm-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('wasm');
    expect(loader.calls[0].options.dtype).toBe('q8');
    expect(events).toEqual([['start', 'wasm', 'no-adapter'], ['ready']]);
  });

  it('prefers WebGPU on low-memory devices when an adapter is available', async () => {
    const events = [];
    const loader = makeLoader(() => ({ tag: 'low-memory-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 4 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => ({ available: true }),
    });

    const tts = await ensure({
      onStart: (event) => events.push(['start', event.device]),
      onReady: () => events.push(['ready']),
    });

    expect(tts).toEqual({ tag: 'low-memory-tts' });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
    expect(events).toEqual([['start', 'webgpu'], ['ready']]);
  });

  it('prefers WebGPU on low-core devices when an adapter is available', async () => {
    const loader = makeLoader(() => ({ tag: 'low-core-tts' }));
    let calibrated = false;

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 8, hardwareConcurrency: 2 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => {
        calibrated = true;
        return { tier: 'fast' };
      },
    });

    await ensure();

    expect(calibrated).toBe(true);
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
  });

  it('keeps memory-saver mode from bypassing an available GPU', async () => {
    const loader = makeLoader(() => ({ tag: 'memory-saver-tts' }));

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {}, deviceMemory: 16 },
      loadKokoro: loader.fn,
      probeWebGpu: async () => ({ available: true }),
    });

    await ensure({ memorySaver: true });

    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0].options.device).toBe('webgpu');
    expect(loader.calls[0].options.dtype).toBe('fp32');
  });

  it('reports an error when both WebGPU and WASM fail', async () => {
    const events = [];
    const loader = makeLoader(() => { throw new Error('all dead'); });

    const ensure = createVoiceModelLoader({
      navigator: { gpu: {} },
      loadKokoro: loader.fn,
      webGpuRuntimeAvailable: true,
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 7, supportsFp16: true }),
    });

    await expect(ensure({
      onStart: () => events.push(['start']),
      onFallback: () => events.push(['fallback']),
      onError: (error) => events.push(['error', error.message]),
    })).rejects.toThrow('all dead');

    expect(events).toEqual([['start'], ['fallback'], ['error', 'all dead']]);
  });

  it('tries each available GPU in the hardware matrix and uses WASM when none exists', async () => {
    const loadPlanLog = [];
    const loader = makeLoader(() => ({ tag: 'matrix-tts' }));

    const runs = [
      {
        name: '8gb_bucket_discrete_gpu_24cpu',
        navigator: {
          deviceMemory: 8,
          hardwareConcurrency: 24,
          gpu: { requestAdapter: () => ({ requestAdapterInfo: async () => ({ vendor: 'NVIDIA', device: 'RTX 4080' }) }) },
        },
        probeWebGpu: async () => ({
          tier: 'fast',
          elapsedMs: 8,
          supportsFp16: true,
          gpuClass: 'discrete',
          limits: {
            maxBufferSize: 4 * 1024 * 1024 * 1024,
            maxStorageBufferBindingSize: 4 * 1024 * 1024 * 1024,
          },
          memory: { sufficient: true },
        }),
        expected: ['webgpu', 'fp32'],
      },
      {
        name: '8gb_4cpu_no_dgpu',
        navigator: { deviceMemory: 8, hardwareConcurrency: 4, gpu: {} },
        probeWebGpu: async () => ({
          tier: 'fast',
          elapsedMs: 8,
          supportsFp16: true,
          gpuClass: 'integrated-probable',
          limits: {},
          memory: { sufficient: true },
        }),
        expected: ['webgpu', 'fp32'],
      },
      {
        name: '2gb_1cpu',
        navigator: { deviceMemory: 2, hardwareConcurrency: 1 },
        probeWebGpu: async () => {
          throw new Error('calibration should be skipped on very-low-memory pcs');
        },
        expected: ['wasm', 'q8'],
      },
    ];

    for (const run of runs) {
      loader.calls.length = 0;

      const ensure = createVoiceModelLoader({
        navigator: run.navigator,
        loadKokoro: loader.fn,
        probeWebGpu: run.probeWebGpu,
      });

      const tts = await ensure();
      expect(tts).toEqual({ tag: 'matrix-tts' });
      expect(loader.calls).toHaveLength(1);
      expect(loader.calls[0].options.device).toBe(run.expected[0]);
      expect(loader.calls[0].options.dtype).toBe(run.expected[1]);
      loadPlanLog.push({ name: run.name, device: loader.calls[0].options.device });
    }

    expect(loadPlanLog).toHaveLength(runs.length);
    expect(loadPlanLog).toEqual([
      { name: '8gb_bucket_discrete_gpu_24cpu', device: 'webgpu' },
      { name: '8gb_4cpu_no_dgpu', device: 'webgpu' },
      { name: '2gb_1cpu', device: 'wasm' },
    ]);
  });
});
