import { describe, expect, it } from 'vitest';
import { MODEL_FILE_URL_PATTERN, RUN_FAULT_KINDS, createRunFaults } from '../live/tts-probe-run-faults.js';
import { normalizeGpuLoadSpec } from '../../scripts/weak-hardware/gpu-load-generator.mjs';
import { getTtsProbeProfiles } from '../live/live-tts-hardware-profiles.js';

// Minimal CDP double: answers evaluations from a queue and records commands.
function createFakeCdp(evaluations = []) {
  const sent = [];
  const listeners = new Map();
  return {
    sent,
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === 'Runtime.evaluate') return { result: { value: evaluations.shift() } };
      return {};
    },
    on(method, callback) {
      listeners.set(method, [...(listeners.get(method) || []), callback]);
    },
    emit(method, params, sessionId) {
      for (const callback of listeners.get(method) || []) callback(params, sessionId);
    },
  };
}

const [interrupted] = getTtsProbeProfiles('download_interrupted_webgpu');
const [quota] = getTtsProbeProfiles('storage_quota_64mib_webgpu');
const [evicted] = getTtsProbeProfiles('cache_evicted_webgpu');

describe('weak-hardware run faults', () => {
  it('resets model-file responses on the toolbar-player page and proves nothing was cached', async () => {
    const cdp = createFakeCdp([0]);
    const faults = createRunFaults({ cdp, profile: interrupted, condition: interrupted.runConditions[0], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    await faults.arm('page');
    cdp.emit('Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://huggingface.co/onnx-community/Kokoro/resolve/x/onnx/model.onnx' } }, 'page');
    cdp.emit('Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://huggingface.co/other.onnx' } }, 'another-page');
    const attempt = { modelCache: { state: 'download-cold' } };

    expect(await faults.release(attempt)).toEqual([]);
    expect(cdp.sent.find((entry) => entry.method === 'Fetch.enable').params.patterns).toEqual([{ urlPattern: MODEL_FILE_URL_PATTERN, requestStage: 'Response' }]);
    expect(cdp.sent.filter((entry) => entry.method === 'Fetch.failRequest').map((entry) => [entry.params.requestId, entry.params.errorReason])).toEqual([['r1', 'ConnectionReset']]);
    expect(attempt.runFaults.injections).toEqual({ [RUN_FAULT_KINDS.DOWNLOAD_INTERRUPTED]: { triggered: 1 } });
    expect(attempt.runFaults.download.failedRequests).toEqual(['onnx/model.onnx']);
  });

  it('fails the run when an interrupted download leaves a cached model file', async () => {
    const cdp = createFakeCdp([2]);
    const faults = createRunFaults({ cdp, profile: interrupted, condition: interrupted.runConditions[0], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    await faults.arm('page');

    expect(await faults.release({})).toEqual(['an interrupted model download left a cached model file']);
  });

  it('verifies the storage quota override by a rejected write and removes it afterwards', async () => {
    const cdp = createFakeCdp([{ quota: 10 * 1024 ** 3, usage: 0 }, 'rejected:QuotaExceededError']);
    const faults = createRunFaults({ cdp, profile: quota, condition: quota.runConditions[1], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    await faults.arm('page');
    const attempt = { modelCache: { state: 'cache-warm' } };

    expect(await faults.release(attempt)).toEqual(['cache state at run start was cache-warm, expected download-cold']);
    const overrides = cdp.sent.filter((entry) => entry.method === 'Storage.overrideQuotaForOrigin').map((entry) => entry.params);
    expect(overrides).toEqual([{ origin: 'chrome-extension://abc', quotaSize: 64 * 1024 * 1024 }, { origin: 'chrome-extension://abc' }]);
    expect(attempt.runFaults.injections).toEqual({ [RUN_FAULT_KINDS.STORAGE_QUOTA]: { triggered: 1 } });
  });

  it('does not count an override that did not stop a write above the quota', async () => {
    const cdp = createFakeCdp([{ quota: 10 * 1024 ** 3, usage: 0 }, 'stored']);
    const faults = createRunFaults({ cdp, profile: quota, condition: quota.runConditions[0], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    await faults.arm('page');
    const attempt = {};
    await faults.release(attempt);

    expect(attempt.runFaults.injections[RUN_FAULT_KINDS.STORAGE_QUOTA]).toEqual({ triggered: 0 });
  });

  it('evicts the cache before the run observes its cache state', async () => {
    const cdp = createFakeCdp([{ caches: 2, modelFiles: 1 }]);
    const faults = createRunFaults({ cdp, profile: evicted, condition: evicted.runConditions[1], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    await faults.beforeRead();
    const attempt = {};
    await faults.release(attempt);

    expect(cdp.sent[0]).toMatchObject({ method: 'Runtime.evaluate', sessionId: 'sw' });
    expect(attempt.runFaults.injections).toEqual({ [RUN_FAULT_KINDS.CACHE_EVICTION]: { triggered: 1 } });
  });

  it('marks inactive faults not applicable and leaves unarmed active faults unobserved', async () => {
    const warmUp = createRunFaults({ cdp: createFakeCdp(), profile: evicted, condition: evicted.runConditions[0], extensionId: 'abc', serviceWorkerSessionId: 'sw' });
    const neverArmed = createRunFaults({ cdp: createFakeCdp(), profile: interrupted, condition: interrupted.runConditions[0], extensionId: 'abc', serviceWorkerSessionId: 'sw' });

    expect(warmUp.injections()).toEqual({ [RUN_FAULT_KINDS.CACHE_EVICTION]: { notApplicable: true } });
    expect(neverArmed.injections()).toEqual({});
  });

  it('runs the declared GPU load and fails the lane when no work was done', async () => {
    const [gpuLane] = getTtsProbeProfiles('contention_gpu50_webgpu');
    const make = (dispatches) => createRunFaults({
      cdp: createFakeCdp(),
      profile: gpuLane,
      extensionId: 'abc',
      serviceWorkerSessionId: 'sw',
      startGpuLoad: async (spec) => ({ stop: async () => ({ ...spec, dispatches, achievedBusyFraction: 0.5 }) }),
    });
    const ok = make(400);
    const idle = make(0);
    await ok.arm('page');
    await idle.arm('page');
    const attempt = {};

    expect(await ok.release(attempt)).toEqual([]);
    expect(attempt.contention.gpu).toMatchObject({ dutyCycle: 0.5, dispatches: 400 });
    expect(await idle.release({})).toEqual(['the declared GPU load did not run']);
  });

  it('validates the GPU load spec', () => {
    expect(normalizeGpuLoadSpec({ dutyCycle: 0.5 })).toEqual({ dutyCycle: 0.5, periodMs: 200, adapterLuid: null });
    expect(() => normalizeGpuLoadSpec({ dutyCycle: 0 })).toThrow(/dutyCycle/);
    expect(() => normalizeGpuLoadSpec({ dutyCycle: 1, adapterLuid: '0x1' })).toThrow(/adapterLuid/);
  });
});
