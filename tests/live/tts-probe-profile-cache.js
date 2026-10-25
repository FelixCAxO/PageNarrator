import { createLaneProfile, MIB } from './tts-probe-profile-builders.js';
import { OUTCOMES } from './tts-probe-profile-resources.js';

// Model acquisition and cache lanes. Each run has its own network condition;
// offline is CDP network emulation on the toolbar-player page (the context
// that downloads models), verified per run by a blocked probe request.
export const OFFLINE_INJECTION = Object.freeze({
  kind: 'network-offline',
  label: 'CDP offline emulation for the toolbar-player page; verified by a blocked request to the model host',
});

export const CACHE_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'offline_warm_webgpu',
    label: 'Warm cache, then offline reads in the same browser (Auto processing)',
    lane: 'cache',
    faults: [OFFLINE_INJECTION],
    runConditions: [
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL },
      { network: 'offline', expectedOutcome: OUTCOMES.LOCAL_MODEL },
      { network: 'offline', expectedOutcome: OUTCOMES.LOCAL_MODEL },
    ],
    expected: { execution: ['webgpu'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
  createLaneProfile({
    name: 'offline_restart_wasm',
    label: 'Warm cache, browser restart with the same profile, offline read (CPU / WebAssembly)',
    lane: 'cache',
    playbackSettings: { ttsBackendPreference: 'wasm' },
    faults: [OFFLINE_INJECTION],
    runConditions: [
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL },
      { network: 'offline', restartBrowser: true, expectedOutcome: OUTCOMES.LOCAL_MODEL },
    ],
    expected: { execution: ['wasm'], outcomes: [OUTCOMES.LOCAL_MODEL] },
  }),
  createLaneProfile({
    name: 'offline_cold',
    label: 'Fresh profile with no cached model, offline from the first read',
    lane: 'cache',
    faults: [OFFLINE_INJECTION],
    runConditions: [{ network: 'offline', expectedOutcome: OUTCOMES.EXPLICIT_ERROR }],
    expected: { execution: [null, 'webgpu', 'wasm'], outcomes: [OUTCOMES.EXPLICIT_ERROR] },
  }),
  createLaneProfile({
    name: 'offline_backend_switch',
    label: 'Warm WebGPU cache, then CPU / WebAssembly selected while offline (different model files)',
    lane: 'cache',
    faults: [OFFLINE_INJECTION],
    runConditions: [
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL },
      { network: 'offline', playbackSettings: { ttsBackendPreference: 'wasm' }, expectedOutcome: OUTCOMES.EXPLICIT_ERROR },
    ],
    expected: { execution: ['webgpu', 'wasm', null], outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.EXPLICIT_ERROR] },
  }),
]);

export const DOWNLOAD_INTERRUPTION = Object.freeze({
  kind: 'model-download-interrupted',
  label: 'CDP Fetch resets the connection after the model file response headers; tokenizer and voice files load normally',
});

export const STORAGE_QUOTA = Object.freeze({
  kind: 'storage-quota',
  label: 'CDP Storage.overrideQuotaForOrigin limits the extension origin; verified with navigator.storage.estimate()',
});

export const CACHE_EVICTION = Object.freeze({
  kind: 'cache-eviction',
  label: 'Cache Storage of the extension origin deleted between runs; verified by the model files removed',
});

export const CACHE_FAULT_TTS_PROBE_PROFILES = Object.freeze([
  createLaneProfile({
    name: 'download_interrupted_webgpu',
    label: 'Model download interrupted on first use, then retried online',
    lane: 'cache',
    faults: [DOWNLOAD_INTERRUPTION],
    runConditions: [
      { network: 'online', fault: DOWNLOAD_INTERRUPTION.kind, expectedOutcome: OUTCOMES.EXPLICIT_ERROR },
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL, expectedCacheState: 'download-cold' },
    ],
    expected: { execution: ['webgpu', 'wasm', null], outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.EXPLICIT_ERROR] },
  }),
  createLaneProfile({
    name: 'storage_quota_64mib_webgpu',
    label: 'Extension storage quota limited to 64 MiB, smaller than the model',
    lane: 'cache',
    faults: [STORAGE_QUOTA],
    runConditions: [
      { network: 'online', fault: STORAGE_QUOTA.kind, quotaBytes: 64 * MIB },
      { network: 'online', fault: STORAGE_QUOTA.kind, quotaBytes: 64 * MIB, expectedCacheState: 'download-cold' },
    ],
    expected: {
      execution: ['webgpu', 'wasm', null],
      outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.PERMITTED_FALLBACK, OUTCOMES.EXPLICIT_ERROR],
    },
  }),
  createLaneProfile({
    name: 'cache_evicted_webgpu',
    label: 'Warm cache evicted, then offline (clear error expected), then online (re-download expected)',
    lane: 'cache',
    faults: [OFFLINE_INJECTION, CACHE_EVICTION],
    runConditions: [
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL },
      { network: 'offline', evictCacheBefore: true, expectedOutcome: OUTCOMES.EXPLICIT_ERROR },
      { network: 'online', expectedOutcome: OUTCOMES.LOCAL_MODEL, expectedCacheState: 'download-cold' },
    ],
    expected: { execution: ['webgpu', 'wasm', null], outcomes: [OUTCOMES.LOCAL_MODEL, OUTCOMES.EXPLICIT_ERROR] },
  }),
]);
