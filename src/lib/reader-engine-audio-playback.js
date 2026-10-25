import {
  createHighlightPlanResyncTracker,
  AUDIO_ENDED_GAP_MAX_DELAY_MS,
  AUDIO_ENDED_GAP_THRESHOLD_SECONDS,
  getAudioEndedGapDelayMs,
  getAudioWatchdogDelayMs,
  getSectionEarlyAdvanceDelayMs,
  createAudioStallWatchdog,
  createWordHighlightPlan,
  getOutputLatencyAdjustedLeadSeconds,
} from './speech-playback.js';
import { getDomWordIndexForSpeechWord } from './reading-model.js';
import { getChunkSpeechText } from './reader-engine-chunks.js';
import { MESSAGE_TYPES } from './message-types.js';
import {
  attachAudioEventListeners,
  cleanupAudioElement,
  createAudioHighlightResyncLoop,
  createManagedAudioUrl,
  createReusableAudioElementPool,
  waitForBoundedPromise,
} from './reader-engine-read-lifecycle.js';
import { createAudioProgressProbeObserver } from './tts-hardware-probe.js';
import { BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS } from './timing-config.js';

/** @param {any} [deps] */
export function createAudioPlaybackManager({
  audioPool = createReusableAudioElementPool(),
  readRunTracker = { isCurrentRun: () => true },
  getPlaybackSpeed = () => 1,
  getSectionEarlyAdvanceSeconds = () => 0,
  readAudioOutputLatencySeconds = () => 0,
  getActiveReadTabId = () => null,
  sendPageMessage = async () => {},
  flowRecorder = { record() {} },
  urlApi = globalThis.URL,
  isTtsHardwareProbeRecordingEnabled = () => false,
  recordTtsProbeTimingSources = () => {},
  recordTtsProbeSectionPlaybackStart = () => {},
  recordTtsProbeSectionPlaybackEnd = () => {},
  getNowMs = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()),
  suppressError = () => {},
  onAudioStateChange = () => {},
  setRescheduleCurrentSectionTiming = () => {},
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
} = {}) {
  let currentAudio = null;
  let currentAudioWatchdog = null;
  let clearCurrentAudioEventListeners = () => {};
  let rescheduleCurrentSectionTiming = () => {};

  function publishAudioState() {
    onAudioStateChange({
      currentAudio,
      currentAudioWatchdog,
      clearCurrentAudioEventListeners,
      rescheduleCurrentSectionTiming,
    });
  }

  function setCurrentAudio(value) {
    currentAudio = value;
    publishAudioState();
  }

  function setCurrentAudioWatchdog(value) {
    currentAudioWatchdog = value;
    publishAudioState();
  }

  function setClearCurrentAudioEventListeners(cleanup) {
    clearCurrentAudioEventListeners = typeof cleanup === 'function' ? cleanup : () => {};
    publishAudioState();
  }

  function setCurrentSectionRescheduler(rescheduler) {
    rescheduleCurrentSectionTiming = typeof rescheduler === 'function' ? rescheduler : () => {};
    setRescheduleCurrentSectionTiming(rescheduleCurrentSectionTiming);
    publishAudioState();
  }

  /** @param {any} [options] */
  function isStopped({ signal = null, runId = null } = {}) {
    return signal?.aborted || (runId != null && !readRunTracker.isCurrentRun(runId));
  }

  function clearAudioListenerState() {
    clearCurrentAudioEventListeners();
    setClearCurrentAudioEventListeners(() => {});
  }

  /**
   * @param {any} blob
   * @param {any} wordTimings
   * @param {any} chunk
   * @param {any} [options]
   */
  function playAudio(blob, wordTimings, chunk, {
    canAdvanceEarly = false,
    syncWordHighlights = true,
    signal = null,
    runId = null,
    sectionIndex = null,
    onAudioStart = null,
    onBeforeNormalEnd = null,
    preparedAudio = null,
  } = {}) {
    if (isStopped({ signal, runId })) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const prepared = preparedAudio?.audio && preparedAudio?.managedUrl ? preparedAudio : null;
      const managedUrl = prepared?.managedUrl || createManagedAudioUrl(blob, { urlApi });
      clearAudioListenerState();
      let audio;
      try {
        audio = prepared?.audio || audioPool.acquire(managedUrl.url);
      } catch (error) {
        managedUrl.revoke();
        throw error;
      }
      if (!audio.src && typeof managedUrl.url === 'string') audio.src = managedUrl.url;
      let settled = false;
      let earlyAdvanceTimer = null;
      let preEndHandoffTimer = null;
      let preEndHandoffPromise = null;
      let stalledEndFenceTimer = null;
      let playStartFenceTimer = null;
      let playGateOpen = false;
      let startWordHighlighting = () => {};
      let highlightPlanSuspended = false;
      let recordedAudioStart = false;
      let recordedAudioEnd = false;
      let playRequestedAtMs = null;
      const highlightPlanResyncTracker = createHighlightPlanResyncTracker();
      setCurrentAudio(audio);
      audio.playbackRate = getPlaybackSpeed();
      const audioOutputLatencySeconds = readAudioOutputLatencySeconds();
      recordTtsProbeTimingSources(wordTimings);
      const abortPlayback = () => finish();

      const clearEarlyAdvanceTimer = () => {
        if (earlyAdvanceTimer !== null) {
          clearTimeout(earlyAdvanceTimer);
          earlyAdvanceTimer = null;
        }
      };
      const clearPreEndHandoffTimer = () => {
        if (preEndHandoffTimer !== null) {
          clearTimeout(preEndHandoffTimer);
          preEndHandoffTimer = null;
        }
      };
      const clearStalledEndFenceTimer = () => {
        if (stalledEndFenceTimer !== null) {
          clearTimeout(stalledEndFenceTimer);
          stalledEndFenceTimer = null;
        }
      };
      const clearPlayStartFenceTimer = () => {
        if (playStartFenceTimer !== null) {
          clearTimeout(playStartFenceTimer);
          playStartFenceTimer = null;
        }
      };

      const cleanupAudioPlayback = () => {
        clearAudioListenerState();
        if (prepared?.cleanup) {
          prepared.cleanup();
        } else {
          cleanupAudioElement(audio);
          managedUrl.revoke();
        }
      };

      const recordAudioStart = () => {
        if (recordedAudioStart) return;
        recordedAudioStart = true;
        recordTtsProbeSectionPlaybackStart({ sectionIndex });
        flowRecorder.record({
          kind: 'chunk_play',
          chunkIndex: sectionIndex,
          mediaTime: audio.currentTime,
          speechText: getChunkSpeechText(chunk),
        });
        onAudioStart?.({ sectionIndex });
      };

      const recordAudioEnd = () => {
        if (!recordedAudioStart || recordedAudioEnd) return;
        recordedAudioEnd = true;
        recordTtsProbeSectionPlaybackEnd({ sectionIndex });
        flowRecorder.record({
          kind: 'chunk_end',
          chunkIndex: sectionIndex,
          mediaTime: audio.currentTime,
          speechText: getChunkSpeechText(chunk),
        });
      };

      const getNominalDurationSeconds = () => {
        const mediaDuration = Number(audio.duration);
        if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
        const speechDuration = Number(wordTimings?.at?.(-1)?.end);
        return Number.isFinite(speechDuration) && speechDuration > 0 ? speechDuration : Number.NaN;
      };

      const getStalledEndFenceDelayMs = () => {
        const duration = getNominalDurationSeconds();
        const currentTime = Number(audio.currentTime);
        const remainingSeconds = duration - currentTime;
        if (!Number.isFinite(remainingSeconds) || remainingSeconds > AUDIO_ENDED_GAP_THRESHOLD_SECONDS) return null;

        const rate = Number.isFinite(Number(audio.playbackRate)) && Number(audio.playbackRate) > 0
          ? Number(audio.playbackRate)
          : 1;
        const remainingMs = Math.round((Math.max(0, remainingSeconds) / rate) * 1000);
        return Math.max(0, Math.min(remainingMs, AUDIO_ENDED_GAP_MAX_DELAY_MS));
      };

      const syncPreparedHandoffAudio = (handoff) => {
        const nextAudio = handoff?.preparedAudio?.audio;
        if (!nextAudio || nextAudio === audio || typeof nextAudio.play !== 'function' || isStopped({ signal, runId })) return;

        // The next section may already be decoded, but it must not become audible
        // until the read loop advances that section into active playback.
        nextAudio.playbackRate = audio.playbackRate;
      };

      const startPreEndHandoff = () => {
        if (preEndHandoffPromise || typeof onBeforeNormalEnd !== 'function') return preEndHandoffPromise;
        let handoff;
        try {
          handoff = onBeforeNormalEnd({ sectionIndex, audio, phase: 'pre-end' });
        } catch (error) {
          suppressError(error);
          preEndHandoffPromise = Promise.resolve(null);
          return preEndHandoffPromise;
        }
        preEndHandoffPromise = Promise.resolve(handoff)
          .then((result) => {
            syncPreparedHandoffAudio(result);
            return result;
          })
          .catch((error) => {
            suppressError(error);
            return null;
          });
        return preEndHandoffPromise;
      };

      const waitForNormalHandoff = () => {
        if (typeof onBeforeNormalEnd !== 'function') return Promise.resolve();
        return preEndHandoffPromise || Promise.resolve().then(() => onBeforeNormalEnd({ sectionIndex, audio }));
      };

      /** @param {any} [options] */
      const finish = ({ waitForHandoff = false } = {}) => {
        if (settled) return;
        settled = true;
        recordAudioEnd();
        stopAudioProgressProbe();
        clearEarlyAdvanceTimer();
        clearPreEndHandoffTimer();
        clearStalledEndFenceTimer();
        clearPlayStartFenceTimer();
        if (rescheduleCurrentSectionTiming === schedulePlaybackTimers) setCurrentSectionRescheduler(() => {});
        highlightPlanResyncLoop.stop();
        if (!waitForHandoff) {
          currentAudioWatchdog?.dispose();
          setCurrentAudioWatchdog(null);
        }
        const handoff = waitForHandoff
          ? waitForBoundedPromise(waitForNormalHandoff(), { signal })
          : Promise.resolve({ ok: true });
        void handoff.finally(() => {
          if (waitForHandoff) {
            currentAudioWatchdog?.dispose();
            setCurrentAudioWatchdog(null);
          }
          cleanupAudioPlayback();
          if (currentAudio === audio) setCurrentAudio(null);
          signal?.removeEventListener?.('abort', abortPlayback);
          resolve(undefined);
        });
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        stopAudioProgressProbe();
        clearEarlyAdvanceTimer();
        clearPreEndHandoffTimer();
        clearStalledEndFenceTimer();
        clearPlayStartFenceTimer();
        if (rescheduleCurrentSectionTiming === schedulePlaybackTimers) setCurrentSectionRescheduler(() => {});
        currentAudioWatchdog?.dispose();
        setCurrentAudioWatchdog(null);
        highlightPlanResyncLoop.stop();
        cleanupAudioPlayback();
        if (currentAudio === audio) setCurrentAudio(null);
        signal?.removeEventListener?.('abort', abortPlayback);
        reject(error);
      };

      let stopAudioProgressProbe = () => {};
      if (isTtsHardwareProbeRecordingEnabled()) {
        const audioProgressProbe = createAudioProgressProbeObserver({
          audio,
          sectionIndex,
          now: getNowMs,
          onStart: recordAudioStart,
          onEnd() {
            // Progress telemetry may observe the final 50 ms; it must never truncate playback.
            if (audio.ended === true) recordAudioEnd();
          },
        });
        stopAudioProgressProbe = audioProgressProbe.stop;
      }

      const finishEarly = () => {
        if (settled || isStopped({ signal, runId })) return;
        finish();
      };

      const scheduleEarlyAdvance = () => {
        clearEarlyAdvanceTimer();
        if (!playGateOpen || !canAdvanceEarly || settled || audio.paused || isStopped({ signal, runId })) return;

        const delayMs = getSectionEarlyAdvanceDelayMs({
          currentTime: audio.currentTime,
          durationSeconds: audio.duration,
          playbackRate: audio.playbackRate,
          wordTimings,
          advanceSeconds: getSectionEarlyAdvanceSeconds(),
        });
        if (delayMs === null) return;
        earlyAdvanceTimer = setTimeout(finishEarly, delayMs);
      };

      const schedulePreEndHandoff = () => {
        clearPreEndHandoffTimer();
        if (preEndHandoffPromise || settled || audio.paused || isStopped({ signal, runId })) return;
        if (typeof onBeforeNormalEnd !== 'function') return;
        const delayMs = getAudioEndedGapDelayMs({
          currentTimeSeconds: audio.currentTime,
          durationSeconds: getNominalDurationSeconds(),
          playbackRate: audio.playbackRate,
        });
        if (delayMs === 0 || canAdvanceEarly) {
          startPreEndHandoff();
          return;
        }
        preEndHandoffTimer = setTimeout(() => {
          preEndHandoffTimer = null;
          if (settled || audio.paused || isStopped({ signal, runId })) return;
          startPreEndHandoff();
        }, delayMs);
      };

      const scheduleStalledEndFence = () => {
        clearStalledEndFenceTimer();
        if (settled || audio.paused || isStopped({ signal, runId })) return;

        const delayMs = getStalledEndFenceDelayMs();
        if (delayMs === null) return;
        stalledEndFenceTimer = setTimeout(() => {
          stalledEndFenceTimer = null;
          if (!settled && !isStopped({ signal, runId })) finish({ waitForHandoff: true });
        }, delayMs);
      };

      const schedulePlaybackTimers = () => {
        scheduleEarlyAdvance();
        schedulePreEndHandoff();
      };
      setCurrentSectionRescheduler(schedulePlaybackTimers);

      /** @param {any} [options] */
      const sendHighlightPlanResync = ({ paused = audio.paused, force = false } = {}) => {
        if (settled || !syncWordHighlights || !wordTimings?.length) return;
        const state = {
          currentTime: audio.currentTime,
          playbackRate: audio.playbackRate,
          paused: Boolean(paused),
        };
        if (!force && !highlightPlanResyncTracker.shouldResync(state)) return;
        highlightPlanResyncTracker.markSync(state);
        sendPageMessage(getActiveReadTabId(), {
          type: MESSAGE_TYPES.HIGHLIGHT_PLAN_RESYNC,
          ...state,
          sentAtEpochMs: Date.now(),
        }).catch(suppressError);
      };

      const highlightPlanResyncLoop = createAudioHighlightResyncLoop({
        audio,
        onResync: syncWordHighlights && wordTimings?.length
          ? () => sendHighlightPlanResync({ paused: audio.paused || highlightPlanSuspended })
          : null,
        requestFrame,
        cancelFrame,
      });

      if (syncWordHighlights && wordTimings?.length) {
        startWordHighlighting = () => {
          const planLeadSeconds = getOutputLatencyAdjustedLeadSeconds({
            playbackRate: audio.playbackRate,
            outputLatencySeconds: audioOutputLatencySeconds,
          });
          const plan = createWordHighlightPlan(wordTimings, {
            leadSeconds: planLeadSeconds,
            mapWordIndex(index) {
              return getDomWordIndexForSpeechWord(chunk, index);
            },
          }).map((entry) => ({ ...entry, chunkIndex: sectionIndex }));
          if (!plan.length) return;

          const state = {
            currentTime: audio.currentTime,
            playbackRate: audio.playbackRate,
            paused: audio.paused || highlightPlanSuspended,
          };
          highlightPlanResyncTracker.markSync(state);
          sendPageMessage(getActiveReadTabId(), {
            type: MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN,
            plan,
            currentTime: state.currentTime,
            playbackRate: state.playbackRate,
            paused: state.paused,
            sentAtEpochMs: Date.now(),
            leadSeconds: planLeadSeconds,
            fadeMs: 180,
          }).catch(suppressError);
        };
      }

      audio.onended = () => {
        finish({ waitForHandoff: true });
      };

      audio.onerror = () => fail(new Error('Audio playback failed.'));
      signal?.addEventListener?.('abort', abortPlayback, { once: true });
      const handleAudioPlay = () => {
        if (!playGateOpen) return;
        schedulePlaybackTimers();
        startWordHighlighting();
        highlightPlanResyncLoop.start();
      };
      const handleAudioPause = () => {
        highlightPlanSuspended = true;
        highlightPlanResyncLoop.stop();
        clearEarlyAdvanceTimer();
        clearPreEndHandoffTimer();
        clearStalledEndFenceTimer();
        currentAudioWatchdog?.pause();
        sendHighlightPlanResync({ paused: true, force: true });
      };
      const handleAudioWaiting = () => {
        highlightPlanSuspended = true;
        highlightPlanResyncLoop.stop();
        clearPreEndHandoffTimer();
        currentAudioWatchdog?.pause();
        sendHighlightPlanResync({ paused: true, force: true });
        scheduleStalledEndFence();
      };
      const handleAudioPlaying = () => {
        // "playing" can precede resolution of play(); the initial plan must run.
        highlightPlanSuspended = false;
        if (!playGateOpen) return;
        clearStalledEndFenceTimer();
        recordAudioStart();
        currentAudioWatchdog?.resume();
        schedulePlaybackTimers();
        sendHighlightPlanResync({ paused: false, force: true });
        highlightPlanResyncLoop.start();
      };
      const handleAudioSeeked = () => {
        clearStalledEndFenceTimer();
        sendHighlightPlanResync({ paused: audio.paused || highlightPlanSuspended, force: true });
      };
      const handleAudioRateChange = () => {
        clearStalledEndFenceTimer();
        schedulePlaybackTimers();
        startWordHighlighting();
        sendHighlightPlanResync({ paused: audio.paused || highlightPlanSuspended, force: true });
      };
      setClearCurrentAudioEventListeners(attachAudioEventListeners(audio, {
        loadedmetadata: schedulePlaybackTimers,
        play: handleAudioPlay,
        pause: handleAudioPause,
        waiting: handleAudioWaiting,
        stalled: handleAudioWaiting,
        playing: handleAudioPlaying,
        seeked: handleAudioSeeked,
        ratechange: handleAudioRateChange,
      }));

      const expectedDuration = wordTimings?.at?.(-1)?.end || Number.NaN;
      setCurrentAudioWatchdog(createAudioStallWatchdog({
        delayMs: getAudioWatchdogDelayMs(expectedDuration, audio.playbackRate),
        onStall: () => {
          const error = new Error('Audio playback stalled.');
          error.code = 'audio_playback_stalled';
          fail(error);
        },
      }));

      const openPlayGate = () => {
        if (playGateOpen || settled) return;
        playGateOpen = true;
        clearPlayStartFenceTimer();
        flowRecorder.record({
          kind: 'audio_decode_latency',
          channel: 'decode_latency',
          chunkIndex: sectionIndex,
          decodeLatencyMs: playRequestedAtMs === null ? 0 : Math.max(0, getNowMs() - playRequestedAtMs),
          readyState: Number.isFinite(Number(audio?.readyState)) ? Number(audio.readyState) : null,
        });
        if (isStopped({ signal, runId })) {
          finish();
          return;
        }
        recordAudioStart();
        startWordHighlighting();
        schedulePlaybackTimers();
        highlightPlanResyncLoop.start();
      };

      playStartFenceTimer = setTimeout(openPlayGate, BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS);
      playRequestedAtMs = getNowMs();
      const playResult = audio.play();
      if (playResult?.then) {
        playResult.then(() => {
          openPlayGate();
        }).catch(fail);
      } else {
        openPlayGate();
      }
    });
  }

  function clearAudioElement() {
    clearAudioListenerState();
    audioPool.release?.();
    setCurrentAudio(null);
    currentAudioWatchdog?.dispose?.();
    setCurrentAudioWatchdog(null);
    setCurrentSectionRescheduler(() => {});
  }

  function stop() {
    clearAudioElement();
  }

  function getState() {
    return {
      currentAudio,
      currentAudioWatchdog,
      clearCurrentAudioEventListeners,
      rescheduleCurrentSectionTiming,
    };
  }

  publishAudioState();

  return {
    playAudio,
    stop,
    getState,
  };
}

export function createAudioOutputLatencyReader({ globalRef = globalThis } = {}) {
  let cachedAudioOutputLatencySeconds = null;
  return function readAudioOutputLatencySeconds() {
    if (cachedAudioOutputLatencySeconds !== null) return cachedAudioOutputLatencySeconds;
    const AudioContextCtor = globalRef.AudioContext || globalRef.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') {
      cachedAudioOutputLatencySeconds = 0;
      return cachedAudioOutputLatencySeconds;
    }
    try {
      const audioContext = new AudioContextCtor();
      const latency = Number(audioContext.outputLatency);
      const closeResult = audioContext.close?.();
      closeResult?.catch?.(() => undefined);
      cachedAudioOutputLatencySeconds = Number.isFinite(latency) && latency > 0 && latency < 1 ? latency : 0;
    } catch {
      cachedAudioOutputLatencySeconds = 0;
    }
    return cachedAudioOutputLatencySeconds;
  };
}
