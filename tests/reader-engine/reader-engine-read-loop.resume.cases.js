import {createRunTracker, createStreamingReadOrchestrator, createChunkStream} from './reader-engine-read-loop.fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';

import { getSavedResumeChunk } from '../../src/lib/resume-position.js';

describe('readerEngine read loop', () => {
  let systemSpeech;

  beforeEach(() => {
    systemSpeech = Object.fromEntries(['getVoices', 'speak', 'cancel', 'pause', 'resume']
      .map((method) => [method, vi.spyOn(globalThis.speechSynthesis, method)]));
  });

  afterEach(() => {
    for (const method of Object.values(systemSpeech)) expect(method).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('flashes the resumed section before continuing playback', async () => {
    const flashes = [];
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 2,
        getLoadedChunkText: () => 'First section. Second section.',
      },
      setReadingState: () => {},
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 4,
        url: 'https://example.test/resume',
        title: 'Resume',
        source: 'article',
        text: 'First section. Second section.',
        chunks: [
          { speech: 'First section.', anchorId: 'first' },
          { speech: 'Second section.', anchorId: 'second' },
        ],
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      shouldSyncPageHighlights: () => true,
      flashResumeSection: async (tabId, chunk) => flashes.push({ tabId, chunk }),
      highlightChunk: async () => ({ ok: true }),
      loadSavedResumePosition: async () => ({ chunk: 1 }),
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage({ resumeConfirmed: true });

    expect(flashes).toHaveLength(1);
    expect(flashes[0]).toMatchObject({
      tabId: 4,
      chunk: { speech: 'Second section.', anchorId: 'second' },
    });
  });

  it('uses the injected suppressor when resumed section flashing fails', async () => {
    const flashError = new Error('resume flash failed');
    const suppressError = vi.fn();
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 2,
        getLoadedChunkText: () => 'First section. Second section.',
      },
      setReadingState: () => {},
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 4,
        url: 'https://example.test/resume',
        title: 'Resume',
        source: 'article',
        text: 'First section. Second section.',
        chunks: [
          { speech: 'First section.', anchorId: 'first' },
          { speech: 'Second section.', anchorId: 'second' },
        ],
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      shouldSyncPageHighlights: () => true,
      flashResumeSection: async () => { throw flashError; },
      highlightChunk: async () => ({ ok: true }),
      loadSavedResumePosition: async () => ({ chunk: 1 }),
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
      suppressError,
    });

    await orchestrator.readPage({ resumeConfirmed: true });

    expect(suppressError).toHaveBeenCalledWith(flashError);
  });

  it('preloads streamed HTML chunks before prompting for a saved resume', async () => {
    const state = { testSilentTtsEnabled: true };
    const resume = {
      chunk: 5,
      totalChunks: 6,
      progressPercent: 83,
      excerpt: 'Sixth streamed section.',
      title: 'Streamed',
      ts: 1700000000000,
    };
    const resumePrompts = [];
    const loadSavedResumePosition = vi.fn(async (_url, chunks, options = {}) => {
      if (options.allowUnverified && chunks.length <= 1) return resume;
      return chunks.some((chunk) => chunk.speech === resume.excerpt) ? resume : null;
    });

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: createStreamingReadOrchestrator(state),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/streamed',
        title: 'Streamed',
        source: 'reading-model',
        text: '',
        chunks: [],
        streaming: true,
        chunkStream: (async function* streamChunks() {
          yield { speech: 'First streamed section.' };
          yield { speech: 'Second streamed section.' };
          yield { speech: 'Third streamed section.' };
          yield { speech: 'Fourth streamed section.' };
          yield { speech: 'Fifth streamed section.' };
          yield { speech: 'Sixth streamed section.' };
        })(),
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 2 }),
      loadSavedResumePosition,
      renderResumePrompt: (prompt) => resumePrompts.push(prompt),
      setReadingState: () => {},
      waitBetweenSections: async () => {},
    });

    await orchestrator.readPage();

    expect(loadSavedResumePosition).toHaveBeenNthCalledWith(
      1,
      'https://example.test/streamed',
      [],
      { allowUnverified: true },
    );
    expect(loadSavedResumePosition).toHaveBeenNthCalledWith(
      2,
      'https://example.test/streamed',
      [
        { speech: 'First streamed section.' },
        { speech: 'Second streamed section.' },
        { speech: 'Third streamed section.' },
        { speech: 'Fourth streamed section.' },
        { speech: 'Fifth streamed section.' },
        { speech: 'Sixth streamed section.' },
      ],
    );
    expect(resumePrompts.at(-1)).toEqual(resume);
    expect(systemSpeech.speak).not.toHaveBeenCalled();
    expect(state.activeChunks.map((chunk) => chunk.speech)).toEqual([
      'First streamed section.',
      'Second streamed section.',
      'Third streamed section.',
      'Fourth streamed section.',
      'Fifth streamed section.',
      'Sixth streamed section.',
    ]);
  });

  describe('saved positions and a scrolled PDF start page', () => {
    function createPdfPageChunk(pageNumber, part = 1) {
      return {
        speech: `Marker page ${pageNumber} part ${part} reads a complete sentence for narration.`,
        pageNumber,
        anchorId: `pdf-page-${pageNumber}`,
        domWordOffset: 0,
      };
    }

    // Mirrors the storage-backed loader: unverified lookups return the raw record and
    // verification uses the production matcher, including its raw-index fallback.
    function createSavedPositionLoader(saved) {
      return vi.fn(async (_url, chunks = [], options = {}) => {
        if (chunks.length <= 1) return options.allowUnverified ? saved : null;
        const chunk = getSavedResumeChunk(saved, chunks);
        return chunk > 0 ? { ...saved, chunk } : options.allowUnverified ? saved : null;
      });
    }

    async function readPdfFromPage({ startPage, chunks, saved, startMode = 'viewport' }) {
      const state = { testSilentTtsEnabled: false };
      const spoken = [];
      const loadSavedResumePosition = createSavedPositionLoader(saved);
      const orchestrator = createReadLoopOrchestrator({
        state,
        readRunTracker: createRunTracker(),
        readOrchestrator: createStreamingReadOrchestrator(state),
        refreshPanelTargetTab: async () => {},
        warmActiveTabContentScriptAccess: async () => {},
        prepareTtsBackendPlanForChunking: async () => {},
        extractActiveTab: async () => ({
          tabId: 7,
          url: 'https://example.test/book.pdf',
          title: 'Book',
          source: 'pdf',
          text: '',
          chunks: [],
          streaming: true,
          pageCount: 12,
          chunkStream: createChunkStream(chunks),
          ...(startPage > 1 ? {
            startPosition: { source: 'page', pageNumber: startPage, anchorId: `pdf-page-${startPage}` },
          } : {}),
        }),
        getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1 }),
        loadSavedResumePosition,
        populateVoices: async () => {},
        renderLanguageStatus: async () => {},
        resolveSelectedVoice: () => ({
          id: 'af_heart',
          engine: 'kokoro',
          lang: 'en-US',
          detectCode: 'en',
        }),
        playKokoroSpeech: async (_speech, chunk) => {
          spoken.push(chunk);
        },
        waitBetweenSections: async () => {
          if (spoken.length) throw new Error('stop after first section');
        },
        waitForReadPause: async () => {},
        saveResumeChunk: async () => {},
        refreshQuota: async () => {},
        queuePostPlaybackBookkeeping: () => {},
      });

      // The toolbar popup always starts with resumeConfirmed, so a saved position applies silently.
      await orchestrator.readPage({ startMode, resumeConfirmed: true });
      return { firstSpoken: spoken[0], loadSavedResumePosition };
    }

    const pageNineOnward = [9, 10, 11, 12].map((pageNumber) => createPdfPageChunk(pageNumber));

    it('starts on the scrolled page instead of replaying a saved chunk index from another page', async () => {
      const savedOnPageThree = {
        chunk: 2,
        totalChunks: 7,
        pageNumber: 3,
        anchorId: 'pdf-page-3',
        excerpt: createPdfPageChunk(3).speech,
        source: 'pdf',
      };

      const { firstSpoken } = await readPdfFromPage({ startPage: 9, chunks: pageNineOnward, saved: savedOnPageThree });

      expect(firstSpoken).toMatchObject({ pageNumber: 9 });
    });

    it('does not jump ahead to a later saved page when the reader scrolled back', async () => {
      const savedOnPageEleven = {
        chunk: 10,
        totalChunks: 14,
        pageNumber: 11,
        anchorId: 'pdf-page-11',
        excerpt: createPdfPageChunk(11).speech,
        source: 'pdf',
      };

      const { firstSpoken } = await readPdfFromPage({ startPage: 9, chunks: pageNineOnward, saved: savedOnPageEleven });

      expect(firstSpoken).toMatchObject({ pageNumber: 9 });
    });

    it('resumes mid-page when the saved position is on the scrolled page', async () => {
      const chunks = [
        createPdfPageChunk(9, 1),
        createPdfPageChunk(9, 2),
        createPdfPageChunk(9, 3),
        createPdfPageChunk(10, 1),
      ];
      const savedMidPageNine = {
        chunk: 12,
        totalChunks: 20,
        pageNumber: 9,
        anchorId: 'pdf-page-9',
        excerpt: createPdfPageChunk(9, 3).speech,
        source: 'pdf',
      };

      const { firstSpoken } = await readPdfFromPage({ startPage: 9, chunks, saved: savedMidPageNine });

      expect(firstSpoken).toEqual(createPdfPageChunk(9, 3));
    });

    it('keeps resuming a saved page when the PDF read starts from page 1', async () => {
      const chunks = [1, 2, 3, 4, 5].map((pageNumber) => createPdfPageChunk(pageNumber));
      const savedOnPageThree = {
        chunk: 2,
        totalChunks: 5,
        pageNumber: 3,
        anchorId: 'pdf-page-3',
        excerpt: createPdfPageChunk(3).speech,
        source: 'pdf',
      };

      const { firstSpoken } = await readPdfFromPage({ startPage: 1, chunks, saved: savedOnPageThree });

      expect(firstSpoken).toMatchObject({ pageNumber: 3 });
    });

    it('ignores saved positions when restarting a finished read', async () => {
      const chunks = [1, 2, 3, 4, 5].map((pageNumber) => createPdfPageChunk(pageNumber));
      const savedOnPageThree = {
        chunk: 2,
        totalChunks: 5,
        pageNumber: 3,
        anchorId: 'pdf-page-3',
        excerpt: createPdfPageChunk(3).speech,
        source: 'pdf',
      };

      const { firstSpoken, loadSavedResumePosition } = await readPdfFromPage({
        startPage: 1,
        chunks,
        saved: savedOnPageThree,
        startMode: 'restart',
      });

      expect(firstSpoken).toMatchObject({ pageNumber: 1 });
      expect(loadSavedResumePosition).not.toHaveBeenCalled();
    });
  });

  it('caps streamed start-position scanning when the anchor never matches', async () => {
    const state = {};
    const spoken = [];
    const loadedAtFirstSpeech = [];

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: createStreamingReadOrchestrator(state),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/capped-start',
        title: 'Capped start',
        source: 'reading-model',
        text: '',
        chunks: [],
        streaming: true,
        startPosition: {
          source: 'viewport',
          text: 'This anchor never appears in the stream.',
        },
        chunkStream: (async function* streamChunks() {
          for (let index = 0; index < 100; index += 1) {
            yield { speech: `Section ${index} visible.` };
          }
        })(),
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      getProfileMinimumAhead: () => 2,
      loadSavedResumePosition: async () => null,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      playKokoroSpeech: async (_speech, chunk) => {
        if (!loadedAtFirstSpeech.length) loadedAtFirstSpeech.push(state.activeChunks.length);
        spoken.push(chunk.speech);
      },
      waitBetweenSections: async (index) => {
        if (index > 0) throw new Error('stop after first section');
      },
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(loadedAtFirstSpeech[0]).toBe(3);
    expect(spoken[0]).toBe('Section 0 visible.');
  });

  it('scans a streamed page to an anchored start far below the preload window', async () => {
    const state = {};
    const spoken = [];
    const repeatedLabel = 'ChatGPT said: here is the answer.';

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: createStreamingReadOrchestrator(state),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://chatgpt.com/c/long-chat',
        title: 'Long chat',
        source: 'reading-model',
        text: '',
        chunks: [],
        streaming: true,
        startPosition: {
          source: 'chat-turn',
          anchorId: 'turn-80',
          text: repeatedLabel,
        },
        chunkStream: (async function* streamChunks() {
          for (let index = 0; index < 100; index += 1) {
            yield { speech: index % 20 === 0 ? repeatedLabel : `Section ${index} visible.`, anchorId: `turn-${index}` };
          }
        })(),
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      getProfileMinimumAhead: () => 2,
      loadSavedResumePosition: async () => null,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      playKokoroSpeech: async (_speech, chunk) => {
        spoken.push(chunk.anchorId);
      },
      waitBetweenSections: async () => {
        if (spoken.length) throw new Error('stop after first section');
      },
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(spoken[0]).toBe('turn-80');
    expect(state.activeChunks.length).toBeLessThan(100);
  });

  it('saves resume positions while streamed HTML playback advances', async () => {
    const state = {};
    const saved = [];

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: createStreamingReadOrchestrator(state),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/streamed-save',
        title: 'Streamed save',
        source: 'reading-model',
        text: '',
        chunks: [],
        streaming: true,
        chunkStream: (async function* streamChunks() {
          yield { speech: 'First streamed section.' };
          yield { speech: 'Second streamed section.' };
        })(),
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      loadSavedResumePosition: async () => null,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      playKokoroSpeech: async () => {},
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async (article, chunk, total) => saved.push({ article, chunk, total }),
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: (task) => saved.push({ taskQueued: Boolean(task?.then) }),
    });

    await orchestrator.readPage();

    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        article: expect.objectContaining({ url: 'https://example.test/streamed-save' }),
        chunk: 1,
        total: 2,
      }),
      { taskQueued: true },
    ]));
  });
});
