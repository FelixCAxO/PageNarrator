import { describe, expect, it, vi } from 'vitest';
import { createReaderSession } from '../../src/reader/reader-session.js';

describe('reader session state', () => {
  it('starts a read with deterministic state', () => {
    const session = createReaderSession();
    const activeReadPromise = Promise.resolve();

    session.startRead({
      tabId: 42,
      chunks: ['One.', 'Two.'],
      chunkIterator: { async return() {} },
      source: 'pdf',
      pdfPageCount: 9,
      pageContextKey: 'tab:42',
      activeReadPromise,
    });
    session.setReadingState('reading');
    session.setCurrentChunk(1);

    expect(session.snapshot()).toMatchObject({
      readingState: 'reading',
      currentChunk: 1,
      totalChunks: 2,
      activeChunks: ['One.', 'Two.'],
      activeReadTabId: 42,
      activeArticleSource: 'pdf',
      activePdfPageCount: 9,
      activePageContextKey: 'tab:42',
      activeReadPromise,
    });
  });

  it('cleans up iterators, pause gates, and read handles', async () => {
    const returnIterator = vi.fn(async () => ({ done: true }));
    const resumeGate = vi.fn();
    const session = createReaderSession();

    session.startRead({
      tabId: 7,
      chunks: ['Only chunk.'],
      chunkIterator: { return: returnIterator },
      pauseGate: { resume: resumeGate },
      teardownHandles: [vi.fn(), vi.fn()],
      activeReadPromise: Promise.resolve(),
    });

    await session.resetRead();

    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(resumeGate).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      readingState: 'idle',
      currentChunk: 0,
      totalChunks: 0,
      activeChunks: [],
      activeChunkIterator: null,
      activeReadTabId: null,
      activeReadPromise: null,
      pendingReadPauseGate: null,
      teardownHandles: [],
    });
  });
});
