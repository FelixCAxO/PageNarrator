export {
  AUDIO_ENDED_GAP_MAX_DELAY_MS,
  AUDIO_ENDED_GAP_THRESHOLD_SECONDS,
  DEFAULT_AUDIO_WATCHDOG_DELAY_MS,
  FAST_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS,
  HIGHLIGHT_PLAN_RESYNC_DRIFT_SECONDS,
  NORMAL_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS,
  SECTION_EARLY_ADVANCE_TAIL_SECONDS,
  WORD_HIGHLIGHT_LEAD_SECONDS,
} from '../timing-config.js';
import {
  AUDIO_ENDED_GAP_MAX_DELAY_MS,
  AUDIO_ENDED_GAP_THRESHOLD_SECONDS,
  DEFAULT_AUDIO_WATCHDOG_DELAY_MS,
  FAST_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS,
  HIGHLIGHT_PLAN_RESYNC_DRIFT_SECONDS,
  NORMAL_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS,
  SECTION_EARLY_ADVANCE_TAIL_SECONDS,
  WORD_HIGHLIGHT_LEAD_SECONDS,
} from '../timing-config.js';
import {
  normalizeNonNegative,
  normalizePositive,
} from '../number-validation.js';

export function getPlaybackRateAdjustedLeadSeconds(playbackRate, baseLeadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS) {
  const base = Number.isFinite(Number(baseLeadSeconds)) ? Number(baseLeadSeconds) : 0;
  const rate = normalizePositive(playbackRate, 1);
  return base * rate;
}

/**
 * @param {Record<string, any>} options
 */
export function getOutputLatencyAdjustedLeadSeconds({
  playbackRate = 1,
  baseLeadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS,
  outputLatencySeconds = 0,
} = {}) {
  const rate = normalizePositive(playbackRate, 1);
  const latency = normalizePositive(outputLatencySeconds, 0);
  return getPlaybackRateAdjustedLeadSeconds(rate, baseLeadSeconds) - (latency * rate);
}

export function getHighlightedWordIndex(wordTimings, currentTime, leadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS) {
  if (!Array.isArray(wordTimings) || !wordTimings.length || !Number.isFinite(currentTime)) return -1;

  const effectiveTime = currentTime + (Number.isFinite(Number(leadSeconds)) ? Number(leadSeconds) : 0);
  for (let index = 0; index < wordTimings.length; index += 1) {
    const timing = wordTimings[index];
    if (effectiveTime >= timing.start && effectiveTime < timing.end) return index;
  }

  const lastIndex = wordTimings.length - 1;
  if (effectiveTime >= wordTimings[lastIndex].end) return lastIndex;
  return -1;
}

/**
 * @param {Array<Record<string, any>>} wordTimings
 * @param {Record<string, any>} options
 */
export function createWordHighlightPlan(wordTimings, {
  leadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS,
  mapWordIndex = (index) => index,
} = {}) {
  if (!Array.isArray(wordTimings) || !wordTimings.length) return [];

  const lead = Number.isFinite(Number(leadSeconds)) ? Number(leadSeconds) : 0;
  return wordTimings
    .map((timing, speechIndex) => {
      const start = Number(timing?.start);
      const end = Number(timing?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

      const mapped = Number(mapWordIndex(speechIndex, timing));
      const index = Number.isFinite(mapped) ? Math.trunc(mapped) : -1;
      const confidence = Number(timing?.confidence);
      return {
        speechIndex,
        index,
        synthetic: index < 0,
        start,
        end,
        highlightAt: Math.max(0, start - lead),
        endAt: Math.max(0, end - lead),
        text: timing?.text ?? null,
        confidence: Number.isFinite(confidence) ? confidence : null,
      };
    })
    .filter(Boolean);
}

export function createWordHighlightTracker(wordTimings, leadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS) {
  let lastWordIndex = -1;

  return {
    update(currentTime, nextLeadSeconds = leadSeconds) {
      const index = getHighlightedWordIndex(wordTimings, currentTime, nextLeadSeconds);
      if (index === -1 || index <= lastWordIndex) return [];
      const crossed = [];
      const start = lastWordIndex < 0 ? index : lastWordIndex + 1;
      for (let nextIndex = start; nextIndex <= index; nextIndex += 1) {
        crossed.push(nextIndex);
      }
      lastWordIndex = index;
      return crossed;
    },
  };
}

/**
 * @param {Record<string, any>} options
 */
export function startWordHighlightLoop({
  wordTimings,
  getCurrentTime,
  getPlaybackRate,
  onHighlight,
  leadSeconds = WORD_HIGHLIGHT_LEAD_SECONDS,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
} = {}) {
  if (!Array.isArray(wordTimings) || !wordTimings.length) return () => {};
  if (typeof getCurrentTime !== 'function' || typeof onHighlight !== 'function' || typeof requestFrame !== 'function') {
    return () => {};
  }

  const tracker = createWordHighlightTracker(wordTimings, leadSeconds);
  let frameId = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const currentLeadSeconds = typeof getPlaybackRate === 'function'
      ? getPlaybackRateAdjustedLeadSeconds(getPlaybackRate(), leadSeconds)
      : leadSeconds;
    const indices = tracker.update(getCurrentTime(), currentLeadSeconds);
    for (const index of indices) onHighlight(index);
    frameId = requestFrame(tick);
  };

  tick();

  return () => {
    stopped = true;
    if (frameId !== null && typeof cancelFrame === 'function') cancelFrame(frameId);
  };
}

export function getAudioWatchdogDelayMs(durationSeconds, playbackRate = 1) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return DEFAULT_AUDIO_WATCHDOG_DELAY_MS;

  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const playbackMs = (durationSeconds / rate) * 1000;
  const bufferMs = rate > 1
    ? FAST_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS
    : NORMAL_PLAYBACK_AUDIO_WATCHDOG_BUFFER_MS;
  return Math.round(playbackMs + bufferMs);
}

/**
 * @param {Record<string, any>} options
 */
export function getAudioEndedGapDelayMs({
  durationSeconds,
  currentTimeSeconds,
  playbackRate = 1,
  thresholdSeconds = AUDIO_ENDED_GAP_THRESHOLD_SECONDS,
  maxDelayMs = AUDIO_ENDED_GAP_MAX_DELAY_MS,
} = {}) {
  const duration = Number(durationSeconds);
  const currentTime = Number(currentTimeSeconds);
  const gap = duration - currentTime;
  const threshold = normalizePositive(thresholdSeconds, 0);
  if (!Number.isFinite(gap) || gap <= threshold) return 0;

  const rate = normalizePositive(playbackRate, 1);
  const delayMs = Math.round((gap / rate) * 1000);
  const capMs = normalizeNonNegative(maxDelayMs, AUDIO_ENDED_GAP_MAX_DELAY_MS);
  return Math.max(0, Math.min(delayMs, capMs));
}

export function createHighlightPlanResyncTracker({
  driftThresholdSeconds = HIGHLIGHT_PLAN_RESYNC_DRIFT_SECONDS,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const threshold = Number.isFinite(Number(driftThresholdSeconds)) && Number(driftThresholdSeconds) >= 0
    ? Number(driftThresholdSeconds)
    : HIGHLIGHT_PLAN_RESYNC_DRIFT_SECONDS;
  let hasSync = false;
  let lastCurrentTime = 0;
  let lastWallTimeMs = 0;
  let lastPlaybackRate = 1;
  let lastPaused = false;

  const getNowMs = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const normalizePlaybackRate = (playbackRate) => (
    Number.isFinite(Number(playbackRate)) && Number(playbackRate) > 0 ? Number(playbackRate) : 1
  );

  const normalizeCurrentTime = (currentTime) => (
    Number.isFinite(Number(currentTime)) && Number(currentTime) > 0 ? Number(currentTime) : 0
  );

  return {
    markSync({ currentTime = 0, playbackRate = 1, paused = false } = {}) {
      hasSync = true;
      lastCurrentTime = normalizeCurrentTime(currentTime);
      lastPlaybackRate = normalizePlaybackRate(playbackRate);
      lastPaused = Boolean(paused);
      lastWallTimeMs = getNowMs();
    },
    shouldResync({ currentTime = 0, playbackRate = 1, paused = false } = {}) {
      const nextCurrentTime = normalizeCurrentTime(currentTime);
      const nextPlaybackRate = normalizePlaybackRate(playbackRate);
      const nextPaused = Boolean(paused);
      if (!hasSync) return true;
      if (nextPaused !== lastPaused) return true;
      if (Math.abs(nextPlaybackRate - lastPlaybackRate) > 0.001) return true;

      const elapsedSeconds = lastPaused ? 0 : Math.max(0, (getNowMs() - lastWallTimeMs) / 1000);
      const expectedCurrentTime = lastCurrentTime + (elapsedSeconds * lastPlaybackRate);
      return Math.abs(nextCurrentTime - expectedCurrentTime) > threshold;
    },
  };
}

/**
 * @param {any} audio
 * @param {Record<string, any>} options
 */
export function fadeOutAudioThenPause(audio, {
  durationMs = 60,
  frameMs = 16,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  now = Date.now,
  onComplete,
} = {}) {
  if (!audio || typeof audio.pause !== 'function') {
    if (typeof onComplete === 'function') onComplete();
    return () => {};
  }

  const totalMs = Math.max(0, Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0);
  const stepMs = Math.max(1, Number.isFinite(Number(frameMs)) ? Number(frameMs) : 16);
  const originalVolume = Number.isFinite(Number(audio.volume))
    ? Math.max(0, Math.min(1, Number(audio.volume)))
    : 1;

  let timerId = null;
  let completed = false;
  const startedAt = Number.isFinite(Number(now())) ? Number(now()) : Date.now();

  const restoreVolume = () => {
    try {
      audio.volume = originalVolume;
    } catch {
      // Some test doubles or browser states can reject volume writes during cleanup.
    }
  };

  const complete = () => {
    if (completed) return;
    completed = true;
    if (timerId !== null && typeof clearTimer === 'function') clearTimer(timerId);
    timerId = null;
    try {
      audio.volume = 0;
    } catch {
      // Best-effort fade; pausing still completes the early advance.
    }
    audio.pause();
    restoreVolume();
    if (typeof onComplete === 'function') onComplete();
  };

  if (totalMs <= 0 || typeof setTimer !== 'function') {
    complete();
    return () => {};
  }

  const tick = () => {
    if (completed) return;
    const currentNow = Number.isFinite(Number(now())) ? Number(now()) : Date.now();
    const progress = Math.min(1, Math.max(0, (currentNow - startedAt) / totalMs));
    try {
      audio.volume = Math.max(0, originalVolume * (1 - progress));
    } catch {
      complete();
      return;
    }
    if (progress >= 1) {
      complete();
      return;
    }
    timerId = setTimer(tick, Math.min(stepMs, Math.max(1, totalMs - (currentNow - startedAt))));
  };

  timerId = setTimer(tick, Math.min(stepMs, totalMs));

  return () => {
    if (completed) return;
    completed = true;
    if (timerId !== null && typeof clearTimer === 'function') clearTimer(timerId);
    timerId = null;
    restoreVolume();
  };
}

/**
 * @param {Record<string, any>} options
 */
export function getSectionEarlyAdvanceDelayMs({
  currentTime = 0,
  durationSeconds,
  playbackRate = 1,
  wordTimings,
  advanceSeconds = 0,
  tailSeconds = SECTION_EARLY_ADVANCE_TAIL_SECONDS,
} = {}) {
  const advance = Number(advanceSeconds);
  if (!Number.isFinite(advance) || advance <= 0) return null;

  const duration = Number(durationSeconds);
  const speechEnd = Number(Array.isArray(wordTimings) ? wordTimings.at(-1)?.end : Number.NaN);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(speechEnd) || speechEnd <= 0 || speechEnd >= duration) {
    return null;
  }

  const safeTail = Number.isFinite(tailSeconds) && tailSeconds > 0 ? tailSeconds : 0;
  const earliestSafeAdvanceAt = Math.min(duration, speechEnd + safeTail);
  const requestedAdvanceAt = duration - advance;
  const advanceAt = Math.max(earliestSafeAdvanceAt, requestedAdvanceAt);
  if (!Number.isFinite(advanceAt) || advanceAt >= duration) return null;

  const current = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return Math.round((Math.max(0, advanceAt - current) / rate) * 1000);
}

/**
 * @param {Record<string, any>} options
 */
export function createAudioStallWatchdog({
  delayMs = DEFAULT_AUDIO_WATCHDOG_DELAY_MS,
  onStall,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  now = Date.now,
} = {}) {
  if (typeof onStall !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    return {
      pause() {},
      resume() {},
      dispose() {},
    };
  }

  const totalDelay = Math.max(0, Number.isFinite(delayMs) ? delayMs : DEFAULT_AUDIO_WATCHDOG_DELAY_MS);
  let remainingMs = totalDelay;
  let startedAt = 0;
  let timerId = null;
  let disposed = false;
  let paused = false;

  const arm = () => {
    if (disposed || paused) return;
    startedAt = now();
    timerId = setTimer(() => {
      timerId = null;
      if (!disposed && !paused) onStall();
    }, remainingMs);
  };

  arm();

  return {
    pause() {
      if (disposed || paused) return;
      paused = true;
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
        remainingMs = Math.max(0, remainingMs - (now() - startedAt));
      }
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      arm();
    },
    dispose() {
      disposed = true;
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
    },
  };
}

/**
 * @param {Record<string, any>} options
 */
export function createPauseableDelay({
  delayMs = 0,
  onComplete,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  now = Date.now,
} = {}) {
  if (typeof onComplete !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    return {
      pause() {},
      resume() {},
      complete() {},
    };
  }

  let remainingMs = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
  let startedAt = 0;
  let timerId = null;
  let completed = false;
  let paused = false;

  const complete = () => {
    if (completed) return;
    completed = true;
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    onComplete();
  };

  const arm = () => {
    if (completed || paused) return;
    if (remainingMs <= 0) {
      complete();
      return;
    }

    startedAt = now();
    timerId = setTimer(complete, remainingMs);
  };

  arm();

  return {
    pause() {
      if (completed || paused) return;
      paused = true;
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
        remainingMs = Math.max(0, remainingMs - (now() - startedAt));
      }
    },
    resume() {
      if (completed || !paused) return;
      paused = false;
      arm();
    },
    complete,
  };
}
