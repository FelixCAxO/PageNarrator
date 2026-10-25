import { describe, expect, it } from 'vitest';
import { createReaderEngineTtsProbeController } from '../../src/lib/reader-engine-tts-probe-controller.js';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';

function createMemoryStorage(initial = {}) {
  const state = { ...initial };
  const writes = [];

  return {
    writes,
    async get(key) {
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((entry) => [entry, state[entry]]));
      }
      if (typeof key === 'string') {
        return { [key]: state[key] };
      }
      return { ...state };
    },
    async set(values) {
      Object.assign(state, values);
      writes.push(values);
    },
    async remove(key) {
      delete state[key];
    },
  };
}

describe('readerEngine TTS probe controller', () => {
  it('reads the cached summary but leaves recording disabled when the probe flag is off', async () => {
    const summary = { selectedBackendPlan: { device: 'wasm' } };
    const rawStorage = createMemoryStorage({
      [STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY]: {
        savedAt: 1000,
        summary,
      },
    });
    const readerEngineStorage = {
      rawStorage,
      async get(key) {
        return { [key]: { enabled: false } };
      },
    };
    const cachedSummaries = [];
    const globalObject = {};

    const controller = createReaderEngineTtsProbeController({
      readerEngineStorage,
      storageKey: STORAGE_KEYS.TTS_HARDWARE_PROBE,
      now: () => 1100,
      setCachedSummary: (value) => cachedSummaries.push(value),
      globalObject,
    });

    await controller.init();
    controller.recordBackendPlan({ device: 'webgpu' });

    expect(cachedSummaries).toEqual([summary]);
    expect(globalObject.__pagenarratorTtsProbe).toBeUndefined();
    expect(rawStorage.writes).toEqual([]);
  });

  it('publishes and persists each enabled probe recording update', async () => {
    let now = 2000;
    const rawStorage = createMemoryStorage();
    const readerEngineStorage = {
      rawStorage,
      async get(key) {
        return { [key]: { enabled: true } };
      },
    };
    const cachedSummaries = [];
    const globalObject = {};

    const controller = createReaderEngineTtsProbeController({
      readerEngineStorage,
      storageKey: STORAGE_KEYS.TTS_HARDWARE_PROBE,
      now: () => now,
      setCachedSummary: (value) => cachedSummaries.push(value),
      globalObject,
    });

    await controller.init();
    controller.recordBackendPlan({ device: 'webgpu', dtype: 'fp32' });
    now = 2400;
    controller.recordPreTtsLatency({ panelReadyMs: 800, extractionMs: 420, chunkingMs: 35 });
    controller.recordModelLoad({ loadMs: 400 });

    expect(globalObject.__pagenarratorTtsProbe.events.map((event) => event.type)).toEqual([
      'backend-plan',
      'pre-tts-latency',
      'model-load',
    ]);
    expect(globalObject.__pagenarratorTtsProbe.result).toMatchObject({
      selectedBackendPlan: {
        device: 'webgpu',
        dtype: 'fp32',
      },
      modelLoadMs: 400,
      preTtsLatency: {
        panelReadyMs: 800,
        extractionMs: 420,
        chunkingMs: 35,
        firstAudibleMs: null,
      },
      fallbackOccurred: false,
    });
    expect(cachedSummaries.at(-1)).toEqual(globalObject.__pagenarratorTtsProbe.result);
    expect(rawStorage.writes.at(-1)[STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY].summary)
      .toEqual(globalObject.__pagenarratorTtsProbe.result);
  });

  it('records section readiness and forwards transition decisions through injected callbacks', async () => {
    let now = 3000;
    const rawStorage = createMemoryStorage();
    const readerEngineStorage = {
      rawStorage,
      async get(key) {
        return { [key]: { enabled: true } };
      },
    };
    const readyEvents = [];
    const renderedDecisions = [];
    const tracker = {
      recordSectionReady(event) {
        readyEvents.push(event);
      },
    };

    const controller = createReaderEngineTtsProbeController({
      readerEngineStorage,
      storageKey: STORAGE_KEYS.TTS_HARDWARE_PROBE,
      now: () => now,
      getSectionReadyTransitionTracker: () => tracker,
      recordSectionTransitionDecision: (event) => ({ ...event, decision: 'keep-profile' }),
      renderGovernorDecision: (decision) => renderedDecisions.push(decision),
      globalObject: {},
    });

    await controller.init();
    controller.recordSectionSynthesisWithReadyTransition({
      sectionIndex: 2,
      synthesisMs: 120,
      audioDurationSeconds: 1.5,
      readyAtMs: 3100,
    });
    now = 3300;
    controller.recordSectionSynthesisWithReadyTransition({
      sectionIndex: 3,
      synthesisMs: 100,
      audioDurationSeconds: 1,
    });
    controller.recordSectionTransition({ fromSectionIndex: 2, toSectionIndex: 3 });

    expect(readyEvents).toEqual([
      { sectionIndex: 2, readyAtMs: 3100 },
      { sectionIndex: 3, readyAtMs: 3300 },
    ]);
    expect(renderedDecisions).toEqual([
      { fromSectionIndex: 2, toSectionIndex: 3, decision: 'keep-profile' },
    ]);
  });
});
