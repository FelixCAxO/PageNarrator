import {
  createTtsHardwareProbeRecorder,
  createTtsHardwareProbeSummaryCache,
} from './tts-hardware-probe.js';
import { STORAGE_KEYS } from './storage-keys.js';

/** @param {any} [deps] */
export function createReaderEngineTtsProbeController({
  readerEngineStorage,
  summaryStorage = readerEngineStorage?.rawStorage,
  storageKey = STORAGE_KEYS.TTS_HARDWARE_PROBE,
  now = () => Date.now(),
  suppressError = () => {},
  globalObject = globalThis,
  setCachedSummary = () => {},
  getSectionReadyTransitionTracker = () => null,
  recordSectionTransitionDecision = () => null,
  renderGovernorDecision = () => {},
} = {}) {
  const summaryCache = createTtsHardwareProbeSummaryCache({ storage: summaryStorage, now });
  let recorder = null;

  async function init() {
    const cachedSummary = await summaryCache.read().catch(suppressError);
    setCachedSummary(cachedSummary ?? null);

    const stored = typeof readerEngineStorage?.get === 'function'
      ? await readerEngineStorage.get(storageKey).catch(suppressError)
      : null;
    if (stored?.[storageKey]?.enabled !== true) return false;

    recorder = createTtsHardwareProbeRecorder({ now });
    globalObject.__pagenarratorTtsProbe = {
      events: [],
      result: null,
    };
    publish();
    return true;
  }

  function publish() {
    if (!recorder || !globalObject.__pagenarratorTtsProbe) return null;

    globalObject.__pagenarratorTtsProbe.events = recorder.events();
    const result = recorder.result();
    globalObject.__pagenarratorTtsProbe.result = result;
    setCachedSummary(result);
    void summaryCache.write(result).catch(suppressError);
    return result;
  }

  function record(applyRecord) {
    if (!recorder) return null;
    applyRecord(recorder);
    return publish();
  }

  function recordSectionSynthesisWithReadyTransition(event = {}) {
    record((activeRecorder) => activeRecorder.recordSectionSynthesis(event));

    const sectionIndex = Number(event.sectionIndex);
    const readyAtMs = Number.isFinite(Number(event.readyAtMs)) ? Number(event.readyAtMs) : getNowMs(now);
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return;

    getSectionReadyTransitionTracker()?.recordSectionReady({ sectionIndex, readyAtMs });
  }

  function recordSectionTransition(event) {
    renderGovernorDecision(recordSectionTransitionDecision(event));
  }

  function isRecordingEnabled() {
    return Boolean(recorder);
  }

  return {
    init,
    isRecordingEnabled,
    publish,
    recordBackendPlan: (plan) => record((activeRecorder) => activeRecorder.recordBackendPlan(plan)),
    recordModelFallback: (error, fallbackPlan) => record((activeRecorder) => {
      activeRecorder.recordModelFallback(error, fallbackPlan);
    }),
    recordPreTtsLatency: (event) => record((activeRecorder) => activeRecorder.recordPreTtsLatency(event)),
    recordModelLoad: (event) => record((activeRecorder) => activeRecorder.recordModelLoad(event)),
    recordFirstSynthesis: (event) => record((activeRecorder) => activeRecorder.recordFirstSynthesis(event)),
    recordTimingSources: (wordTimings) => record((activeRecorder) => activeRecorder.recordTimingSources(wordTimings)),
    recordWasmThreadDowngrade: (event) => record((activeRecorder) => activeRecorder.recordWasmThreadDowngrade(event)),
    recordSectionSynthesis: (event) => record((activeRecorder) => activeRecorder.recordSectionSynthesis(event)),
    recordSectionSynthesisWithReadyTransition,
    recordSectionTransition,
    recordSectionPlaybackStart: (event) => record((activeRecorder) => activeRecorder.recordSectionPlaybackStart(event)),
    recordSectionPlaybackEnd: (event) => record((activeRecorder) => activeRecorder.recordSectionPlaybackEnd(event)),
    recordSectionPause: (event) => record((activeRecorder) => activeRecorder.recordSectionPause(event)),
  };
}

function getNowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}
