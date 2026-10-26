import { t } from './i18n.js';
import { shouldStopReadForClosedTab as defaultShouldStopReadForClosedTab } from './reader-engine-read-lifecycle.js';
import {
  createPauseableDelay as defaultCreatePauseableDelay,
  fadeOutAudioThenPause as defaultFadeOutAudioThenPause,
} from './speech-playback.js';

/** @param {any} [deps] */
export function createReaderEngineReadControlsController({
  state,
  readRunTracker,
  playbackSession,
  setReadingState,
  setPageHighlightPaused,
  clearPageHighlight,
  clearActiveSpeechPreloads,
  getSectionPauseDelayMs = () => 0,
  recordSectionPause = () => {},
  onPrimaryRead,
  onReadSelected,
  onGrantAccess,
  chrome,
  logger = console,
  onError = () => {},
  createPauseableDelay = defaultCreatePauseableDelay,
  fadeOutAudioThenPause = defaultFadeOutAudioThenPause,
  shouldStopReadForClosedTab = defaultShouldStopReadForClosedTab,
} = {}) {
  function handlePrimaryAction({ tab = null, resumeConfirmed = false } = {}) {
    if (state.readingState === 'error' && state.activePrimaryAction) {
      handleErrorRecoveryAction(state.activePrimaryAction, { tab });
      return;
    }
    if (state.readingState === 'reading') return pauseReading();
    if (state.readingState === 'paused') return resumeReading();
    // A finished read restarts from the top, or for PDFs from a page the reader has scrolled to since.
    onPrimaryRead?.({ tab, startMode: state.readingState === 'finished' ? 'restart' : 'viewport', resumeConfirmed });
  }

  function handleReadSelectedAction({ tab = null } = {}) {
    if (state.readingState === 'reading' || state.readingState === 'paused' || state.readingState === 'preparing') return;
    onReadSelected?.({ tab });
  }

  function handleErrorRecoveryAction(action, { tab = null } = {}) {
    if (action === 'read-selected') return handleReadSelectedAction({ tab });
    if (action === 'support') {
      void Promise.resolve(chrome?.tabs?.create?.({ url: 'https://pagenarrator.com/support' })).catch(onError);
      return;
    }
    if (action === 'grant-access') {
      void Promise.resolve(onGrantAccess?.({ tab })).catch(onError);
      return;
    }
    onPrimaryRead?.({ tab, startMode: 'viewport', recovery: true });
  }

  function pauseReading() {
    if (state.activeSectionPauseDelay && state.readingState === 'reading') {
      state.activeSectionPauseDelay.pause();
      setPageHighlightPaused(true).catch(onError);
      setReadingState('paused');
      return;
    }
    if (state.readingState !== 'reading') return;
    if (!state.currentAudio) return requestPendingReadPause();
    state.currentAudio.pause();
    state.currentAudioWatchdog?.pause();
    setPageHighlightPaused(true).catch(onError);
    setReadingState('paused');
  }

  function resumeReading() {
    if (state.pendingReadPauseGate && state.readingState === 'paused') return resumePendingReadPause();
    if (state.activeSectionPauseDelay && state.readingState === 'paused') {
      state.activeSectionPauseDelay.resume();
      setPageHighlightPaused(false).catch(onError);
      setReadingState('reading');
      return;
    }
    if (!state.currentAudio || state.readingState !== 'paused') return;
    state.currentAudio.play().then(() => {
      state.currentAudioWatchdog?.resume();
      setPageHighlightPaused(false).catch(onError);
      setReadingState('reading');
    }).catch((error) => {
      logger.error?.('Audio playback failed.', error);
      setReadingState('error', { message: t("Audio playback failed.") });
    });
  }

  function requestPendingReadPause() {
    if (!state.pendingReadPauseGate) state.pendingReadPauseGate = createReadPauseGate();
    setPageHighlightPaused(true).catch(onError);
    setReadingState('paused');
  }

  function resumePendingReadPause() {
    const gate = state.pendingReadPauseGate;
    state.pendingReadPauseGate = null;
    setPageHighlightPaused(false).catch(onError);
    setReadingState('reading');
    gate?.resume();
  }

  function clearPendingReadPause() {
    const gate = state.pendingReadPauseGate;
    state.pendingReadPauseGate = null;
    gate?.resume();
  }

  function createReadPauseGate() {
    let resolveGate = /** @type {(value?: unknown) => void} */ (() => {});
    const promise = new Promise((resolve) => { resolveGate = resolve; });
    return {
      wait({ signal = null } = {}) {
        const abortSignal = /** @type {AbortSignal|null} */ (signal);
        if (abortSignal?.aborted) return Promise.resolve();
        if (typeof abortSignal?.addEventListener !== 'function') return promise;
        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            abortSignal.removeEventListener?.('abort', finish);
            resolve(undefined);
          };
          abortSignal.addEventListener('abort', finish, { once: true });
          void promise.then(finish).catch(onError);
        });
      },
      resume: () => resolveGate(),
    };
  }

  function handleReadTabRemoved(tabId) {
    if (!shouldStopReadForClosedTab({ activeReadTabId: state.activeReadTabId, closedTabId: tabId, state: state.readingState })) return;
    stopReading({ releaseBuffers: true });
  }

  function stopReading(options = {}) {
    if (options?.releaseBuffers === true) {
      playbackSession.markReleaseBuffersAfterCleanup();
      state.releaseReadSessionAfterCleanup = true;
    }
    if (state.readingState === 'idle' || state.readingState === 'stopping') return state.activeReadPromise || Promise.resolve();
    readRunTracker.abortCurrentRun();
    if (state.currentAudio) finishCurrentAudioWithFade({ seekTo: 0, dispatchEnded: false });
    setReadingState('stopping');
    clearPendingReadPause();
    clearActiveSpeechPreloads();
    clearPageHighlight().catch(onError);
    state.activeSectionPauseDelay?.complete();
    return state.activeReadPromise || Promise.resolve();
  }

  /** @param {{ seekTo?: number|null, dispatchEnded?: boolean, onComplete?: Function|null }} [options] */
  function finishCurrentAudioWithFade({ seekTo = null, dispatchEnded = true, onComplete = null } = {}) {
    const audio = state.currentAudio;
    if (!audio) return false;
    fadeOutAudioThenPause(audio, {
      durationMs: 60,
      onComplete: () => {
        if (Number.isFinite(Number(seekTo))) audio.currentTime = Number(seekTo);
        if (dispatchEnded) audio.dispatchEvent(new Event('ended'));
        onComplete?.();
      },
    });
    return true;
  }

  function skipToNextChunk() { requestJump((Number.isFinite(state.currentChunk) ? state.currentChunk : 0) + 1); }
  function skipToPreviousChunk() { requestJump((Number.isFinite(state.currentChunk) ? state.currentChunk : 0) - 1); }
  function requestJump(index) {
    if ((!state.currentAudio && !state.activeSectionPauseDelay) || !state.activeReadingCursor || (state.readingState !== 'reading' && state.readingState !== 'paused')) return;
    const targetIndex = getLoadedJumpIndex(index);
    if (targetIndex === null) return;
    state.activeReadingCursor.requestJump(targetIndex);
    if (state.activeSectionPauseDelay) return state.activeSectionPauseDelay.complete();
    finishCurrentAudioWithFade({ seekTo: Math.max(0, state.currentAudio.duration || 0) });
  }
  function getLoadedJumpIndex(index) {
    if (!state.activeChunks.length) return null;
    const target = Number(index);
    if (!Number.isFinite(target)) return null;
    return Math.max(0, Math.min(state.activeChunks.length - 1, Math.trunc(target)));
  }
  function waitForReadPause({ signal = null } = {}) {
    return state.pendingReadPauseGate?.wait({ signal }) || Promise.resolve();
  }

  /** @param {{ signal?: AbortSignal|null }} [options] */
  async function waitBetweenSections(nextIndex, availableChunkCount, options = {}) {
    const { signal = null } = options;
    const delayMs = getSectionPauseDelayMs();
    if (delayMs <= 0 || signal?.aborted || nextIndex <= 0 || nextIndex >= availableChunkCount) return;
    recordSectionPause({ fromSectionIndex: nextIndex - 1, toSectionIndex: nextIndex, pauseAppliedMs: delayMs });
    await new Promise((resolve) => {
      const delayHandle = createPauseableDelay({
        delayMs,
        onComplete() {
          if (state.activeSectionPauseDelay === delayHandle) state.activeSectionPauseDelay = null;
          resolve(undefined);
        },
      });
      state.activeSectionPauseDelay = delayHandle;
    });
  }

  return {
    handlePrimaryAction,
    handleReadSelectedAction,
    handleErrorRecoveryAction,
    pauseReading,
    resumeReading,
    clearPendingReadPause,
    waitForReadPause,
    handleReadTabRemoved,
    stopReading,
    finishCurrentAudioWithFade,
    skipToNextChunk,
    skipToPreviousChunk,
    requestJump,
    getLoadedJumpIndex,
    waitBetweenSections,
  };
}
