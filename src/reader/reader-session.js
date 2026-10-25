import { createInitialReadState, normalizeReaderState } from './read-state.js';

/**
 * @param {Partial<import('./read-state.js').ReaderState>} [initialState]
 */
export function createReaderSession(initialState = {}) {
  /** @type {import('./read-state.js').ReaderState} */
  const state = {
    ...createInitialReadState(),
    ...initialState,
  };

  function snapshot() {
    return {
      ...state,
      activeChunks: [...state.activeChunks],
      activeChunkWordCounts: [...state.activeChunkWordCounts],
      teardownHandles: [...state.teardownHandles],
    };
  }

  /**
   * @param {object} [options]
   * @param {number|null} [options.tabId]
   * @param {any[]} [options.chunks]
   * @param {any} [options.chunkIterator]
   * @param {string} [options.source]
   * @param {number} [options.pdfPageCount]
   * @param {string} [options.pageContextKey]
   * @param {Promise<any>|null} [options.activeReadPromise]
   * @param {{ resume?: () => void }|null} [options.pauseGate]
   * @param {Array<() => void|Promise<void>>} [options.teardownHandles]
   */
  function startRead({
    tabId = null,
    chunks = [],
    chunkIterator = null,
    source = '',
    pdfPageCount = 0,
    pageContextKey = '',
    activeReadPromise = null,
    pauseGate = null,
    teardownHandles = [],
  } = {}) {
    state.readingState = 'preparing';
    state.currentChunk = 0;
    state.activeChunks = Array.isArray(chunks) ? [...chunks] : [];
    state.totalChunks = state.activeChunks.length;
    state.activeChunkIterator = chunkIterator;
    state.activeReadTabId = tabId ?? null;
    state.activeArticleSource = String(source || '');
    state.activePdfPageCount = Number.isFinite(Number(pdfPageCount)) ? Number(pdfPageCount) : 0;
    state.activePageContextKey = String(pageContextKey || '');
    state.activeReadPromise = activeReadPromise;
    state.pendingReadPauseGate = pauseGate;
    state.teardownHandles = Array.isArray(teardownHandles) ? [...teardownHandles] : [];
  }

  /** @param {string} nextState */
  function setReadingState(nextState) {
    state.readingState = normalizeReaderState(nextState);
  }

  /** @param {number} index */
  function setCurrentChunk(index) {
    const numeric = Number(index);
    state.currentChunk = Number.isFinite(numeric)
      ? Math.max(0, Math.min(Math.trunc(numeric), Math.max(0, state.totalChunks - 1)))
      : 0;
  }

  async function resetRead() {
    const iterator = state.activeChunkIterator;
    const gate = state.pendingReadPauseGate;
    const teardownHandles = [...state.teardownHandles];

    state.pendingReadPauseGate = null;
    gate?.resume?.();
    if (typeof iterator?.return === 'function') await iterator.return();
    for (const teardown of teardownHandles) await teardown?.();

    Object.assign(state, createInitialReadState());
  }

  return {
    state,
    snapshot,
    startRead,
    setCurrentChunk,
    setReadingState,
    resetRead,
  };
}
