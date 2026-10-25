/**
 * @typedef {object} ReaderState
 * @property {string} readingState
 * @property {number} currentChunk
 * @property {number} totalChunks
 * @property {any[]} activeChunks
 * @property {number[]} activeChunkWordCounts
 * @property {any} activeChunkIterator
 * @property {number|null} activeReadTabId
 * @property {string} activeArticleSource
 * @property {number} activePdfPageCount
 * @property {{ phase: string }} modelSetupState
 * @property {string} activePageContextKey
 * @property {any} activeReadingCursor
 * @property {Promise<any>|null} activeReadPromise
 * @property {{ resume?: () => void }|null} pendingReadPauseGate
 * @property {Array<() => void|Promise<void>>} teardownHandles
 */

export const READER_STATES = Object.freeze([
  'idle',
  'preparing',
  'reading',
  'paused',
  'stopping',
  'finished',
  'error',
]);

/** @returns {ReaderState} */
export function createInitialReadState() {
  return {
    readingState: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    activeChunks: [],
    activeChunkWordCounts: [],
    activeChunkIterator: null,
    activeReadTabId: null,
    activeArticleSource: '',
    activePdfPageCount: 0,
    modelSetupState: { phase: 'idle' },
    activePageContextKey: '',
    activeReadingCursor: null,
    activeReadPromise: null,
    pendingReadPauseGate: null,
    teardownHandles: [],
  };
}

/** @param {string} state */
export function normalizeReaderState(state) {
  return READER_STATES.includes(state) ? state : 'idle';
}
