import { describe, expect, it } from 'vitest';
import {
  TTS_HARDWARE_PROBE_SUMMARY_TTL_MS,
  createTtsHardwareProbeSummaryCache,
} from '../../src/lib/tts-hardware-probe.js';
import { createTtsPerformanceGovernor } from '../../src/lib/tts-performance-profile.js';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';

function createMemoryStorage(initial = {}) {
  let state = { ...initial };
  return {
    state: () => state,
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(keyList.filter((key) => key in state).map((key) => [key, state[key]]));
    },
    async set(values) {
      state = { ...state, ...values };
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

describe('TTS hardware probe summary cache', () => {
  it('persists probe summaries for one day and expires stale entries', async () => {
    let now = 1_800_000_000_000;
    const storage = createMemoryStorage();
    const cache = createTtsHardwareProbeSummaryCache({ storage, now: () => now });

    await cache.write({ realTimeFactor: 1.2, selectedBackendPlan: { device: 'wasm' } });

    expect(storage.state()[STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY]).toMatchObject({
      savedAt: now,
      summary: { realTimeFactor: 1.2, selectedBackendPlan: { device: 'wasm' } },
    });
    await expect(cache.read()).resolves.toMatchObject({
      realTimeFactor: 1.2,
      selectedBackendPlan: { device: 'wasm' },
    });

    now += TTS_HARDWARE_PROBE_SUMMARY_TTL_MS + 1;
    await expect(cache.read()).resolves.toBeNull();
    expect(storage.state()[STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY]).toBeUndefined();
  });

  it('biases auto profile selection toward balanced complete chunks on a cached slow CPU probe', () => {
    const governor = createTtsPerformanceGovernor({
      setting: 'auto',
      navigator: { gpu: {}, deviceMemory: 16, hardwareConcurrency: 8 },
      hardwareProbeSummary: {
        realTimeFactor: 1.2,
        selectedBackendPlan: { device: 'wasm', cpuBudgetTarget: true },
      },
    });

    expect(governor.currentProfile()).toBe('balanced');
    expect(governor.currentConfig()).toMatchObject({
      maxChunkLength: 240,
      preloadAhead: 3,
      progressiveSegments: false,
    });
  });
});
