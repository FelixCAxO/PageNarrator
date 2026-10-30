import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createReadOrchestrator,
  fillStreamingChunkBuffer,
  getPlaybackTotal,
  resolveInitialReadPosition,
  resolveReadCleanupDisposition,
} from '../../src/lib/core/reader-engine-read-orchestrator.js';

function createAsyncIterator(values, { beforeResolve = null } = {}) {
  let index = 0;
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async next() {
      reads += 1;
      if (typeof beforeResolve === 'function') beforeResolve(reads);
      if (index >= values.length) return { done: true, value: undefined };
      const value = values[index];
      index += 1;
      return { done: false, value };
    },
  };
}

function createBatchedAsyncIterator(values) {
  let index = 0;
  const requests = [];
  return {
    get requests() {
      return requests;
    },
    async next(maxChunks) {
      requests.push(maxChunks);
      if (index >= values.length) return { done: true, value: undefined };
      const size = Math.max(1, Math.trunc(Number(maxChunks) || 1));
      const batch = values.slice(index, index + size);
      index += batch.length;
      return { done: false, value: batch };
    },
  };
}

describe('readerEngine read orchestrator', () => {
  it('serializes overlapping lookahead pulls while allowing already loaded chunks through', async () => {
    let releaseBatch;
    const batch = new Promise(resolve => { releaseBatch = resolve; });
    const iterator = { next: vi.fn(() => batch) };
    const state = { iterator, chunks: [{ speech: 'ready' }], wordCounts: [1] };
    const orchestrator = createReadOrchestrator({ state });
    const first = orchestrator.fillChunkBuffer(1);
    const second = orchestrator.fillChunkBuffer(1);
    try {
      await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce());
      await expect(orchestrator.fillChunkBuffer(0)).resolves.toBe(true);
    } finally {
      releaseBatch({ value: { speech: 'later' }, done: false });
      await Promise.all([first, second]);
    }
    expect(iterator.next).toHaveBeenCalledOnce();
    expect(state.chunks.map(chunk => chunk.speech)).toEqual(['ready', 'later']);
  });

  it('loads a new read without waiting for a cancelled read and ignores its late text', async () => {
    let releaseBatch;
    const batch = new Promise(resolve => { releaseBatch = resolve; });
    const state = { iterator: { next: () => batch }, chunks: [], wordCounts: [] };
    const orchestrator = createReadOrchestrator({ state });
    const oldRead = orchestrator.fillChunkBuffer(0);
    await Promise.resolve();
    await Promise.resolve();
    state.iterator = createAsyncIterator([{ speech: 'fresh' }]);
    try {
      await expect(orchestrator.fillChunkBuffer(0)).resolves.toBe(true);
    } finally {
      releaseBatch({ value: { speech: 'stale' }, done: false });
      await oldRead;
    }
    expect(state.chunks.map(chunk => chunk.speech)).toEqual(['fresh']);
  });

  it('releases the required section as soon as it arrives during a longer lookahead fill', async () => {
    let releasePage;
    const page = new Promise(resolve => { releasePage = resolve; });
    const state = { chunks: [{ speech: 'first' }], wordCounts: [1], iterator: (async function* () {
      yield { speech: 'second' };
      await page;
      yield { speech: 'third' };
    })() };
    const orchestrator = createReadOrchestrator({ state });
    const ahead = orchestrator.fillChunkBuffer(2);
    let currentReady = false;
    const current = orchestrator.fillChunkBuffer(1).then(() => { currentReady = true; });
    try {
      await vi.waitFor(() => expect(currentReady).toBe(true));
      expect(state.chunks.map(chunk => chunk.speech)).toEqual(['first', 'second']);
    } finally {
      releasePage();
      await Promise.all([ahead, current]);
    }
  });

  it('fills a streaming chunk buffer through the requested target index', async () => {
    const chunks = [];
    const wordCounts = [];
    const iterator = createAsyncIterator([
      { speech: 'one two' },
      { speech: 'three four five' },
      { speech: 'six' },
    ]);
    const state = { iterator, chunks, wordCounts };

    await expect(fillStreamingChunkBuffer({
      state,
      targetIndex: 2,
      getChunkWordCount: (chunk) => chunk.speech.split(/\s+/).length,
    })).resolves.toBe(true);

    expect(chunks.map((chunk) => chunk.speech)).toEqual(['one two', 'three four five', 'six']);
    expect(wordCounts).toEqual([2, 3, 1]);
  });

  it('requests the whole remaining streaming deficit in one iterator call', async () => {
    const chunks = [];
    const wordCounts = [];
    const iterator = createBatchedAsyncIterator([
      { speech: 'one two' },
      { speech: 'three four five' },
      { speech: 'six' },
    ]);
    const state = { iterator, chunks, wordCounts };

    await expect(fillStreamingChunkBuffer({
      state,
      targetIndex: 2,
      getChunkWordCount: (chunk) => chunk.speech.split(/\s+/).length,
    })).resolves.toBe(true);

    expect(iterator.requests).toEqual([3]);
    expect(chunks.map((chunk) => chunk.speech)).toEqual(['one two', 'three four five', 'six']);
    expect(wordCounts).toEqual([2, 3, 1]);
  });

  it('stops a streaming chunk fill before reading an aborted run', async () => {
    const iterator = createAsyncIterator([{ speech: 'unread' }]);
    const state = { iterator, chunks: [], wordCounts: [] };

    await expect(fillStreamingChunkBuffer({
      state,
      targetIndex: 0,
      isStopped: () => true,
    })).resolves.toBe(false);

    expect(iterator.reads).toBe(0);
    expect(state.chunks).toEqual([]);
  });

  it('ignores stale iterator results when the active iterator changes while awaiting', async () => {
    let state;
    const oldIterator = createAsyncIterator([{ speech: 'stale result' }], {
      beforeResolve() {
        state.iterator = createAsyncIterator([{ speech: 'fresh result' }]);
      },
    });
    state = { iterator: oldIterator, chunks: [], wordCounts: [] };

    await expect(fillStreamingChunkBuffer({ state, targetIndex: 0 })).resolves.toBe(false);

    expect(state.chunks).toEqual([]);
  });

  it('reports loaded counts for fixed reads and projected totals for streaming reads', () => {
    expect(getPlaybackTotal({
      isStreaming: false,
      loadedCount: 4,
      currentIndex: 9,
    })).toBe(4);
    expect(getPlaybackTotal({
      isStreaming: true,
      hasIterator: true,
      loadedCount: 3,
      currentIndex: 9,
    })).toBe(10);
  });

  it('releases read buffers after stopped, explicit release, or natural finish', () => {
    expect(resolveReadCleanupDisposition({
      stoppedRun: true,
      releaseReadSessionAfterCleanup: false,
      readingState: 'reading',
    })).toEqual({ releaseBuffers: true, resetState: true });

    expect(resolveReadCleanupDisposition({
      stoppedRun: false,
      releaseReadSessionAfterCleanup: true,
      readingState: 'paused',
    })).toEqual({ releaseBuffers: true, resetState: true });

    expect(resolveReadCleanupDisposition({
      stoppedRun: false,
      releaseReadSessionAfterCleanup: false,
      readingState: 'finished',
    })).toEqual({ releaseBuffers: true, resetState: false });
  });

  it('prompts for saved resume only for non-selection non-top fixed reads', () => {
    expect(resolveInitialReadPosition({
      savedChunkIndex: 7,
      resumeConfirmed: false,
      isSelectionRead: false,
      isStreaming: false,
      shouldUseTopStart: false,
    })).toEqual({ action: 'promptResume', index: 7 });

    expect(resolveInitialReadPosition({
      savedChunkIndex: 7,
      resumeConfirmed: true,
      isSelectionRead: false,
      isStreaming: false,
      shouldUseTopStart: false,
    })).toEqual({ action: 'startAtIndex', index: 7 });

    expect(resolveInitialReadPosition({
      savedChunkIndex: 7,
      resumeConfirmed: false,
      isSelectionRead: true,
      isStreaming: false,
      shouldUseTopStart: false,
    })).toEqual({ action: 'startAtIndex', index: 0 });
  });

  it('creates an injected read orchestrator that owns streaming queue state', async () => {
    const iterator = createAsyncIterator([
      { speech: 'first loaded' },
      { speech: 'second loaded' },
    ]);
    const state = {
      iterator,
      chunks: [],
      wordCounts: [],
      isStreaming: true,
    };

    const orchestrator = createReadOrchestrator({
      state,
      getChunkWordCount: (chunk) => chunk.speech.split(/\s+/).length,
      getChunkSpeechText: (chunk) => chunk.speech,
    });

    await expect(orchestrator.fillChunkBuffer(1)).resolves.toBe(true);

    expect(state.chunks.map((chunk) => chunk.speech)).toEqual(['first loaded', 'second loaded']);
    expect(state.wordCounts).toEqual([2, 2]);
    expect(orchestrator.getLoadedChunkText()).toBe('first loaded second loaded');
    expect(orchestrator.getPlaybackTotal(4)).toBe(5);
  });

  it('resets its queue state when the toolbar-player session is cleared', () => {
    const state = {
      iterator: createAsyncIterator([]),
      chunks: [{ speech: 'stale' }],
      wordCounts: [1],
    };
    const orchestrator = createReadOrchestrator({ state });

    orchestrator.reset();

    expect(state.chunks).toEqual([]);
    expect(state.wordCounts).toEqual([]);
    expect(state.iterator).toBeNull();
  });

  it('keeps readerEngine wired through createReadOrchestrator instead of local queue helpers', () => {
    const readerEngine = [
      readFileSync(new URL('../../src/app/reader-engine/reader-engine-runtime.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/platform/chrome/reader-engine-chrome-adapter.js', import.meta.url), 'utf8'),
    ].join('\n');

    expect(readerEngine).toContain('createReadOrchestrator');
    expect(readerEngine).not.toContain('async function fillActiveChunkBuffer');
    expect(readerEngine).not.toContain('function getPlaybackTotal(');
    expect(readerEngine).not.toContain('function getLoadedChunkText(');
  });
});

describe('readerEngine start position buffering', () => {
  const findByText = (chunks, text) => chunks.findIndex((chunk) => String(chunk?.speech || '').includes(text));
  const createChatChunks = () => Array.from({ length: 200 }, (_, index) => ({
    speech: index % 10 === 0 ? 'You said: continue please.' : `Answer section ${index}.`,
    anchorId: `block-${index}`,
  }));

  it('loads batches until an anchored start far down the page is buffered', async () => {
    const iterator = createBatchedAsyncIterator(createChatChunks());
    const state = { chunks: [], wordCounts: [], iterator };
    const orchestrator = createReadOrchestrator({ state, findStartChunkIndexByText: findByText });

    await orchestrator.fillStartPositionBuffer(
      { anchorId: 'block-150', text: 'You said: continue please.' },
      { maxExtraChunks: 5000, batchSize: 32 },
    );

    expect(state.chunks.map((chunk) => chunk.anchorId)).toContain('block-150');
    expect(state.chunks.length).toBeLessThan(200);
    expect(iterator.requests.every((count) => count <= 32)).toBe(true);
    expect(iterator.requests.length).toBeLessThanOrEqual(6);
  });

  it('ignores text hits on chunks anchored to a different block', async () => {
    const state = { chunks: [], wordCounts: [], iterator: createBatchedAsyncIterator(createChatChunks()) };
    const orchestrator = createReadOrchestrator({ state, findStartChunkIndexByText: findByText });

    await orchestrator.fillStartPositionBuffer(
      { anchorId: 'block-90', text: 'You said: continue please.' },
      { maxExtraChunks: 5000 },
    );

    expect(state.chunks.at(-1).anchorId).toBe('block-90');
  });

  it('keeps loading until every split chunk of the anchored block is buffered', async () => {
    const chunks = [
      { speech: 'Intro.', anchorId: 'a' },
      { speech: 'Long answer part one.', anchorId: 'b' },
      { speech: 'Long answer part two.', anchorId: 'b' },
      { speech: 'Next block.', anchorId: 'c' },
      { speech: 'Tail.', anchorId: 'd' },
    ];
    const state = { chunks: [], wordCounts: [], iterator: createAsyncIterator(chunks) };
    const orchestrator = createReadOrchestrator({ state, findStartChunkIndexByText: findByText });

    await orchestrator.fillStartPositionBuffer({ anchorId: 'b' }, { maxExtraChunks: 5000 });

    expect(state.chunks.map((chunk) => chunk.speech)).toEqual([
      'Intro.',
      'Long answer part one.',
      'Long answer part two.',
      'Next block.',
    ]);
  });

  it('still stops at the extra-chunk cap when the start never appears', async () => {
    const state = { chunks: [], wordCounts: [], iterator: createBatchedAsyncIterator(createChatChunks()) };
    const orchestrator = createReadOrchestrator({ state, findStartChunkIndexByText: findByText });

    await orchestrator.fillStartPositionBuffer({ text: 'This text never appears anywhere.' }, { maxExtraChunks: 2 });

    expect(state.chunks.length).toBe(2);
  });
});
