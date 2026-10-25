import { describe, expect, it, vi } from 'vitest';
import { createPlaybackSession } from '../../src/lib/playback-session.js';

describe('playback session state', () => {
  it('starts with the current readerEngine idle playback-session defaults', () => {
    const session = createPlaybackSession();

    expect(session.snapshot()).toMatchObject({
      activeReadTabId: null,
      readingState: 'idle',
      currentChunk: 0,
      totalChunks: 0,
      activeChunks: [],
      activeChunkWordCounts: [],
      activeArticleSource: '',
      activePdfPageCount: 0,
      activePageContextKey: '',
      queueSearchQuery: '',
      activeReadingCursor: null,
      activeChunkIterator: null,
      releaseReadSessionAfterCleanup: false,
    });
  });

  it('stores article playback buffers and exposes progress fields', () => {
    const iterator = { next: vi.fn() };
    const cursor = { current: 0 };
    const chunks = [{ speech: 'One' }, { speech: 'Two' }];
    const session = createPlaybackSession();

    session.setArticleSession({
      tabId: 42,
      source: 'pdf',
      pageCount: 7,
      contextKey: 'tab:42:https://example.test',
      chunks,
      wordCounts: [1, 1],
      iterator,
      cursor,
    });
    session.setReadingStateFields({ readingState: 'reading', currentChunk: 1, totalChunks: 2 });

    expect(session.snapshot()).toMatchObject({
      activeReadTabId: 42,
      readingState: 'reading',
      currentChunk: 1,
      totalChunks: 2,
      activeChunks: chunks,
      activeChunkWordCounts: [1, 1],
      activeArticleSource: 'pdf',
      activePdfPageCount: 7,
      activePageContextKey: 'tab:42:https://example.test',
      activeReadingCursor: cursor,
      activeChunkIterator: iterator,
    });
  });

  it('clears retained article buffers without touching playback progress', () => {
    const clearTranscript = vi.fn();
    const clearQueueSearchInput = vi.fn();
    const session = createPlaybackSession({ clearTranscript, clearQueueSearchInput });

    session.setArticleSession({
      tabId: 9,
      source: 'article-fallback',
      chunks: ['A'],
      wordCounts: [1],
      contextKey: 'tab:9',
    });
    session.setReadingStateFields({ readingState: 'finished', currentChunk: 1, totalChunks: 1 });
    session.clearReadSessionBuffers();

    expect(session.snapshot()).toMatchObject({
      readingState: 'finished',
      currentChunk: 1,
      totalChunks: 1,
      activeChunks: [],
      activeChunkWordCounts: [],
      activeArticleSource: '',
      activePdfPageCount: 0,
      activeChunkIterator: null,
      activeReadingCursor: null,
    });
    expect(clearTranscript).toHaveBeenCalledTimes(1);
    expect(clearQueueSearchInput).toHaveBeenCalledTimes(1);
  });

  it('clears idle context when active tab changes, but keeps active reads intact', () => {
    const session = createPlaybackSession();
    session.setArticleSession({ tabId: 1, contextKey: 'tab:1', chunks: ['A'] });

    expect(session.handleActiveTabContextChanged('tab:2')).toEqual({ reset: true });
    expect(session.snapshot().activePageContextKey).toBe('');

    session.setArticleSession({ tabId: 1, contextKey: 'tab:1', chunks: ['A'] });
    session.setReadingStateFields({ readingState: 'reading', currentChunk: 0, totalChunks: 1 });

    expect(session.handleActiveTabContextChanged('tab:2')).toEqual({ reset: false });
    expect(session.snapshot().activePageContextKey).toBe('tab:1');
  });

  it('marks releaseBuffers for tab-close and pagehide cleanup', () => {
    const session = createPlaybackSession();

    session.markReleaseBuffersAfterCleanup();

    expect(session.snapshot().releaseReadSessionAfterCleanup).toBe(true);
    expect(session.shouldReleaseBuffersAfterRead({ stoppedRun: false })).toBe(true);
  });

  it('resets transient playback refs after current-run cleanup', () => {
    const delay = { cancel: vi.fn() };
    const watchdog = { dispose: vi.fn() };
    const clearListeners = vi.fn();
    const session = createPlaybackSession();

    session.setTransientRefs({
      activeSectionPauseDelay: delay,
      currentAudioWatchdog: watchdog,
      clearCurrentAudioEventListeners: clearListeners,
      rescheduleCurrentSectionTiming: vi.fn(),
    });
    session.resetCurrentRunState({ shouldReleaseBuffers: false, shouldResetState: true });

    const snapshot = session.snapshot();
    expect(delay.cancel).toHaveBeenCalledTimes(1);
    expect(watchdog.dispose).toHaveBeenCalledTimes(1);
    expect(clearListeners).toHaveBeenCalledTimes(1);
    expect(snapshot.activeSectionPauseDelay).toBeNull();
    expect(snapshot).not.toHaveProperty('activeSpeechUtterance');
    expect(snapshot).not.toHaveProperty('currentBrowserSpeechResolve');
    expect(snapshot.currentAudioWatchdog).toBeNull();
  });

  it('runs registered speech preload cleanup exactly once', () => {
    const cleanup = vi.fn();
    const session = createPlaybackSession();

    session.setActiveSpeechPreloadCleanup(cleanup);
    session.clearActiveSpeechPreloads();
    session.clearActiveSpeechPreloads();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
