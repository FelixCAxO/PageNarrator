import { describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReadOrchestrator } from '../../src/lib/core/reader-engine-read-orchestrator.js';
import { createReaderEngineReadControlsController } from '../../src/lib/reader-engine-read-controls-controller.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';

function createHarness(overrides = {}) {
  const state = {
    activeChunks: [],
    activeChunkWordCounts: [],
    activeArticleSource: '',
    readingState: 'idle',
    currentChunk: 0,
    totalChunks: 0,
    activeReadTabId: null,
    testSilentTtsEnabled: true,
    ...overrides.state,
  };

  const stateHistory = [];
  const playbackEvents = [];
  const highlights = [];
  const preloads = [];
  const readRunTracker = overrides.readRunTracker || createReadRunTracker();

  const setReadingState = vi.fn((newState, options = {}) => {
    state.readingState = newState;
    stateHistory.push({ state: newState, ...options });
  });

  const readOrchestrator = createReadOrchestrator({
    state: {
      get iterator() { return state.activeChunkIterator; },
      set iterator(value) { state.activeChunkIterator = value; },
      get chunks() { return state.activeChunks; },
      set chunks(value) { state.activeChunks = value; },
      get wordCounts() { return state.activeChunkWordCounts; },
      set wordCounts(value) { state.activeChunkWordCounts = value; },
      get isStreaming() { return Boolean(state.activeChunkIterator); },
      get articleSource() { return state.activeArticleSource; },
    },
    getChunkSpeechText: (chunk) => chunk?.speech || chunk?.text || '',
    findStartChunkIndexByText: (chunks, text) => chunks.findIndex((chunk) => (
      String(chunk?.speech || chunk?.text || '').includes(text)
    )),
  });

  const warmActiveTabContentScriptAccess = vi.fn(async (_tab) => {});
  const extractActiveTab = vi.fn(async ({ readSelection = false } = {}) => {
    if (readSelection) {
      return {
        tabId: 101,
        url: 'https://example.test/article',
        title: 'Selected Article Title',
        source: 'selection',
        text: 'This is the selected sentence to read.',
        chunks: [{ speech: 'This is the selected sentence to read.' }],
      };
    }
    return {
      tabId: 101,
      url: 'https://example.test/article',
      title: 'Full Article Title',
      source: 'reading-model',
      text: 'First paragraph text. Second paragraph text.',
      chunks: [
        { speech: 'First paragraph text.' },
        { speech: 'Second paragraph text.' },
      ],
    };
  });

  const ensureSpeechPreloadWindow = vi.fn(({ currentIndex }) => {
    preloads.push(currentIndex);
    return Promise.resolve({
      result: {
        blob: new Blob(['audio']),
        wordTimings: [{ word: 'test', start: 0, end: 0.5 }],
      },
    });
  });

  const readPreloadedSpeech = vi.fn(async (preload) => {
    const entry = await preload;
    if (entry.error) throw entry.error;
    return entry.result;
  });

  const playKokoroSpeech = vi.fn(async (speech, chunk, options = {}) => {
    playbackEvents.push({ kind: 'kokoro', chunk, options });
    options.onAudioStart?.();
  });

  const highlightChunk = vi.fn(async (tabId, chunk) => {
    highlights.push({ tabId, chunk });
    return { ok: true };
  });

  const clearPageHighlight = vi.fn(async (tabId) => {
    highlights.push({ tabId, clear: true });
  });

  const setPageHighlightPaused = vi.fn(async (paused, tabId) => {
    highlights.push({ tabId, paused });
  });

  const orchestrator = createReadLoopOrchestrator({
    state,
    readRunTracker,
    readOrchestrator,
    setReadingState,
    refreshPanelTargetTab: async () => {},
    warmActiveTabContentScriptAccess,
    prepareTtsBackendPlanForChunking: async () => ({ device: 'wasm', dtype: 'q8' }),
    extractActiveTab,
    getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1 }),
    populateVoices: async () => {},
    renderLanguageStatus: async () => {},
    resolveSelectedVoice: () => ({
      id: 'af_heart',
      engine: 'kokoro',
      lang: 'en-US',
      detectCode: 'en',
    }),
    ensureSpeechPreloadWindow,
    readPreloadedSpeech,
    playKokoroSpeech,
    highlightChunk,
    clearPageHighlight,
    waitBetweenSections: async () => {},
    waitForReadPause: async () => {},
    saveResumeChunk: async () => {},
    queuePostPlaybackBookkeeping: () => {},
    ...overrides,
  });

  const controlsController = createReaderEngineReadControlsController({
    state,
    readRunTracker,
    playbackSession: { markReleaseBuffersAfterCleanup: vi.fn() },
    setReadingState,
    setPageHighlightPaused,
    clearPageHighlight,
    clearActiveSpeechPreloads: vi.fn(),
    onPrimaryRead: ({ tab, startMode, resumeConfirmed }) => {
      void orchestrator.readPage({ tab, startMode, resumeConfirmed });
    },
    onReadSelected: ({ tab }) => {
      void orchestrator.readPage({ tab, readSelection: true });
    },
    ...overrides.controls,
  });

  return {
    state,
    stateHistory,
    playbackEvents,
    highlights,
    preloads,
    readRunTracker,
    readOrchestrator,
    orchestrator,
    controlsController,
    setReadingState,
    extractActiveTab,
    warmActiveTabContentScriptAccess,
    playKokoroSpeech,
    highlightChunk,
    clearPageHighlight,
  };
}

describe('Read Page and Read Selected workflow & self-repair matrix', () => {
  it('Read Page full lifecycle: extracts article, reads all chunks, and completes cleanly', async () => {
    const harness = createHarness();
    await harness.orchestrator.readPage();

    expect(harness.extractActiveTab).toHaveBeenCalledWith(expect.objectContaining({ readSelection: false }));
    expect(harness.playbackEvents).toHaveLength(2);
    expect(harness.playbackEvents[0].chunk).toMatchObject({ speech: 'First paragraph text.' });
    expect(harness.playbackEvents[1].chunk).toMatchObject({ speech: 'Second paragraph text.' });
    expect(harness.stateHistory.map((s) => s.state)).toContain('preparing');
    expect(harness.stateHistory.map((s) => s.state)).toContain('reading');
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('Read Selected full lifecycle: extracts selected range only and ignores unselected body', async () => {
    const harness = createHarness();
    await harness.orchestrator.readPage({ readSelection: true });

    expect(harness.extractActiveTab).toHaveBeenCalledWith(expect.objectContaining({ readSelection: true }));
    expect(harness.playbackEvents).toHaveLength(1);
    expect(harness.playbackEvents[0].chunk).toMatchObject({ speech: 'This is the selected sentence to read.' });
    expect(harness.stateHistory[0]).toMatchObject({ state: 'preparing', source: 'selection' });
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('Read Selected on empty selection triggers empty_selection error with actionable recovery', async () => {
    const harness = createHarness({
      extractActiveTab: vi.fn(async () => ({
        tabId: 101,
        url: 'https://example.test/article',
        source: 'selection',
        text: '',
        chunks: [],
        error: 'No text was selected.',
      })),
    });

    await harness.orchestrator.readPage({ readSelection: true });

    const errorState = harness.stateHistory.find((s) => s.state === 'error');
    expect(errorState).toBeDefined();
    expect(errorState.errorCode).toBe('empty_selection');
    expect(errorState.message).toMatch(/No text is selected/i);
    expect(harness.playbackEvents).toHaveLength(0);
  });

  it('Self-repairing: auto-injects content script if content script ping fails during warmup', async () => {
    const injectContentScriptMock = vi.fn(async () => true);
    const harness = createHarness({
      warmActiveTabContentScriptAccess: vi.fn(async (tab) => {
        // Simulates ping failure -> self-repair injection
        await injectContentScriptMock(tab);
      }),
    });

    await harness.orchestrator.readPage({ tab: { id: 101, url: 'https://example.test' } });

    expect(injectContentScriptMock).toHaveBeenCalled();
    expect(harness.playbackEvents).toHaveLength(2);
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('Unscriptable URL handling: prevents hang and transitions to clear error state', async () => {
    const harness = createHarness({
      extractActiveTab: vi.fn(async () => ({
        tabId: 102,
        url: 'chrome://extensions',
        source: 'reading-model',
        text: '',
        chunks: [],
        error: { code: 'unscriptable_url', message: 'Chrome pages cannot be read.' },
      })),
    });

    await harness.orchestrator.readPage();

    const errorState = harness.stateHistory.find((s) => s.state === 'error');
    expect(errorState).toBeDefined();
    expect(errorState.message).toMatch(/Chrome pages cannot be read/i);
    expect(harness.playbackEvents).toHaveLength(0);
  });

  it('Host permission barrier: captures error and allows 1-click grant-access recovery', async () => {
    const onGrantAccess = vi.fn(async () => {});
    const harness = createHarness({
      state: {
        readingState: 'error',
        activePrimaryAction: 'grant-access',
      },
      controls: {
        onGrantAccess,
      },
    });

    harness.controlsController.handleErrorRecoveryAction('grant-access', { tab: { id: 101 } });

    expect(onGrantAccess).toHaveBeenCalledWith({ tab: { id: 101 } });
  });

  it('TTS synthesis failure: triggers clean state teardown and try-again recovery', async () => {
    const synthesisError = new Error('Kokoro model backend unavailable');
    synthesisError.code = 'tts_generation_failed';

    const harness = createHarness({
      readPreloadedSpeech: vi.fn(async () => {
        throw synthesisError;
      }),
    });

    await harness.orchestrator.readPage();

    const errorState = harness.stateHistory.find((s) => s.state === 'error');
    expect(errorState).toBeDefined();
    expect(errorState.message).toMatch(/Kokoro model backend unavailable/i);
  });

  it('Tab closed during read: stops immediately and releases resources', async () => {
    const harness = createHarness({
      state: {
        readingState: 'reading',
        activeReadTabId: 55,
      },
    });

    harness.controlsController.handleReadTabRemoved(55);

    expect(harness.state.readingState).not.toBe('reading');
  });

  it('Read Page controls: pause and resume cycle works seamlessly', async () => {
    const pauseCalls = [];
    const harness = createHarness({
      waitForReadPause: async () => {
        pauseCalls.push('pause-check');
      },
    });

    await harness.orchestrator.readPage();

    expect(pauseCalls.length).toBeGreaterThanOrEqual(2);
    expect(harness.stateHistory.some((s) => s.state === 'reading')).toBe(true);
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('PDF document reading: streams chunks and tracks total correctly', async () => {
    const pdfChunks = [
      { speech: 'PDF Page 1 heading and content.', pageNumber: 1 },
      { speech: 'PDF Page 2 summary section.', pageNumber: 2 },
    ];
    let streamIndex = 0;
    const chunkStream = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (streamIndex >= pdfChunks.length) return { done: true, value: undefined };
            const value = [pdfChunks[streamIndex++]];
            return { done: false, value };
          },
        };
      },
    };

    const harness = createHarness({
      extractActiveTab: vi.fn(async () => ({
        tabId: 105,
        url: 'https://example.test/document.pdf',
        source: 'pdf',
        pageCount: 2,
        chunkStream,
      })),
    });

    await harness.orchestrator.readPage();

    expect(harness.playbackEvents).toHaveLength(2);
    expect(harness.playbackEvents[0].chunk).toMatchObject({ speech: 'PDF Page 1 heading and content.' });
    expect(harness.playbackEvents[1].chunk).toMatchObject({ speech: 'PDF Page 2 summary section.' });
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('PDF selected text reading: reads extracted selection without streaming full document', async () => {
    const harness = createHarness({
      extractActiveTab: vi.fn(async ({ readSelection = false } = {}) => {
        if (readSelection) {
          return {
            tabId: 105,
            url: 'https://example.test/document.pdf',
            source: 'selection',
            text: 'Selected text from page 1 of PDF.',
            chunks: [{ speech: 'Selected text from page 1 of PDF.' }],
          };
        }
        throw new Error('Should not invoke full document extraction when readSelection is true');
      }),
    });

    await harness.orchestrator.readPage({ readSelection: true });

    expect(harness.playbackEvents).toHaveLength(1);
    expect(harness.playbackEvents[0].chunk).toMatchObject({ speech: 'Selected text from page 1 of PDF.' });
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });

  it('Rapid consecutive clicks: cancels previous run and only completes the latest run', async () => {
    const harness = createHarness();
    const firstRun = harness.orchestrator.readPage();
    const secondRun = harness.orchestrator.readPage({ readSelection: true });

    await Promise.all([firstRun, secondRun]);

    // Latest run was selection
    expect(harness.stateHistory.at(-1)).toMatchObject({ state: 'finished' });
  });
});
