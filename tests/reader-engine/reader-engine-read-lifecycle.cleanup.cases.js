import { createPageStream } from './reader-engine-read-lifecycle.fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { clearSpeechPreloadState, cleanupReadRun, createPdfEmptyStreamDiagnostics, createReadRunTracker, getEmptyStreamMessage, runCleanupAfterSettled, shouldCleanupReadOnPanelHide, shouldStopReadForClosedTab, waitForSpeechPreloadReady, READ_STREAM_CLEANUP_TIMEOUT_MS } from "../../src/lib/reader-engine-read-lifecycle.js";

import { deferred } from '../fixtures/async-helpers.js';

it.each(['aborted', 'failed'])('bounds handoff decode readiness when %s', async (reason) => {
  vi.useFakeTimers();
  try {
    const signal = new AbortController();
    const pending = waitForSpeechPreloadReady({
      speechPreloads: new Map([[0, Promise.resolve({ result: { blob: new Blob(['audio']), audioReady: new Promise(() => {}) } })]]),
      index: 0, signal: signal.signal, firstSegmentReadyTimeoutMs: 100,
    });
    let result;
    void pending.then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'aborted') signal.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toEqual({ ok: false, reason });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

describe('toolbar player read lifecycle', () => {
  it('does not let delayed cleanup from an old PDF read return the new stream', async () => {
    const tracker = createReadRunTracker();
    let activeIterator = null;
    const lateCleanup = deferred();

    const oldStream = createPageStream({ speech: 'Old page text.', pageNumber: 12 });
    const oldRunId = tracker.beginRun();
    activeIterator = oldStream.iterator;

    const oldCleanup = cleanupReadRun({
      runId: oldRunId,
      iterator: oldStream.iterator,
      cleanup: () => lateCleanup.promise,
      isCurrentRun: tracker.isCurrentRun,
      clearCurrentRunState() {
        activeIterator = null;
      },
    });

    const newStream = createPageStream({ speech: 'Page 50 starts here.', pageNumber: 50 });
    tracker.beginRun();
    activeIterator = newStream.iterator;

    lateCleanup.resolve();
    await oldCleanup;

    expect(oldStream.returned).toBe(true);
    expect(newStream.returned).toBe(false);
    expect(activeIterator).toBe(newStream.iterator);
    await expect(activeIterator.next()).resolves.toEqual({
      done: false,
      value: { speech: 'Page 50 starts here.', pageNumber: 50 },
    });
  });

  it('aborts stale run signals when a new read starts and can abort the active run', () => {
    const tracker = createReadRunTracker();

    const firstRunId = tracker.beginRun();
    const firstSignal = tracker.getRunSignal(firstRunId);
    expect(firstSignal.aborted).toBe(false);

    const secondRunId = tracker.beginRun();
    const secondSignal = tracker.getRunSignal(secondRunId);

    expect(firstSignal.aborted).toBe(true);
    expect(tracker.isRunStopped(firstRunId)).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(tracker.isRunStopped(secondRunId)).toBe(false);

    expect(tracker.abortCurrentRun()).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    expect(tracker.isRunStopped(secondRunId)).toBe(true);
    expect(tracker.abortCurrentRun()).toBe(false);
  });

  it('does not block state cleanup on a stream iterator that never closes', async () => {
    vi.useFakeTimers();
    try {
      const clearCurrentRunState = vi.fn();
      const cleanup = cleanupReadRun({
        runId: 1,
        iterator: { return: () => new Promise(() => {}) },
        clearCurrentRunState,
      });
      const settled = Promise.race([
        cleanup.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), READ_STREAM_CLEANUP_TIMEOUT_MS + 100)),
      ]);

      await vi.advanceTimersByTimeAsync(READ_STREAM_CLEANUP_TIMEOUT_MS + 100);

      await expect(settled).resolves.toBe(true);
      expect(clearCurrentRunState).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the requested PDF page when a streamed PDF read yields no chunks', () => {
    expect(getEmptyStreamMessage({
      source: 'pdf',
      startPosition: { pageNumber: 50 },
    })).toBe('Could not extract text from PDF page 50');

    expect(createPdfEmptyStreamDiagnostics({
      source: 'pdf',
      startPosition: { pageNumber: 50 },
      pageCount: 1241,
    }, {
      tabId: 33,
      hasIterator: true,
    })).toEqual({
      startPage: 50,
      pageCount: 1241,
      tabId: 33,
      hasIterator: true,
    });
  });

  it('keeps the generic empty-text message for non-PDF streams', () => {
    expect(getEmptyStreamMessage({ source: 'reading-model' })).toBe('Could not detect article text');
    expect(createPdfEmptyStreamDiagnostics({ source: 'reading-model' })).toBeNull();
  });

  it('clears active speech preloads when reading stops', () => {
    const speechPreloads = new Map([[2, Promise.resolve('stale')]]);
    const queuedHighlightIndices = new Set([3]);
    const preloadState = { inFlight: true, inFlightCount: 1 };

    clearSpeechPreloadState({
      speechPreloads,
      queuedHighlightIndices,
      preloadState,
    });

    expect(speechPreloads.size).toBe(0);
    expect(queuedHighlightIndices.size).toBe(0);
    expect(preloadState).toMatchObject({ inFlight: false, inFlightCount: 0 });
  });

  it('defers cleanup until the active read promise settles', async () => {
    const activeRead = deferred();
    const calls = [];

    const cleanup = runCleanupAfterSettled(activeRead.promise, () => {
      calls.push('cleanup');
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);

    activeRead.resolve();
    await cleanup;

    expect(calls).toEqual(['cleanup']);
  });

  it('returns progressive segment iterators when reading stop clears active preloads', async () => {
    let returned = false;
    const speechPreloads = new Map([
      [2, Promise.resolve({
        result: {
          kind: 'segments',
          segments: {
            async return() {
              returned = true;
              return { done: true, value: undefined };
            },
          },
        },
      })],
    ]);

    clearSpeechPreloadState({ speechPreloads });
    await Promise.resolve();

    expect(returned).toBe(true);
    expect(speechPreloads.size).toBe(0);
  });

  it('returns chunk preload resources when reading stop clears active preloads', async () => {
    let returned = false;
    const speechPreloads = new Map([
      [2, Promise.resolve({
        result: {
          kind: 'chunk',
          return() {
            returned = true;
          },
        },
      })],
    ]);

    clearSpeechPreloadState({ speechPreloads });
    await Promise.resolve();

    expect(returned).toBe(true);
    expect(speechPreloads.size).toBe(0);
  });

  it('cleans prepared audio resources when generated speech preloads are discarded', async () => {
    const cleanup = vi.fn();
    const speechPreloads = new Map([
      [2, Promise.resolve({
        result: {
          blob: new Blob(['audio']),
          preparedAudio: { cleanup },
        },
      })],
    ]);

    clearSpeechPreloadState({ speechPreloads });
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(speechPreloads.size).toBe(0);
  });

  it('stops only the active read when its owning tab closes', () => {
    expect(shouldStopReadForClosedTab({
      activeReadTabId: 42,
      closedTabId: 42,
      state: 'reading',
    })).toBe(true);
    expect(shouldStopReadForClosedTab({
      activeReadTabId: 42,
      closedTabId: 42,
      state: 'paused',
    })).toBe(true);
    expect(shouldStopReadForClosedTab({
      activeReadTabId: 42,
      closedTabId: 42,
      state: 'preparing',
    })).toBe(true);

    expect(shouldStopReadForClosedTab({
      activeReadTabId: 42,
      closedTabId: 99,
      state: 'reading',
    })).toBe(false);
    expect(shouldStopReadForClosedTab({
      activeReadTabId: 42,
      closedTabId: 42,
      state: 'finished',
    })).toBe(false);
    expect(shouldStopReadForClosedTab({
      activeReadTabId: null,
      closedTabId: 42,
      state: 'reading',
    })).toBe(false);
  });

  it('cleans transient playback state when the toolbar player is hidden during an active read', () => {
    expect(shouldCleanupReadOnPanelHide({ state: 'preparing' })).toBe(true);
    expect(shouldCleanupReadOnPanelHide({ state: 'reading' })).toBe(true);
    expect(shouldCleanupReadOnPanelHide({ state: 'paused' })).toBe(true);
    expect(shouldCleanupReadOnPanelHide({ state: 'idle' })).toBe(false);
    expect(shouldCleanupReadOnPanelHide({ state: 'finished' })).toBe(false);
    expect(shouldCleanupReadOnPanelHide({ state: 'error' })).toBe(false);
  });
});
