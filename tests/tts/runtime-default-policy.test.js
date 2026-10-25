import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RUNTIME_POLICY } from '../../src/tts/runtime/default-runtime-policy.js';
import { selectDefaultVoiceRuntime } from '../../src/tts/runtime/backend-policy.js';
import { createTtsService } from '../../src/tts/tts-service.js';

describe('default TTS runtime policy', () => {
  it('keeps the default adaptive while resolving to high quality Kokoro on fast WebGPU', async () => {
    const runtime = await selectDefaultVoiceRuntime({
      navigator: {
        deviceMemory: 16,
        hardwareConcurrency: 12,
        gpu: {},
      },
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 8 }),
    });

    expect(DEFAULT_RUNTIME_POLICY).toEqual({
      requestedProfile: 'auto',
      preferredBackend: 'webgpu',
      allowSilentFallback: true,
    });
    expect(runtime).toMatchObject({
      requestedProfile: 'auto',
      resolvedProfile: 'quality',
      preferredBackend: 'webgpu',
      backendPlan: {
        device: 'webgpu',
        dtype: 'fp32',
        reason: 'webgpu-available',
      },
      profileConfig: {
        maxChunkLength: 480,
        preloadAhead: 4,
      },
    });
  });

  it('resolves the default policy to balanced preloaded chunks when WebGPU has no adapter', async () => {
    await expect(selectDefaultVoiceRuntime({
      navigator: {
        deviceMemory: 16,
        hardwareConcurrency: 12,
        gpu: {},
      },
      probeWebGpu: async () => ({ tier: 'weak', reason: 'no-adapter' }),
    })).resolves.toMatchObject({
      requestedProfile: 'auto',
      resolvedProfile: 'balanced',
      preferredBackend: 'wasm',
      backendPlan: {
        device: 'wasm',
        dtype: 'q8',
        reason: 'no-adapter',
      },
      profileConfig: {
        maxChunkLength: 240,
        preloadAhead: 3,
        progressiveSegments: false,
      },
    });
  });

  it('tries WebGPU even on low-memory and low-core hardware', async () => {
    await expect(selectDefaultVoiceRuntime({
      navigator: {
        deviceMemory: 2,
        hardwareConcurrency: 2,
        gpu: {},
      },
      probeWebGpu: async () => ({ tier: 'fast', elapsedMs: 8 }),
    })).resolves.toMatchObject({
      allowSilentFallback: true,
      preferredBackend: 'webgpu',
      backendPlan: {
        device: 'webgpu',
        dtype: 'fp32',
        reason: 'webgpu-available',
      },
    });
  });

  it('uses the adaptive runtime policy', async () => {
    const navigator = {
      deviceMemory: 16,
      hardwareConcurrency: 12,
      gpu: {},
    };
    const probeWebGpu = async () => ({ tier: 'fast', elapsedMs: 8 });

    const runtime = await createTtsService({ navigator }).prepareRuntime({ probeWebGpu });
    expect(runtime.backendPlan).toMatchObject({ device: 'webgpu', dtype: 'fp32' });
  });

  it('routes readerEngine Kokoro model loading through the TTS service runtime decision', () => {
    const runtime = readFileSync(new URL('../../src/lib/reader-engine-voice-runtime-controller.js', import.meta.url), 'utf8');

    expect(runtime).toContain('ttsService.prepareRuntime');
    expect(runtime).toContain('runtimeDecision.backendPlan');
    expect(runtime).not.toContain('createVoiceModelBackendPlan');
  });
});
