import { describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';

const sampleText = 'PageNarrator is an on-device reader for Chrome. It enables fast natural speech without remote servers. Users enjoy private reading directly on page.';

describe('shipped reader chunking defaults', () => {
  it('bounds the first article chunk without changing text or word order', async () => {
    const state = {};
    const record = vi.fn();
    const play = vi.fn();
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createReadRunTracker(),
      flowRecorder: { record },
      extractActiveTab: async () => ({ text: sampleText, tabId: 1 }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 480, targetMinLength: 260, preloadAhead: 2 }),
      resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro' }),
      playKokoroSpeech: play,
    });
    await orchestrator.readPage();
    expect(state.activeChunks[0]).toBe('PageNarrator is an on-device reader for Chrome. It enables fast natural speech without remote servers.');
    expect(state.activeChunks[0].length).toBeLessThanOrEqual(120);
    expect(state.activeChunks.join(' ')).toBe(sampleText);
    expect(play).toHaveBeenCalledTimes(state.activeChunks.length);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chunks_extracted', streaming: false }));
  });

  it.each([false, true])('keeps streamed chunks and profile buffer depth, abort=%s', async (abort) => {
    const state = {};
    const readRunTracker = createReadRunTracker();
    const chunk = { text: sampleText, pageNumber: 1 };
    const play = vi.fn();
    const ensureModel = vi.fn();
    const close = vi.fn();
    const fill = vi.fn(async () => {
      if (abort) readRunTracker.abortCurrentRun();
      else state.activeChunks = [chunk];
      return true;
    });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker,
      readOrchestrator: { fillChunkBuffer: fill, fillStartPositionBuffer: async () => {}, getPlaybackTotal: () => 1, getLoadedChunkText: () => sampleText },
      extractActiveTab: async () => ({
        source: 'pdf', tabId: 1, text: sampleText,
        chunkStream: { [Symbol.asyncIterator]: () => ({ return: close }) },
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 480, targetMinLength: 260, preloadAhead: 3 }),
      resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro' }),
      ensureModel,
      playKokoroSpeech: play,
    });
    await orchestrator.readPage();
    expect(fill).toHaveBeenNthCalledWith(1, 3, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    if (abort) {
      expect(fill.mock.calls[0][1].signal.aborted).toBe(true);
      expect(play).not.toHaveBeenCalled();
      expect(ensureModel).not.toHaveBeenCalled();
    } else {
      expect(state.activeChunks).toEqual([chunk]);
      expect(play).toHaveBeenCalledOnce();
      expect(play.mock.calls[0][1]).toBe(chunk);
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
