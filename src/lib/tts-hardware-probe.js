import { STORAGE_KEYS } from './storage-keys.js';

export const TTS_HARDWARE_PROBE_SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

export function createTtsHardwareProbeRecorder({ now = () => Date.now() } = {}) {
  const events = [];
  const fallbacks = [];
  const wasmThreadEvents = [];
  const sections = new Map();
  const sectionPauses = new Map();
  let selectedBackendPlan = null;
  let modelLoadMs = null;
  let firstSynthesisMs = null;
  let audioDurationSeconds = null;
  let realTimeFactor = null;
  const preTtsLatency = {
    panelReadyMs: null,
    extractionMs: null,
    chunkingMs: null,
    firstAudibleMs: null,
  };
  let timingSources = createEmptyTimingSourceCounts();
  const pauseThresholdMs = 250;

  function push(type, payload = {}) {
    events.push({
      ...payload,
      type,
      at: getNow(now),
    });
  }

  return {
    recordBackendPlan(plan = {}) {
      selectedBackendPlan = sanitizeBackendPlan(plan);
      push('backend-plan', { plan: selectedBackendPlan });
    },
    recordModelLoad({ loadMs } = {}) {
      modelLoadMs = normalizeFiniteNumber(loadMs);
      push('model-load', { loadMs: modelLoadMs });
    },
    recordPreTtsLatency(event = {}) {
      for (const key of ['panelReadyMs', 'extractionMs', 'chunkingMs', 'firstAudibleMs']) {
        const value = normalizeFiniteNumber(event[key]);
        if (value !== null) preTtsLatency[key] = value;
      }
      push('pre-tts-latency', { preTtsLatency: { ...preTtsLatency } });
    },
    recordFirstSynthesis({ synthesisMs, audioDurationSeconds: durationSeconds } = {}) {
      if (firstSynthesisMs !== null) return;
      firstSynthesisMs = normalizeFiniteNumber(synthesisMs);
      audioDurationSeconds = normalizeFiniteNumber(durationSeconds);
      realTimeFactor = getProbeRealTimeFactor({ synthesisMs: firstSynthesisMs, audioDurationSeconds });
      push('first-synthesis', {
        synthesisMs: firstSynthesisMs,
        audioDurationSeconds,
        realTimeFactor,
      });
    },
    recordTimingSources(wordTimings = []) {
      const counts = summarizeTimingSources(wordTimings);
      if (counts.total <= 0) return;
      timingSources = addTimingSourceCounts(timingSources, counts);
      push('timing-sources', { timingSources: { ...timingSources } });
    },
    recordWasmThreadDowngrade(event = {}) {
      const entry = {
        previousThreadCount: normalizePositiveInteger(event.previousThreadCount),
        threadCount: normalizePositiveInteger(event.threadCount),
        reason: event.reason || null,
      };
      if (entry.previousThreadCount === null || entry.threadCount === null) return;
      wasmThreadEvents.push(entry);
      push('wasm-thread-downgrade', entry);
    },
    recordSectionSynthesis({ sectionIndex, index, synthesisMs, audioDurationSeconds: durationSeconds } = {}) {
      const section = getOrCreateSection(sections, sectionIndex ?? index);
      if (!section) return;
      section.synthesisMs = normalizeFiniteNumber(synthesisMs);
      section.audioDurationSeconds = normalizeFiniteNumber(durationSeconds);
      section.realTimeFactor = getProbeRealTimeFactor({
        synthesisMs: section.synthesisMs,
        audioDurationSeconds: section.audioDurationSeconds,
      });
      section.synthesisEndedAtMs = getNow(now);
      push('section-synthesis', {
        sectionIndex: section.sectionIndex,
        synthesisMs: section.synthesisMs,
        audioDurationSeconds: section.audioDurationSeconds,
        realTimeFactor: section.realTimeFactor,
        synthesisEndedAtMs: section.synthesisEndedAtMs,
      });
    },
    recordSectionPlaybackStart({ sectionIndex, index } = {}) {
      const section = getOrCreateSection(sections, sectionIndex ?? index);
      if (!section || section.audioStartAtMs !== null) return;
      section.audioStartAtMs = getNow(now);
      push('section-audio-start', { sectionIndex: section.sectionIndex, audioStartAtMs: section.audioStartAtMs });
    },
    recordSectionPlaybackEnd({ sectionIndex, index } = {}) {
      const section = getOrCreateSection(sections, sectionIndex ?? index);
      if (!section) return;
      section.audioEndAtMs = getNow(now);
      section.playbackDurationMs = section.audioStartAtMs === null
        ? null
        : Math.max(0, section.audioEndAtMs - section.audioStartAtMs);
      push('section-audio-end', {
        sectionIndex: section.sectionIndex,
        audioEndAtMs: section.audioEndAtMs,
        playbackDurationMs: section.playbackDurationMs,
      });
    },
    recordSectionPause({ fromSectionIndex, toSectionIndex, pauseAppliedMs } = {}) {
      const from = normalizeSectionIndex(fromSectionIndex);
      const to = normalizeSectionIndex(toSectionIndex);
      if (from === null || to === null) return;
      const pauseMs = Math.max(0, normalizeFiniteNumber(pauseAppliedMs) ?? 0);
      sectionPauses.set(getTransitionKey(from, to), pauseMs);
      push('section-pause', { fromSectionIndex: from, toSectionIndex: to, pauseAppliedMs: pauseMs });
    },
    recordModelFallback(error, fallbackPlan = {}) {
      const fallback = {
        type: 'model',
        message: getErrorMessage(error),
        fallbackPlan: sanitizeBackendPlan(fallbackPlan),
      };
      fallbacks.push(fallback);
      push('model-fallback', fallback);
    },
    events() {
      return events.map((event) => ({ ...event }));
    },
    result() {
      const sectionResults = getSectionResults(sections);
      const flow = getSectionFlow(sectionResults, sectionPauses, { pauseThresholdMs });
      return {
        selectedBackendPlan,
        modelLoadMs,
        preTtsLatency: { ...preTtsLatency },
        firstSynthesisMs,
        audioDurationSeconds,
        realTimeFactor,
        timingSources: { ...timingSources },
        wasmThreadEvents: wasmThreadEvents.map((event) => ({ ...event })),
        sections: sectionResults,
        flow,
        fallbackOccurred: fallbacks.length > 0,
        fallbacks: fallbacks.map((fallback) => ({ ...fallback })),
      };
    },
  };
}

export function createTtsHardwareProbeSummaryCache({
  storage = globalThis.chrome?.storage?.local,
  now = () => Date.now(),
  ttlMs = TTS_HARDWARE_PROBE_SUMMARY_TTL_MS,
} = {}) {
  async function read() {
    if (!storage?.get) return null;
    const state = await storage.get(STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY);
    const entry = state?.[STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY];
    if (!entry?.summary || !Number.isFinite(Number(entry.savedAt))) return null;

    const age = getNow(now) - Number(entry.savedAt);
    if (age < 0 || age > ttlMs) {
      await storage.remove?.(STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY);
      return null;
    }
    return { ...entry.summary };
  }

  async function write(summary) {
    if (!storage?.set || !summary || typeof summary !== 'object') return false;
    await storage.set({
      [STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY]: {
        savedAt: getNow(now),
        summary: { ...summary },
      },
    });
    return true;
  }

  return { read, write };
}

function createEmptyTimingSourceCounts() {
  return {
    total: 0,
    aligned: 0,
    estimated: 0,
    phonemeEstimated: 0,
    unknown: 0,
  };
}

function summarizeTimingSources(wordTimings = []) {
  const counts = createEmptyTimingSourceCounts();
  if (!Array.isArray(wordTimings)) return counts;

  for (const timing of wordTimings) {
    counts.total += 1;
    switch (timing?.source) {
      case 'aligned':
        counts.aligned += 1;
        break;
      case 'estimated':
        counts.estimated += 1;
        break;
      case 'phoneme-estimated':
        counts.phonemeEstimated += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }
  }

  return counts;
}

function addTimingSourceCounts(left, right) {
  return {
    total: left.total + right.total,
    aligned: left.aligned + right.aligned,
    estimated: left.estimated + right.estimated,
    phonemeEstimated: left.phonemeEstimated + right.phonemeEstimated,
    unknown: left.unknown + right.unknown,
  };
}

export function getProbeRealTimeFactor({ synthesisMs, audioDurationSeconds } = {}) {
  if (synthesisMs === null || synthesisMs === undefined || audioDurationSeconds === null || audioDurationSeconds === undefined) {
    return null;
  }

  const synthesis = Number(synthesisMs);
  const duration = Number(audioDurationSeconds);
  if (!Number.isFinite(synthesis) || synthesis < 0 || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return synthesis / (duration * 1000);
}

export function createAudioProgressProbeObserver({
  audio,
  sectionIndex = null,
  intervalMs = 125,
  onStart,
  onEnd,
  now = () => Date.now(),
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  if (!audio || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    return { stop() {} };
  }

  let started = false;
  let ended = false;
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    const currentTime = Number(audio.currentTime);
    const duration = Number(audio.duration);
    const hasProgress = Number.isFinite(currentTime) && currentTime > 0;
    if (!started && hasProgress && audio.paused !== true) {
      started = true;
      onStart?.(createAudioProgressEvent({ sectionIndex, currentTime, now }));
    }

    const reachedEnd = audio.ended === true
      || (
        Number.isFinite(duration)
        && duration > 0
        && Number.isFinite(currentTime)
        && currentTime >= Math.max(0, duration - 0.05)
      );
    if (!ended && reachedEnd) {
      ended = true;
      if (!started) {
        started = true;
        onStart?.(createAudioProgressEvent({ sectionIndex, currentTime, now }));
      }
      onEnd?.(createAudioProgressEvent({ sectionIndex, currentTime, now }));
      stop();
    }
  };
  const intervalId = setIntervalFn(poll, Math.max(25, Math.trunc(Number(intervalMs) || 125)));

  function stop() {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(intervalId);
  }

  return { stop };
}

function createAudioProgressEvent({ sectionIndex, currentTime, now }) {
  return {
    sectionIndex,
    observedCurrentTime: Number.isFinite(currentTime) ? currentTime : null,
    observedAtMs: getNow(now),
    source: 'audio-progress',
  };
}

function sanitizeBackendPlan(plan = {}) {
  return {
    device: plan.device || null,
    dtype: plan.dtype || null,
    reason: plan.reason || null,
    cpuBudgetTarget: typeof plan.cpuBudgetTarget === 'boolean' ? plan.cpuBudgetTarget : null,
  };
}

function normalizeFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function getOrCreateSection(sections, sectionIndex) {
  const index = normalizeSectionIndex(sectionIndex);
  if (index === null) return null;
  if (!sections.has(index)) {
    sections.set(index, {
      sectionIndex: index,
      synthesisMs: null,
      audioDurationSeconds: null,
      realTimeFactor: null,
      synthesisEndedAtMs: null,
      audioStartAtMs: null,
      audioEndAtMs: null,
      playbackDurationMs: null,
    });
  }
  return sections.get(index);
}

function getSectionResults(sections) {
  return [...sections.values()]
    .sort((left, right) => left.sectionIndex - right.sectionIndex)
    .map((section) => ({ ...section }));
}

function getSectionFlow(sections, sectionPauses, { pauseThresholdMs }) {
  const sectionLoadTransitions = getSectionLoadTransitions(sections);
  const interSectionGaps = [];
  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1];
    const current = sections[index];
    if (previous.audioEndAtMs === null || current.audioStartAtMs === null) continue;
    const gapMs = Math.max(0, current.audioStartAtMs - previous.audioEndAtMs);
    const pauseAppliedMs = sectionPauses.get(getTransitionKey(previous.sectionIndex, current.sectionIndex)) || 0;
    const unplannedGapMs = Math.max(0, gapMs - pauseAppliedMs);
    interSectionGaps.push({
      fromSectionIndex: previous.sectionIndex,
      toSectionIndex: current.sectionIndex,
      gapMs,
      pauseAppliedMs,
      unplannedGapMs,
      pauseDetected: unplannedGapMs > pauseThresholdMs,
    });
  }

  const totalGapMs = interSectionGaps.reduce((sum, gap) => sum + gap.gapMs, 0);
  return {
    sectionCount: sections.length,
    loadTransitionCount: sectionLoadTransitions.length,
    measuredTransitionCount: interSectionGaps.length,
    audioPlaybackObserved: interSectionGaps.length > 0 || sections.some((section) => section.audioStartAtMs !== null),
    pauseThresholdMs,
    maxNextSectionReadyGapMs: sectionLoadTransitions.length
      ? Math.max(...sectionLoadTransitions.map((transition) => transition.nextSectionReadyGapMs))
      : null,
    sectionLoadTransitions,
    maxInterSectionGapMs: interSectionGaps.length
      ? Math.max(...interSectionGaps.map((gap) => gap.gapMs))
      : null,
    averageInterSectionGapMs: interSectionGaps.length
      ? totalGapMs / interSectionGaps.length
      : null,
    pauseCount: interSectionGaps.filter((gap) => gap.pauseDetected).length,
    interSectionGaps,
  };
}

function getSectionLoadTransitions(sections) {
  const transitions = [];
  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1];
    const current = sections[index];
    if (previous.synthesisEndedAtMs === null || current.synthesisEndedAtMs === null) continue;
    transitions.push({
      fromSectionIndex: previous.sectionIndex,
      toSectionIndex: current.sectionIndex,
      nextSectionReadyGapMs: Math.max(0, current.synthesisEndedAtMs - previous.synthesisEndedAtMs),
    });
  }
  return transitions;
}

function normalizeSectionIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}

function getTransitionKey(fromSectionIndex, toSectionIndex) {
  return `${fromSectionIndex}->${toSectionIndex}`;
}

function getErrorMessage(error) {
  return error?.message || String(error || '');
}

function getNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}
