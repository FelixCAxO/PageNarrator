import { createReadOrchestrator } from '../../src/lib/core/reader-engine-read-orchestrator.js';

export function createRunTracker() {
  return {
    beginRun: () => 1,
    getRunSignal: () => ({ aborted: false }),
    isCurrentRun: () => true,
  };
}

export function createStreamingReadOrchestrator(state) {
  const queueState = {
    get iterator() { return state.activeChunkIterator; },
    set iterator(value) { state.activeChunkIterator = value; },
    get chunks() { return state.activeChunks; },
    set chunks(value) { state.activeChunks = value; },
    get wordCounts() { return state.activeChunkWordCounts; },
    set wordCounts(value) { state.activeChunkWordCounts = value; },
    get isStreaming() { return Boolean(state.activeChunkIterator); },
    get articleSource() { return state.activeArticleSource; },
  };
  return createReadOrchestrator({
    state: queueState,
    getChunkSpeechText: (chunk) => chunk?.speech || chunk?.text || '',
    findStartChunkIndexByText: (chunks, text) => chunks.findIndex((chunk) => (
      String(chunk?.speech || chunk?.text || '').includes(text)
    )),
  });
}

export function createChunkStream(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(count = 1) {
          if (index >= chunks.length) return { done: true, value: undefined };
          const take = Math.max(1, Math.trunc(Number(count) || 1));
          const value = chunks.slice(index, index + take);
          index += value.length;
          return { done: false, value };
        },
        async return() {
          index = chunks.length;
          return { done: true, value: undefined };
        },
      };
    },
  };
}
