import { describe, expect, it, vi } from 'vitest';
import { probeWebGpuBackend, selectVoiceModelBackend } from '../../src/lib/gpu-calibration.js';

const gpuPlan = { device: 'webgpu', dtype: 'fp32', reason: 'webgpu-available', cpuBudgetTarget: false };

describe('GPU-first backend selection', () => {
  it.each([
    ['RTX 2070', 8, 8], ['integrated GPU', 8, 4], ['low RAM and one core', 0.5, 1],
  ])('tries %s without benchmarking or requesting a GPU device', async (_, deviceMemory, hardwareConcurrency) => {
    const requestDevice = vi.fn();
    const requestAdapter = vi.fn(async () => ({ limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 }, requestDevice }));
    await expect(selectVoiceModelBackend({ navigator: { gpu: { requestAdapter }, deviceMemory, hardwareConcurrency }, memorySaver: true })).resolves.toMatchObject(gpuPlan);
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it.each(['weak', 'marginal', 'fast'])('keeps GPU first even when old diagnostics classify it as %s', async (tier) => {
    await expect(selectVoiceModelBackend({ navigator: { gpu: {}, deviceMemory: 2, hardwareConcurrency: 1 }, probeWebGpu: async () => ({ tier, elapsedMs: 500, gpuClass: 'integrated-probable', memory: { sufficient: false } }) })).resolves.toMatchObject(gpuPlan);
  });

  it('uses CPU when WebGPU is absent or its runtime is explicitly disabled', async () => {
    const requestAdapter = vi.fn();
    await expect(selectVoiceModelBackend({ navigator: {} })).resolves.toMatchObject({ device: 'wasm', dtype: 'q8', reason: 'no-webgpu' });
    await expect(selectVoiceModelBackend({ navigator: { gpu: { requestAdapter } }, webGpuRuntimeAvailable: false })).resolves.toMatchObject({ device: 'wasm', reason: 'webgpu-runtime-unavailable' });
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it.each(['null', 'rejected'])('uses CPU when adapter creation is %s', async (failure) => {
    const navigator = { gpu: { requestAdapter: async () => { if (failure === 'rejected') throw new Error('No available adapters.'); return null; } } };
    await expect(selectVoiceModelBackend({ navigator })).resolves.toMatchObject({ device: 'wasm', dtype: 'q8', reason: 'no-adapter' });
  });

  it.each([['Win32', undefined], ['Linux x86_64', { powerPreference: 'high-performance' }]])('requests the native adapter on %s', async (platform, options) => {
    const requestAdapter = vi.fn(async () => ({}));
    await expect(probeWebGpuBackend({ navigator: { platform, gpu: { requestAdapter } } })).resolves.toMatchObject({ available: true });
    expect(requestAdapter).toHaveBeenCalledExactlyOnceWith(options);
  });
});
