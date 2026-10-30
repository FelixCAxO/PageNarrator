import { expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';
import { createStreamingReadOrchestrator } from './reader-engine-read-loop.fixtures.js';

it.each(['kokoro', 'omnivoice'])('plays buffered %s speech while a later PDF page is still extracting', async engine => {
  const state = {};
  const chunks = Array.from({ length: 4 }, (_, index) => ({ speech: `PDF section ${index + 1}.`, pageNumber: index + 1 }));
  let releasePage;
  const laterPage = new Promise(resolve => { releasePage = resolve; });
  const play = vi.fn(async (_speech, _chunk, options) => { options.onAudioStart(); });
  const orchestrator = createReadLoopOrchestrator({
    state,
    readRunTracker: createReadRunTracker(),
    readOrchestrator: createStreamingReadOrchestrator(state),
    extractActiveTab: async () => ({ tabId: 2, source: 'pdf', text: chunks[0].speech,
      chunkStream: (async function* () {
        yield chunks.slice(0, 3);
        await laterPage;
        yield chunks[3];
      })(),
    }),
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 320, targetMinLength: 180, preloadAhead: 2 }),
    resolveSelectedVoice: () => ({ id: engine, engine, lang: 'en', detectCode: 'en' }),
    ensureSpeechPreloadWindow({ speechPreloads, currentIndex }) {
      state.activeChunks.forEach((chunk, index) => {
        if (!speechPreloads.has(index)) speechPreloads.set(index, Promise.resolve({ result: chunk }));
      });
      return speechPreloads.get(currentIndex);
    },
    readPreloadedSpeech: async preload => (await preload).result,
    playKokoroSpeech: play,
  });
  const reading = orchestrator.readPage({ startMode: 'top' });
  try {
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(3));
  } finally {
    releasePage();
    await reading;
  }
  expect(play.mock.calls.map(([, chunk]) => chunk.speech)).toEqual(chunks.map(chunk => chunk.speech));
});

it('starts ready speech while the source tab delays its highlight reply', async () => {
  let releaseHighlight;
  const highlighted = new Promise(resolve => { releaseHighlight = resolve; });
  const play = vi.fn(async () => {});
  const orchestrator = createReadLoopOrchestrator({
    state: {},
    readRunTracker: createReadRunTracker(),
    extractActiveTab: async () => ({ tabId: 2, source: 'selection', text: 'A ready sentence.' }),
    resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro', detectCode: 'en' }),
    shouldSyncPageHighlights: () => true,
    highlightChunk: () => highlighted,
    playKokoroSpeech: play,
  });
  const reading = orchestrator.readPage({ readSelection: true });
  try {
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  } finally {
    releaseHighlight({ ok: true });
    await reading;
  }
});
