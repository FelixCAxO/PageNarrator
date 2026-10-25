import { primeSpeechSegments, synthesizeSpeechChunk, synthesizeSpeechSegments } from './speech-audio.js';
import { getChunkSpeechText } from './reader-engine-chunks.js';
import { createSpeechMediaOutput } from './speech-media-output.js';
import {
  cleanupAudioElement,
  createManagedAudioUrl,
  getSpeechPreloadMaxInFlight,
  getSpeechPreloadWindow,
  pruneSpeechPreloads,
  queueNextSpeechPreload,
  waitForBoundedPromise,
} from './reader-engine-read-lifecycle.js';
import {
  BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS,
  STREAM_SYNTHESIS_TIMEOUT_MS,
} from './timing-config.js';

/** @param {any} [deps] */
export function createReaderEngineSpeechPreloadController({
  state,
  playbackSession,
  readRunTracker,
  getNowMs = () => Date.now(),
  getActiveTtsProfileConfig,
  resolveSelectedVoice,
  trackActiveVoiceSynthesisPromise,
  trackActiveVoiceSynthesisSegments,
  highlightQueuedChunk,
  suppressError,
  renderGovernorDecision,
  recordFirstSynthesis,
  recordSectionSynthesis,
  prepareGeneratedAudioForPlayback = defaultPrepareGeneratedAudioForPlayback,
  recordAudioDecodeLatency = () => {},
  recordPipeline = () => {},
} = {}) {
  const mediaOutput = createSpeechMediaOutput({ onError: suppressError });
  /**
   * @param {any} chunk
   * @param {any} [options]
   */
  function preloadSpeech(chunk, { selectedVoice = null, signal = null, sectionIndex = null, tts = state.tts, forceComplete = false } = {}) {
    const profile = getActiveTtsProfileConfig();
    const text = getChunkSpeechText(chunk);
    const startedAtMs = getNowMs();
    const voice = selectedVoice || resolveSelectedVoice();
    recordPipeline({ kind: 'synthesis_requested', chunkIndex: sectionIndex, engine: voice?.engine });
    if (state.testForceKokoroFailureEnabled) {
      return Promise.resolve({ error: new Error('Forced Kokoro failure for low-spec fallback probe.') });
    }
    // ponytail: each bounded preload owns cancellation; changing voices keeps the read alive.
    const preloadController = new AbortController();
    const cancelPreload = () => {
      signal?.removeEventListener?.('abort', cancelPreload);
      preloadController.abort();
      recordPipeline({ kind: 'speech_preload_released', chunkIndex: sectionIndex, engine: voice?.engine });
    };
    if (signal?.aborted) cancelPreload();
    else signal?.addEventListener?.('abort', cancelPreload, { once: true });
    const speechTimeoutMs = getSpeechPreloadReadyTimeoutMs(profile);
    const speechOptions = {
      voice: voice?.engine === 'omnivoice' ? voice : voice?.id || state.getSelectedVoiceId(),
      languageCode: voice?.detectCode || voice?.lang || state.selectedLanguageCode,
      streamTimeoutMs: profile.progressiveSegments ? speechTimeoutMs : STREAM_SYNTHESIS_TIMEOUT_MS,
      generatedSpeechTimeoutMs: speechTimeoutMs,
      signal: preloadController.signal,
      testSilentTts: state.testSilentTtsEnabled,
      useStream: false,
    };
    const synthesis = profile.progressiveSegments && !forceComplete
      ? Promise.resolve(createProgressiveSpeechPreload({
        text,
        speechOptions,
        startedAtMs,
        sectionIndex,
        signal: preloadController.signal,
        tts,
      }))
      : trackActiveVoiceSynthesisPromise(synthesizeSpeechChunk(tts, text, speechOptions)).then((result) => {
        recordPipeline({ kind: 'synthesis_completed', chunkIndex: sectionIndex, engine: voice?.engine });
        const firstSynthesis = {
          synthesisMs: getNowMs() - startedAtMs,
          audioDurationSeconds: getSpeechDurationSeconds(result),
        };
        attachSynthesisMetrics(result, firstSynthesis);
        // A warmup cache hit is not a fresh hardware throughput measurement.
        if (!result.fromWarmup) renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordFirstSynthesis(firstSynthesis));
        recordFirstSynthesis?.(firstSynthesis);
        recordSectionSynthesis?.({ sectionIndex, ...firstSynthesis });
        return {
          kind: 'chunk',
          result,
          startedAtMs,
          sectionIndex,
          voiceId: voice?.id || state.getSelectedVoiceId(),
          engine: voice?.engine || 'kokoro',
        };
      });

    const voiceId = voice?.id || state.getSelectedVoiceId();
    const engine = voice?.engine || 'kokoro';
    const preloadPromise = synthesis.then(
      (result) => attachAudioReady({ result }, { sectionIndex, signal: preloadController.signal }),
      (error) => ({ error }),
    ).then((entry) => {
      if (entry?.error) cancelPreload();
      if (entry) {
        entry.voiceId = voiceId;
        entry.engine = engine;
      }
      return entry;
    });
    preloadPromise.voiceId = voiceId;
    preloadPromise.engine = engine;
    preloadPromise.cancel = cancelPreload;
    return preloadPromise;
  }

  /** @param {any} [options] */
  function createProgressiveSpeechPreload({
    text,
    speechOptions,
    startedAtMs,
    sectionIndex = null,
    signal = null,
    tts = state.tts,
  } = {}) {
    let firstSegmentRecorded = false;
    let firstSegmentSettled = false;
    /** @type {(value?: any) => void} */
    let resolveFirstSegmentReady = () => {};
    /** @type {(reason?: any) => void} */
    let rejectFirstSegmentReady = () => {};
    const firstSegmentReady = new Promise((resolve, reject) => {
      resolveFirstSegmentReady = resolve;
      rejectFirstSegmentReady = reject;
    });
    void firstSegmentReady.catch(suppressError);
    const speechPreload = {
      kind: 'segments',
      segments: null,
      firstSegmentReady,
      startedAtMs,
      sectionIndex,
    };
    /** @param {any} [error] */
    const settleFirstSegmentReady = (error = null) => {
      if (firstSegmentSettled) return;
      firstSegmentSettled = true;
      signal?.removeEventListener?.('abort', abortFirstSegmentReady);
      if (error) {
        rejectFirstSegmentReady(error);
      } else {
        resolveFirstSegmentReady();
      }
    };
    const abortFirstSegmentReady = () => {
      settleFirstSegmentReady(createAbortError());
    };
    if (signal?.aborted) {
      abortFirstSegmentReady();
    } else {
      signal?.addEventListener?.('abort', abortFirstSegmentReady, { once: true });
    }
    /** @param {any} [event] */
    const recordFirstSegmentReady = (event = {}) => {
      const { result, error } = event;
      if (firstSegmentRecorded || firstSegmentSettled) return;
      if (signal?.aborted) {
        abortFirstSegmentReady();
        return;
      }
      if (error) {
        settleFirstSegmentReady(error);
        return;
      }
      if (result?.done) {
        settleFirstSegmentReady(new Error('Progressive speech stream ended before the first segment was ready.'));
        return;
      }
      const segment = result?.value;
      if (!segment) {
        settleFirstSegmentReady(new Error('Progressive speech stream did not yield a first segment.'));
        return;
      }
      firstSegmentRecorded = true;
      const readyAtMs = getNowMs();
      const firstSynthesis = {
        synthesisMs: readyAtMs - startedAtMs,
        audioDurationSeconds: getSpeechDurationSeconds(segment),
      };
      attachSynthesisMetrics(speechPreload, firstSynthesis);
      renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordFirstSynthesis(firstSynthesis));
      recordFirstSynthesis?.(firstSynthesis);
      recordSectionSynthesis?.({
        sectionIndex,
        ...firstSynthesis,
        readyAtMs,
      });
      settleFirstSegmentReady();
    };

    speechPreload.segments = primeSpeechSegments(
      trackActiveVoiceSynthesisSegments(synthesizeSpeechSegments(tts, text, speechOptions)),
      { onSegmentReady: recordFirstSegmentReady },
    );
    return speechPreload;
  }

  /**
   * @param {any} preload
   * @param {any} [options]
   */
  async function readPreloadedSpeech(preload, {
    signal = null,
    readyTimeoutMs = getSpeechPreloadReadyTimeoutMs(getActiveTtsProfileConfig?.()),
  } = {}) {
    if (!preload) throw new Error('Speech preload did not start.');
    const res = await waitForPreloadResult(preload, { signal, timeoutMs: readyTimeoutMs });
    if (res?.error) throw res.error;
    const speech = getGeneratedSpeechPayload(res);
    const preloadResult = res?.result || res;
    if (preloadResult?.firstSegmentReady && typeof preloadResult.firstSegmentReady.then === 'function') {
      const firstSegmentReady = await waitForBoundedPromise(preloadResult.firstSegmentReady, {
        signal,
        timeoutMs: readyTimeoutMs,
      });
      if (!firstSegmentReady.ok) {
        if (firstSegmentReady.reason === 'aborted') throw createAbortError();
        throw createSpeechPreloadTimeoutError(readyTimeoutMs);
      }
    }
    if (speech?.audioReady && typeof speech.audioReady.then === 'function') {
      const audioReady = await waitForBoundedPromise(speech.audioReady, {
        signal,
        timeoutMs: readyTimeoutMs,
      });
      if (!audioReady.ok) {
        if (audioReady.reason === 'aborted') throw createAbortError();
        throw createSpeechPreloadTimeoutError(readyTimeoutMs);
      }
    }
    return res.result;
  }

  /**
   * @param {any} selectedVoice
   * @param {any} chunk
   * @param {any} [options]
   */
  function createSpeechPreloadForVoice(selectedVoice, chunk, options = {}) {
    if (['kokoro', 'omnivoice'].includes(selectedVoice?.engine)) return preloadSpeech(chunk, { ...options, selectedVoice });
    return null;
  }

  function clearActiveSpeechPreloads() {
    playbackSession.setActiveSpeechPreloadCleanup(state.activeSpeechPreloadCleanup);
    playbackSession.clearActiveSpeechPreloads();
    state.activeSpeechPreloadCleanup = () => {};
    mediaOutput.release();
  }

  /** @param {any} [options] */
  function ensureSpeechPreloadWindow({
    speechPreloads,
    queuedHighlightIndices,
    currentIndex,
    selectedVoice,
    syncPageHighlights,
    tabId,
    minimumAhead = 1,
    preloadState,
    signal = null,
    runId = null,
  } = {}) {
    if (!['kokoro', 'omnivoice'].includes(selectedVoice?.engine)) return null;

    const managedPreloadState = preloadState && typeof preloadState === 'object' ? preloadState : {};
    const profile = getActiveTtsProfileConfig();
    const maxInFlight = getSpeechPreloadMaxInFlight({
      preloadAhead: profile.preloadAhead,
      minimumAhead,
      progressiveSegments: profile.progressiveSegments,
    });
    const indices = getSpeechPreloadWindow({
      currentIndex,
      availableChunkCount: state.activeChunks.length,
      preloadAhead: profile.preloadAhead,
      minimumAhead,
    });
    const activeIndices = new Set(indices);

    pruneSpeechPreloads({
      speechPreloads,
      queuedHighlightIndices,
      activeIndices,
      currentIndex,
      targetVoiceId: selectedVoice?.id,
      targetEngine: selectedVoice?.engine,
      preloadState: managedPreloadState,
    });
    managedPreloadState.currentIndex = currentIndex;
    managedPreloadState.currentVoiceId = selectedVoice?.id;
    managedPreloadState.refillSpeechPreloadWindow = () => ensureSpeechPreloadWindow({
      speechPreloads,
      queuedHighlightIndices,
      currentIndex,
      selectedVoice,
      syncPageHighlights,
      tabId,
      minimumAhead,
      preloadState: managedPreloadState,
      signal,
      runId,
    });

    for (const index of indices) {
      if (syncPageHighlights && index === currentIndex + 1 && !queuedHighlightIndices.has(index)) {
        queuedHighlightIndices.add(index);
        highlightQueuedChunk(tabId, state.activeChunks[index]).catch(suppressError);
      }
    }

    queueNextSpeechPreload({
      indices,
      speechPreloads,
      preloadState: managedPreloadState,
      maxInFlight,
      targetVoiceId: selectedVoice?.id,
      targetEngine: selectedVoice?.engine,
      createPreload(index) {
        return createSpeechPreloadForVoice(selectedVoice, state.activeChunks[index], { signal, sectionIndex: index });
      },
      onSettled(settledIndex, settledPreload) {
        if (signal?.aborted || (runId !== null && !readRunTracker.isCurrentRun(runId))) return;
        if (managedPreloadState.currentIndex !== currentIndex || speechPreloads.get(settledIndex) !== settledPreload) {
          managedPreloadState.refillSpeechPreloadWindow?.();
          return;
        }
        ensureSpeechPreloadWindow({
          speechPreloads,
          queuedHighlightIndices,
          currentIndex,
          selectedVoice,
          syncPageHighlights,
          tabId,
          minimumAhead,
          preloadState: managedPreloadState,
          signal,
          runId,
        });
      },
    });

    return speechPreloads.get(currentIndex) || null;
  }

  function getProfileMinimumAhead(profile) {
    return profile.progressiveSegments || profile.preloadAhead <= 0 ? 0 : 2;
  }

  return {
    clearActiveSpeechPreloads,
    ensureSpeechPreloadWindow,
    getProfileMinimumAhead,
    createSpeechPreloadForVoice,
    readPreloadedSpeech,
  };

  /**
   * @param {any} entry
   * @param {any} [options]
   */
  function attachAudioReady(entry, { sectionIndex = null, signal = null } = {}) {
    const speech = getGeneratedSpeechPayload(entry);
    if (!speech?.blob) return entry;

    speech.audioReady = Promise.resolve()
      .then(() => prepareGeneratedAudioForPlayback(speech, { sectionIndex, signal, connectAudio: audio => mediaOutput.connect(audio) }))
      .then((decode) => {
        const decodeLatencyMs = Number(decode?.decodeLatencyMs);
        if (Number.isFinite(decodeLatencyMs)) speech.decodeLatencyMs = decodeLatencyMs;
        if (Number.isFinite(Number(decode?.readyState))) speech.decodeReadyState = Number(decode.readyState);
        recordAudioDecodeLatency({
          sectionIndex,
          decodeLatencyMs: Number.isFinite(decodeLatencyMs) ? decodeLatencyMs : 0,
          readyState: Number.isFinite(Number(decode?.readyState)) ? Number(decode.readyState) : null,
        });
        return decode;
      });
    void speech.audioReady.catch(suppressError);
    return entry;
  }
}

/** @param {any} [profile] */
function getSpeechPreloadReadyTimeoutMs(profile = {}) {
  if (Number.isFinite(Number(profile?.speechPreloadTimeoutMs)) && Number(profile.speechPreloadTimeoutMs) > 0) {
    return Math.trunc(Number(profile.speechPreloadTimeoutMs));
  }
  return STREAM_SYNTHESIS_TIMEOUT_MS;
}

/**
 * @param {any} preload
 * @param {any} [options]
 */
function waitForPreloadResult(preload, {
  signal = null,
  timeoutMs = STREAM_SYNTHESIS_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError());

  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  let timeoutHandle = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      signal?.removeEventListener?.('abort', abort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => finish(reject, createAbortError());

    signal?.addEventListener?.('abort', abort, { once: true });
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        finish(reject, createSpeechPreloadTimeoutError(timeout));
      }, timeout);
    }
    Promise.resolve(preload).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

/** @param {any} speech */
function getSpeechDurationSeconds(speech) {
  const duration = Number(speech?.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const lastTiming = Number(speech?.wordTimings?.at?.(-1)?.end);
  return Number.isFinite(lastTiming) && lastTiming > 0 ? lastTiming : null;
}

/** @param {any} entry */
function getGeneratedSpeechPayload(entry) {
  const result = entry?.result || entry;
  if (result?.kind === 'chunk') return result.result;
  return result?.blob ? result : null;
}

/**
 * @param {any} result
 * @param {any} metrics
 */
function attachSynthesisMetrics(result, metrics) {
  if (!result || typeof result !== 'object') return;
  const synthesisMs = Number(metrics?.synthesisMs);
  const audioDurationSeconds = Number(metrics?.audioDurationSeconds);
  result.synthesisMetrics = {
    synthesisMs: Number.isFinite(synthesisMs) ? synthesisMs : null,
    audioDurationSeconds: Number.isFinite(audioDurationSeconds) ? audioDurationSeconds : null,
    realTimeFactor: getSpeechRealTimeFactor({ synthesisMs, audioDurationSeconds }),
  };
}

/** @param {any} [metrics] */
function getSpeechRealTimeFactor({ synthesisMs, audioDurationSeconds } = {}) {
  if (!Number.isFinite(synthesisMs) || synthesisMs < 0 || !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) {
    return null;
  }
  return synthesisMs / (audioDurationSeconds * 1000);
}

function createAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Speech synthesis was aborted.', 'AbortError');
  const error = new Error('Speech synthesis was aborted.');
  error.name = 'AbortError';
  return error;
}

function createSpeechPreloadTimeoutError(timeoutMs) {
  const error = new Error(`Speech preload did not become ready within ${timeoutMs} ms.`);
  error.code = 'speech_preload_timeout';
  return error;
}

/**
 * @param {any} speech
 * @param {any} [options]
 */
function defaultPrepareGeneratedAudioForPlayback(speech, {
  sectionIndex = null,
  signal = null,
  createAudio = typeof globalThis.Audio === 'function' ? (url) => new globalThis.Audio(url) : null,
  urlApi = globalThis.URL,
  getNowMs = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()),
  decodeReadyTimeoutMs = BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  connectAudio = () => () => {},
} = {}) {
  if (signal?.aborted || !speech?.blob || typeof createAudio !== 'function' || !urlApi?.createObjectURL) {
    return Promise.resolve({ sectionIndex, decodeLatencyMs: 0, readyState: null });
  }

  const startedAtMs = getNowMs();
  const managedUrl = createManagedAudioUrl(speech.blob, { urlApi });
  let audio;
  try {
    audio = createAudio(managedUrl.url);
  } catch (error) {
    managedUrl.revoke();
    throw error;
  }
  audio.preload = 'auto';
  const disconnectAudio = connectAudio(audio);
  const HAVE_FUTURE_DATA = 3;

  return new Promise((resolve) => {
    let settled = false;
    let cleaned = false;
    let timeoutHandle = null;
    const cleanupPreparedAudio = () => {
      if (cleaned) return;
      cleaned = true;
      disconnectAudio();
      cleanupAudioElement(audio);
      managedUrl.revoke();
      if (speech.preparedAudio?.audio === audio) delete speech.preparedAudio;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        sectionIndex,
        decodeLatencyMs: Math.max(0, getNowMs() - startedAtMs),
        readyState: Number.isFinite(Number(audio?.readyState)) ? Number(audio.readyState) : null,
      });
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      cleanupPreparedAudio();
      resolve({
        sectionIndex,
        decodeLatencyMs: Math.max(0, getNowMs() - startedAtMs),
        readyState: Number.isFinite(Number(audio?.readyState)) ? Number(audio.readyState) : null,
      });
    };
    const cleanupListeners = () => {
      signal?.removeEventListener?.('abort', fail);
      audio?.removeEventListener?.('canplay', finish);
      audio?.removeEventListener?.('loadeddata', finish);
      audio?.removeEventListener?.('error', fail);
      if (timeoutHandle !== null && typeof clearTimer === 'function') {
        clearTimer(timeoutHandle);
        timeoutHandle = null;
      }
    };

    // ponytail: publish ownership before decode, so discard can release it immediately.
    speech.preparedAudio = {
      audio,
      managedUrl,
      cleanup() { fail(); cleanupPreparedAudio(); },
    };
    signal?.addEventListener?.('abort', fail, { once: true });
    if (signal?.aborted) {
      fail();
      return;
    }
    if (Number(audio?.readyState) >= HAVE_FUTURE_DATA) {
      finish();
      return;
    }
    audio?.addEventListener?.('canplay', finish, { once: true });
    audio?.addEventListener?.('loadeddata', finish, { once: true });
    audio?.addEventListener?.('error', fail, { once: true });
    const timeoutMs = Math.max(0, Math.trunc(Number(decodeReadyTimeoutMs) || 0));
    if (timeoutMs > 0 && typeof setTimer === 'function') timeoutHandle = setTimer(fail, timeoutMs);
    audio?.load?.();
  });
}
