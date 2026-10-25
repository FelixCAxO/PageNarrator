const noop = (...args) => {
  void args;
};

/**
 * @typedef {Record<string, unknown>} PlaybackChunk
 * @typedef {{
 *   activeReadTabId: number | null,
 *   readingState: string,
 *   currentChunk: number,
 *   totalChunks: number,
 *   activeChunks: Array<PlaybackChunk | string>,
 *   activeChunkWordCounts: number[],
 *   activeArticleSource: string,
 *   activePdfPageCount: number,
 *   modelSetupState: Record<string, unknown>,
 *   activePageContextKey: string,
 *   queueSearchQuery: string,
 *   activeReadingCursor: unknown,
 *   activeChunkIterator: unknown,
 *   releaseReadSessionAfterCleanup: boolean,
 *   activeSectionPauseDelay: { cancel?: Function } | null,
 *   currentAudioWatchdog: { dispose?: Function } | null,
 *   rescheduleCurrentSectionTiming: Function,
 *   clearCurrentAudioEventListeners: Function,
 *   activeSpeechPreloadCleanup: Function,
 *   ttsSectionReadyTransitionTracker: unknown,
 * }} PlaybackSessionState
 */

/**
 * @param {{
 *   clearTranscript?: Function,
 *   clearQueueSearchInput?: Function,
 *   renderResumePrompt?: Function,
 *   renderCodeSuggestion?: Function,
 *   setArticleSummary?: Function,
 * }} options
 */
export function createPlaybackSession({
  clearTranscript = noop,
  clearQueueSearchInput = noop,
  renderResumePrompt = noop,
  renderCodeSuggestion = noop,
  setArticleSummary = noop,
} = {}) {
  /** @type {PlaybackSessionState} */
  const state = {
    activeReadTabId: null,
    readingState: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    activeChunks: [],
    activeChunkWordCounts: [],
    activeArticleSource: '',
    activePdfPageCount: 0,
    modelSetupState: { phase: 'idle' },
    activePageContextKey: '',
    queueSearchQuery: '',
    activeReadingCursor: null,
    activeChunkIterator: null,
    releaseReadSessionAfterCleanup: false,
    activeSectionPauseDelay: null,
    currentAudioWatchdog: null,
    rescheduleCurrentSectionTiming: noop,
    clearCurrentAudioEventListeners: noop,
    activeSpeechPreloadCleanup: noop,
    ttsSectionReadyTransitionTracker: null,
  };

  function snapshot() {
    return {
      ...state,
      activeChunks: state.activeChunks,
      activeChunkWordCounts: state.activeChunkWordCounts,
      modelSetupState: { ...state.modelSetupState },
    };
  }

  /** @param {{ readingState?: string, currentChunk?: number, totalChunks?: number }} fields */
  function setReadingStateFields({ readingState, currentChunk, totalChunks } = {}) {
    if (typeof readingState === 'string') state.readingState = readingState;
    if (typeof currentChunk === 'number' && Number.isFinite(currentChunk)) {
      state.currentChunk = Math.max(0, Math.trunc(currentChunk));
    }
    if (typeof totalChunks === 'number' && Number.isFinite(totalChunks)) {
      state.totalChunks = Math.max(0, Math.trunc(totalChunks));
    }
  }

  /**
   * @param {{
   *   tabId?: number | null,
   *   source?: string,
   *   pageCount?: number,
   *   contextKey?: string,
   *   chunks?: Array<PlaybackChunk | string>,
   *   wordCounts?: number[],
   *   iterator?: unknown,
   *   cursor?: unknown,
   * }} session
   */
  function setArticleSession({
    tabId = null,
    source = '',
    pageCount = 0,
    contextKey = '',
    chunks = [],
    wordCounts = [],
    iterator = null,
    cursor = null,
  } = {}) {
    state.activeReadTabId = tabId ?? null;
    state.activeArticleSource = String(source || '');
    state.activePdfPageCount = Math.max(0, Math.trunc(Number(pageCount) || 0));
    state.activePageContextKey = String(contextKey || '');
    state.activeChunks = Array.isArray(chunks) ? chunks : [];
    state.activeChunkWordCounts = Array.isArray(wordCounts) ? wordCounts : [];
    state.activeChunkIterator = iterator;
    state.activeReadingCursor = cursor;
  }

  function clearReadSessionBuffers() {
    state.activeChunks = [];
    state.activeChunkWordCounts = [];
    state.activeArticleSource = '';
    state.activePdfPageCount = 0;
    state.activeChunkIterator = null;
    state.activeReadingCursor = null;
    state.queueSearchQuery = '';
    clearTranscript();
    clearQueueSearchInput();
    renderResumePrompt(null);
    renderCodeSuggestion(null);
    setArticleSummary('');
  }

  /** @param {string} nextKey */
  function handleActiveTabContextChanged(nextKey) {
    if (!state.activePageContextKey || state.activePageContextKey === nextKey) return { reset: false };
    if (state.readingState === 'reading' || state.readingState === 'loading' || state.readingState === 'stopping') {
      return { reset: false };
    }
    state.activePageContextKey = '';
    state.activeReadTabId = null;
    return { reset: true };
  }

  function markReleaseBuffersAfterCleanup() {
    state.releaseReadSessionAfterCleanup = true;
  }

  /** @param {{ stoppedRun?: boolean }} options */
  function shouldReleaseBuffersAfterRead({ stoppedRun } = {}) {
    return Boolean(stoppedRun || state.releaseReadSessionAfterCleanup || state.readingState === 'finished');
  }

  /** @param {{ stoppedRun?: boolean }} options */
  function shouldResetStateAfterCleanup({ stoppedRun } = {}) {
    return Boolean(stoppedRun || state.releaseReadSessionAfterCleanup);
  }

  /** @param {Function} cleanup */
  function setActiveSpeechPreloadCleanup(cleanup) {
    state.activeSpeechPreloadCleanup = typeof cleanup === 'function' ? cleanup : noop;
  }

  function clearActiveSpeechPreloads() {
    const cleanup = state.activeSpeechPreloadCleanup;
    state.activeSpeechPreloadCleanup = noop;
    cleanup();
  }

  /** @param {Partial<PlaybackSessionState>} refs */
  function setTransientRefs(refs = {}) {
    for (const key of [
      'activeSectionPauseDelay',
      'currentAudioWatchdog',
      'rescheduleCurrentSectionTiming',
      'clearCurrentAudioEventListeners',
      'ttsSectionReadyTransitionTracker',
    ]) {
      if (Object.prototype.hasOwnProperty.call(refs, key)) state[key] = refs[key];
    }
  }

  /** @param {{ shouldReleaseBuffers?: boolean, shouldResetState?: boolean }} options */
  function resetCurrentRunState({ shouldReleaseBuffers, shouldResetState } = {}) {
    state.activeSectionPauseDelay?.cancel?.();
    state.currentAudioWatchdog?.dispose?.();
    state.clearCurrentAudioEventListeners?.();
    clearActiveSpeechPreloads();

    state.activeSectionPauseDelay = null;
    state.currentAudioWatchdog = null;
    state.rescheduleCurrentSectionTiming = noop;
    state.clearCurrentAudioEventListeners = noop;
    state.ttsSectionReadyTransitionTracker = null;

    if (shouldReleaseBuffers) clearReadSessionBuffers();
    if (shouldResetState) {
      state.readingState = 'idle';
      state.currentChunk = 0;
      state.totalChunks = 0;
      state.releaseReadSessionAfterCleanup = false;
    }
  }

  return {
    snapshot,
    setReadingStateFields,
    setArticleSession,
    clearReadSessionBuffers,
    handleActiveTabContextChanged,
    markReleaseBuffersAfterCleanup,
    shouldReleaseBuffersAfterRead,
    shouldResetStateAfterCleanup,
    setActiveSpeechPreloadCleanup,
    clearActiveSpeechPreloads,
    setTransientRefs,
    resetCurrentRunState,
  };
}
