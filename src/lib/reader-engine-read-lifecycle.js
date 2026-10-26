import { t } from './i18n.js';
import {
  normalizeNonNegativeInteger as normalizeNonNegativeIntegerValue,
  normalizePositiveInteger as normalizePositiveIntegerValue,
} from './number-validation.js';
import { createLogger, createSuppressedErrorHandler } from './logger.js';
import { TUNING_CONFIG } from './tuning-config.js';
import { STREAM_SYNTHESIS_TIMEOUT_MS } from './timing-config.js';

export const EMPTY_ARTICLE_TEXT_MESSAGE = t("Could not detect article text");
export const KEEP_FULL_CHUNK_HISTORY_LIMIT = 250;
export const READ_STREAM_CLEANUP_TIMEOUT_MS = 1000;
const ACTIVE_READ_STATES = new Set(['preparing', 'reading', 'paused']);

const readLifecycleLogger = createLogger('reader-engine-read-lifecycle');
const suppressReadLifecycleError = createSuppressedErrorHandler(readLifecycleLogger, 'Best-effort read lifecycle cleanup failed.');
export function createReadRunTracker({
  createAbortController = () => new AbortController(),
} = {}) {
  let activeRunId = 0;
  let activeController = null;
  const controllers = new Map();

  return {
    beginRun() {
      activeController?.abort?.();
      activeRunId += 1;
      activeController = createAbortController();
      controllers.set(activeRunId, activeController);
      pruneOldRunControllers(controllers, activeRunId);
      return activeRunId;
    },
    abortCurrentRun() {
      if (!activeController || activeController.signal?.aborted) return false;
      activeController.abort();
      return true;
    },
    getRunSignal(runId = activeRunId) {
      return controllers.get(runId)?.signal || null;
    },
    isCurrentRun(runId) {
      return runId === activeRunId;
    },
    isRunStopped(runId) {
      if (runId !== activeRunId) return true;
      return Boolean(controllers.get(runId)?.signal?.aborted);
    },
  };
}

function pruneOldRunControllers(controllers, activeRunId) {
  for (const runId of controllers.keys()) {
    if (runId < activeRunId - 3) controllers.delete(runId);
  }
}

export async function cleanupReadRun({
  runId,
  iterator,
  cleanup = null,
  isCurrentRun = () => true,
  clearCurrentRunState = null,
} = {}) {
  if (typeof cleanup === 'function') await cleanup();
  try {
    const closeResult = iterator?.return?.();
    await waitForBoundedPromise(closeResult, { timeoutMs: READ_STREAM_CLEANUP_TIMEOUT_MS });
  } catch (error) {
    suppressReadLifecycleError(error);
  }
  if (typeof clearCurrentRunState === 'function' && isCurrentRun(runId)) {
    clearCurrentRunState();
  }
}

export function runCleanupAfterSettled(task, cleanup = null) {
  return Promise.resolve(task)
    .catch(suppressReadLifecycleError)
    .then(() => (typeof cleanup === 'function' ? cleanup() : null));
}

export function createManagedAudioUrl(blob, { urlApi = globalThis.URL } = {}) {
  const url = urlApi.createObjectURL(blob);
  let revoked = false;

  return {
    url,
    revoke() {
      if (revoked) return;
      revoked = true;
      urlApi.revokeObjectURL(url);
    },
  };
}

export function cleanupAudioElement(audio) {
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  audio.pause?.();
  audio.removeAttribute?.('src');
  audio.load?.();
}

export function attachAudioEventListeners(audio, listeners = {}) {
  if (!audio || typeof audio.addEventListener !== 'function') return () => {};

  const entries = Object.entries(listeners).filter(([, handler]) => typeof handler === 'function');
  for (const [type, handler] of entries) {
    audio.addEventListener(type, handler);
  }

  let cleaned = false;
  return () => {
    if (cleaned || typeof audio.removeEventListener !== 'function') return;
    cleaned = true;
    for (const [type, handler] of entries) {
      audio.removeEventListener(type, handler);
    }
  };
}

export function createAudioHighlightResyncLoop({
  audio,
  onResync,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
} = {}) {
  if (!audio || typeof onResync !== 'function' || typeof requestFrame !== 'function') {
    return {
      start() {},
      stop() {},
    };
  }

  let frameId = null;
  let stopped = true;

  const requestNextFrame = () => {
    if (stopped || frameId !== null || audio.paused === true) return;
    frameId = requestFrame(tick);
  };

  const tick = () => {
    frameId = null;
    if (stopped || audio.paused === true) return;
    onResync();
    requestNextFrame();
  };

  return {
    start() {
      stopped = false;
      requestNextFrame();
    },
    stop() {
      stopped = true;
      if (frameId !== null && typeof cancelFrame === 'function') cancelFrame(frameId);
      frameId = null;
    },
  };
}

export function createReusableAudioElementPool({ createAudio = () => new Audio() } = {}) {
  let audio = null;

  return {
    acquire(src) {
      if (!audio) audio = createAudio();
      if (typeof src === 'string') audio.src = src;
      return audio;
    },
    release() {
      cleanupAudioElement(audio);
      audio = null;
    },
    destroy() {
      cleanupAudioElement(audio);
      audio = null;
    },
    get current() {
      return audio;
    },
  };
}

export function shouldStopReadForClosedTab({
  activeReadTabId = null,
  closedTabId = null,
  state = '',
} = {}) {
  if (!ACTIVE_READ_STATES.has(state)) return false;
  const activeId = Number(activeReadTabId);
  const closedId = Number(closedTabId);
  if (!Number.isFinite(activeId) || !Number.isFinite(closedId)) return false;
  return activeId === closedId;
}

export function shouldCleanupReadOnPanelHide({ state = '' } = {}) {
  return ACTIVE_READ_STATES.has(state);
}

export function compactPdfChunk(chunk) {
  if (chunk?.compact) return chunk;

  const speech = String(chunk?.speech || chunk?.text || chunk?.preview || '');
  return {
    type: chunk?.type || 'pdf-page',
    pageNumber: chunk?.pageNumber,
    anchorId: chunk?.anchorId,
    domWordOffset: normalizeNonNegativeInteger(chunk?.domWordOffset),
    wordCount: countWords(speech),
    preview: createChunkPreview(speech),
    compact: true,
  };
}

export function compactCompletedPdfChunks(chunks, {
  source = '',
  currentIndex = 0,
  keepFullChunkHistoryLimit = KEEP_FULL_CHUNK_HISTORY_LIMIT,
  keepFullFromIndex = null,
} = {}) {
  if (source !== 'pdf' || !Array.isArray(chunks)) return chunks;
  const limit = normalizePositiveInteger(keepFullChunkHistoryLimit) || KEEP_FULL_CHUNK_HISTORY_LIMIT;
  if (chunks.length <= limit) return chunks;

  const defaultKeepFrom = Math.max(0, normalizeNonNegativeInteger(currentIndex) - 1);
  const keepFrom = keepFullFromIndex === null
    ? defaultKeepFrom
    : normalizeNonNegativeInteger(keepFullFromIndex);

  return chunks.map((chunk, index) => (index < keepFrom ? compactPdfChunk(chunk) : chunk));
}

export function getEmptyStreamMessage(article = {}) {
  const startPage = getPdfStartPage(article);
  if (article?.source === 'pdf' && startPage > 0) {
    return t("Could not extract text from PDF page $1", [startPage]);
  }
  return EMPTY_ARTICLE_TEXT_MESSAGE;
}

export function createPdfEmptyStreamDiagnostics(article = {}, { tabId = null, hasIterator = false } = {}) {
  if (article?.source !== 'pdf') return null;

  return {
    startPage: getPdfStartPage(article),
    pageCount: normalizePositiveInteger(article.pageCount),
    tabId: tabId ?? article.tabId ?? null,
    hasIterator: Boolean(hasIterator),
  };
}

export function getSpeechPreloadWindow({
  currentIndex = 0,
  availableChunkCount = 0,
  preloadAhead = 0,
  minimumAhead = 1,
} = {}) {
  const current = Math.max(0, Math.trunc(Number(currentIndex) || 0));
  const available = Math.max(0, Math.trunc(Number(availableChunkCount) || 0));
  if (current >= available) return [];

  const requestedAhead = Math.trunc(Number(preloadAhead));
  const safeRequestedAhead = Number.isFinite(requestedAhead) && requestedAhead > 0 ? requestedAhead : 0;
  const safeMinimumAhead = Math.max(0, Math.trunc(Number(minimumAhead) || 0));
  const ahead = Math.max(safeRequestedAhead, safeMinimumAhead);
  const end = Math.min(available - 1, current + ahead);
  const indices = [];

  for (let index = current; index <= end; index += 1) {
    indices.push(index);
  }

  return indices;
}

export async function waitForSpeechPreloadReady({
  speechPreloads,
  index,
  signal = null,
  firstSegmentReadyTimeoutMs = STREAM_SYNTHESIS_TIMEOUT_MS,
} = {}) {
  const preloadIndex = normalizeNonNegativeInteger(index);
  if (!(speechPreloads instanceof Map) || !speechPreloads.has(preloadIndex)) {
    return { ok: false, reason: 'missing' };
  }
  if (signal?.aborted) return { ok: false, reason: 'aborted' };

  try {
    const preload = await waitForBoundedPromise(speechPreloads.get(preloadIndex), {
      signal,
      timeoutMs: firstSegmentReadyTimeoutMs,
    });
    if (!preload.ok) return preload;
    const entry = preload.value;
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    if (entry?.error) return { ok: false, reason: 'failed' };
    const speech = entry?.result || entry;
    if (speech?.kind === 'segments' && speech.firstSegmentReady?.then) {
      const firstSegment = await waitForBoundedPromise(speech.firstSegmentReady, {
        signal,
        timeoutMs: firstSegmentReadyTimeoutMs,
      });
      if (!firstSegment.ok) return firstSegment;
    }
    const audioPayload = getGeneratedSpeechPreloadPayload(speech);
    if (audioPayload?.audioReady && typeof audioPayload.audioReady.then === 'function') {
      const audioReady = await waitForBoundedPromise(audioPayload.audioReady, {
        signal,
        timeoutMs: firstSegmentReadyTimeoutMs,
      });
      if (!audioReady.ok) return audioReady;
    }
    const ready = { ok: true };
    if (audioPayload?.preparedAudio) ready.preparedAudio = audioPayload.preparedAudio;
    return ready;
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function waitForBoundedPromise(promise, {
  signal = null,
  timeoutMs = STREAM_SYNTHESIS_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });

  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  let timeoutId = null;
  let settled = false;
  const cleanup = (abortHandler) => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = null;
    signal?.removeEventListener?.('abort', abortHandler);
  };

  return new Promise((resolve) => {
    const finish = (result, abortHandler) => {
      if (settled) return;
      settled = true;
      cleanup(abortHandler);
      resolve(result);
    };
    const abort = () => finish({ ok: false, reason: 'aborted' }, abort);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (timeout > 0) {
      timeoutId = setTimeout(() => finish({ ok: false, reason: 'failed' }, abort), timeout);
    }
    Promise.resolve(promise).then(
      (value) => finish({ ok: true, value }, abort),
      () => finish(signal?.aborted ? { ok: false, reason: 'aborted' } : { ok: false, reason: 'failed' }, abort),
    );
  });
}

function getGeneratedSpeechPreloadPayload(speech) {
  if (speech?.kind === 'chunk') return speech.result || null;
  return speech?.blob ? speech : null;
}

export function getSpeechPreloadMaxInFlight({
  preloadAhead = 0,
  minimumAhead = 1,
  progressiveSegments = false,
} = {}) {
  const requestedAhead = Math.max(
    Number.isFinite(Number(preloadAhead)) ? Math.trunc(Number(preloadAhead)) : 0,
    Number.isFinite(Number(minimumAhead)) ? Math.trunc(Number(minimumAhead)) : 0,
  );
  return Math.max(progressiveSegments ? 1 : 0, requestedAhead) + 1;
}

export function createSectionReadyTransitionTracker({ onTransition = null } = {}) {
  const readySections = new Map();
  const emittedTransitions = new Set();

  function recordSectionReady({ sectionIndex, readyAtMs } = {}) {
    const index = normalizeSectionReadyIndex(sectionIndex);
    const readyAt = Number(readyAtMs);
    if (index === null || !Number.isFinite(readyAt)) return;

    readySections.set(index, readyAt);
    emitTransition(index - 1, index);
    emitTransition(index, index + 1);
  }

  function emitTransition(fromSectionIndex, toSectionIndex) {
    if (fromSectionIndex < 0) return;
    if (!readySections.has(fromSectionIndex) || !readySections.has(toSectionIndex)) return;

    const key = `${fromSectionIndex}->${toSectionIndex}`;
    if (emittedTransitions.has(key)) return;
    emittedTransitions.add(key);

    const transition = {
      fromSectionIndex,
      toSectionIndex,
      nextSectionReadyGapMs: Math.max(
        0,
        readySections.get(toSectionIndex) - readySections.get(fromSectionIndex),
      ),
    };
    onTransition?.(transition);
  }

  return {
    recordSectionReady,
    clear() {
      readySections.clear();
      emittedTransitions.clear();
    },
  };
}

function normalizeSectionReadyIndex(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function pruneSpeechPreloads({
  speechPreloads,
  queuedHighlightIndices,
  activeIndices = [],
  currentIndex = 0,
  targetVoiceId = null,
  targetEngine = null,
  preloadState = null,
} = {}) {
  const activeSet = new Set(activeIndices);
  const current = Math.max(0, Math.trunc(Number(currentIndex) || 0));

  if (speechPreloads instanceof Map) {
    for (const [index, preload] of Array.from(speechPreloads.entries())) {
      const isVoiceMismatch = targetVoiceId && index > current && preload?.voiceId && preload.voiceId !== targetVoiceId;
      const isEngineMismatch = targetEngine && index > current && preload?.engine && preload.engine !== targetEngine;
      if (index < current || !activeSet.has(index) || isVoiceMismatch || isEngineMismatch) {
        returnSpeechPreloadSegments(preload);
        speechPreloads.delete(index);
        if ((isVoiceMismatch || isEngineMismatch) && preloadState && preloadState.inFlightCount > 0) {
          preloadState.inFlightCount -= 1;
        }
      }
    }
  }

  if (queuedHighlightIndices instanceof Set) {
    for (const index of queuedHighlightIndices) {
      if (index <= current || !activeSet.has(index)) queuedHighlightIndices.delete(index);
    }
  }
}

export function clearSpeechPreloadState({
  speechPreloads,
  queuedHighlightIndices,
  preloadState,
  preserveVoiceId = null,
  preserveEngine = null,
} = {}) {
  if (preloadState && typeof preloadState === 'object') delete preloadState.refillSpeechPreloadWindow;
  if (speechPreloads instanceof Map) {
    for (const [index, preload] of Array.from(speechPreloads.entries())) {
      if (preserveVoiceId && preload?.voiceId === preserveVoiceId && (!preserveEngine || preload?.engine === preserveEngine)) {
        continue;
      }
      returnSpeechPreloadSegments(preload);
      speechPreloads.delete(index);
    }
  }
  if (!preserveVoiceId) {
    speechPreloads?.clear?.();
    queuedHighlightIndices?.clear?.();
    if (preloadState && typeof preloadState === 'object') {
      preloadState.inFlight = false;
      preloadState.inFlightCount = 0;
      preloadState.failedPreloadRetryUntilByIndex?.clear?.();
      delete preloadState.currentIndex;
    }
  }
}

function returnSpeechPreloadSegments(preload) {
  preload?.cancel?.();
  Promise.resolve(preload).then((entry) => {
    const speech = entry?.result || entry;
    const payload = speech?.kind === 'chunk' ? speech.result : speech;
    payload?.preparedAudio?.cleanup?.();
    if (speech?.kind === 'segments') return speech.segments?.return?.();
    if (speech?.kind === 'chunk') return speech.return?.();
    return null;
  }).catch((error) => {
    readLifecycleLogger.warn('Could not return preloaded speech resources.', error);
  });
}

export function queueNextSpeechPreload({
  indices = [],
  speechPreloads,
  preloadState,
  maxInFlight = 1,
  createPreload,
  onSettled,
  retryBackoffMs = TUNING_CONFIG.playback.speechPreloadFailureBackoffMs,
  getNowMs = () => Date.now(),
  targetVoiceId = null,
  targetEngine = null,
} = {}) {
  if (!Array.isArray(indices) || !indices.length) return null;
  if (!(speechPreloads instanceof Map) || typeof createPreload !== 'function') return null;

  const state = preloadState && typeof preloadState === 'object' ? preloadState : {};
  const safeRetryBackoffMs = normalizeRetryBackoffMs(retryBackoffMs);
  const maxInFlightCount = Math.max(1, normalizePositiveInteger(maxInFlight) || 1);
  let activeInFlightCount = Number.isFinite(state.inFlightCount)
    ? Math.max(0, Math.trunc(state.inFlightCount))
    : state.inFlight
      ? 1
      : 0;
  const currentIndex = indices[0];
  const started = [];

  for (const nextIndex of indices) {
    const existing = speechPreloads.get(nextIndex);
    if (existing) {
      const voiceMismatch = targetVoiceId && existing?.voiceId && existing.voiceId !== targetVoiceId;
      const engineMismatch = targetEngine && existing?.engine && existing.engine !== targetEngine;
      if (voiceMismatch || engineMismatch) {
        returnSpeechPreloadSegments(existing);
        speechPreloads.delete(nextIndex);
        activeInFlightCount = Math.max(0, activeInFlightCount - 1);
        if (state.inFlightCount > 0) state.inFlightCount -= 1;
      } else {
        continue;
      }
    }
    if (isSpeechPreloadRetryDelayed(state, nextIndex, { retryBackoffMs: safeRetryBackoffMs, getNowMs })) continue;
    if (nextIndex !== currentIndex && activeInFlightCount >= maxInFlightCount) break;

    const preload = createPreload(nextIndex);
    if (!preload) continue;

    activeInFlightCount += 1;
    state.inFlight = true;
    state.inFlightCount = activeInFlightCount;
    speechPreloads.set(nextIndex, preload);
    started.push({ index: nextIndex, preload });

    Promise.resolve(preload).then((entry) => {
      const failed = Boolean(entry?.error);
      if (speechPreloads.get(nextIndex) === preload) {
        recordSpeechPreloadRetryState(state, nextIndex, {
          failed,
          retryBackoffMs: safeRetryBackoffMs,
          getNowMs,
        });
        if (failed) speechPreloads.delete(nextIndex);
      }
      return entry;
    }, (error) => {
      if (speechPreloads.get(nextIndex) === preload) {
        recordSpeechPreloadRetryState(state, nextIndex, {
          failed: true,
          retryBackoffMs: safeRetryBackoffMs,
          getNowMs,
        });
        speechPreloads.delete(nextIndex);
      }
      throw error;
    }).finally(() => {
      const remaining = Math.max(0, (Number.isFinite(state.inFlightCount) ? state.inFlightCount : 1) - 1);
      state.inFlightCount = remaining;
      state.inFlight = remaining > 0;
      if (typeof onSettled === 'function') onSettled(nextIndex, preload);
    }).catch((error) => {
      readLifecycleLogger.warn('Speech preload failed.', error);
    });
  }

  return started[0] || null;
}

function isSpeechPreloadRetryDelayed(state, index, { retryBackoffMs = 0, getNowMs = () => Date.now() } = {}) {
  if (!state || retryBackoffMs <= 0) return false;
  const retryMap = state.failedPreloadRetryUntilByIndex;
  if (!(retryMap instanceof Map)) return false;

  const retryAtMs = Number(retryMap.get(index));
  if (!Number.isFinite(retryAtMs)) return false;
  if (normalizeNowMs(getNowMs) < retryAtMs) return true;

  retryMap.delete(index);
  return false;
}

function recordSpeechPreloadRetryState(state, index, {
  failed = false,
  retryBackoffMs = 0,
  getNowMs = () => Date.now(),
} = {}) {
  if (!state || typeof state !== 'object') return;
  if (!failed) {
    state.failedPreloadRetryUntilByIndex?.delete?.(index);
    return;
  }
  if (retryBackoffMs <= 0) return;
  if (!(state.failedPreloadRetryUntilByIndex instanceof Map)) {
    state.failedPreloadRetryUntilByIndex = new Map();
  }
  state.failedPreloadRetryUntilByIndex.set(index, normalizeNowMs(getNowMs) + retryBackoffMs);
}

function normalizeRetryBackoffMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
}

function normalizeNowMs(getNowMs) {
  const now = Number(typeof getNowMs === 'function' ? getNowMs() : Date.now());
  return Number.isFinite(now) ? now : Date.now();
}

function getPdfStartPage(article = {}) {
  const startPage = Number(article?.startPosition?.pageNumber);
  if (Number.isFinite(startPage) && startPage > 0) return Math.trunc(startPage);
  return 0;
}

function normalizePositiveInteger(value) {
  return normalizePositiveIntegerValue(value, 0);
}

function normalizeNonNegativeInteger(value) {
  return normalizeNonNegativeIntegerValue(value, 0);
}

function countWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function createChunkPreview(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > 220 ? `${value.slice(0, 217).trim()}...` : value;
}
