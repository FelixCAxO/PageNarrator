import { createRunTracker } from './reader-engine-read-loop.fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';

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

  it('reports an unavailable selected voice without enumerating or starting system speech', async () => {
    const states = [];
    const synthesize = vi.fn();
    const playGeneratedAudio = vi.fn();
    const orchestrator = createReadLoopOrchestrator({
      state: { selectedLanguageCode: 'de', testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Hallo.',
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 3, url: 'https://example.test/unavailable-voice', source: 'selection',
        text: 'Hallo.', chunks: [{ speech: 'Hallo.' }],
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => null,
      ensureSpeechPreloadWindow: synthesize,
      playGeneratedAudio,
    });

    await orchestrator.readPage();

    expect(states.at(-1)).toMatchObject({ state: 'error', message: expect.any(String) });
    expect(states.at(-1).message.length).toBeGreaterThan(0);
    expect(synthesize).not.toHaveBeenCalled();
    expect(playGeneratedAudio).not.toHaveBeenCalled();
    expect(systemSpeech.getVoices).not.toHaveBeenCalled();
    expect(systemSpeech.speak).not.toHaveBeenCalled();
  });

  it('selects the Kokoro backend before extraction captures its chunk profile', async () => {
    const order = [];
    let resolvePlan = () => {};
    const planReady = new Promise((resolve) => {
      resolvePlan = resolve;
    });
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: true },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Selected text only.',
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {
        order.push('backend-plan-start');
        await planReady;
        order.push('backend-plan-finish');
      },
      extractActiveTab: async () => {
        order.push('extract');
        return {
          tabId: 2,
          url: 'https://example.test/selection',
          title: 'Selection',
          source: 'selection',
          text: 'Selected text only.',
          chunks: [{ speech: 'Selected text only.' }],
        };
      },
      getActiveTtsProfileConfig: () => {
        order.push('profile-config');
        return { maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 };
      },
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    const read = orchestrator.readPage({ readSelection: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    const orderBeforePlanResolution = [...order];

    let assertionError = null;
    try {
      expect(orderBeforePlanResolution).toEqual(['backend-plan-start']);
    } catch (error) {
      assertionError = error;
    } finally {
      resolvePlan();
      await read;
    }

    if (assertionError) throw assertionError;
    expect(order.indexOf('backend-plan-finish')).toBeLessThan(order.indexOf('extract'));
    expect(order.indexOf('backend-plan-finish')).toBeLessThan(order.indexOf('profile-config'));
  });

  it('marks selected-text reads as selected while preparing', async () => {
    const states = [];
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: true },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Selected text only.',
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/selection',
        title: 'Selection',
        source: 'selection',
        text: 'Selected text only.',
        chunks: [{ speech: 'Selected text only.' }],
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
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage({ readSelection: true });

    expect(states[0]).toMatchObject({ state: 'preparing', source: 'selection' });
  });

  it.each([
    { type: 'page-title', wait: true, abort: false },
    { type: 'heading', wait: true, abort: false },
    { type: 'paragraph', wait: false, abort: false },
    { type: 'page-title', wait: true, abort: true },
    { type: 'page-title', wait: true, abort: false, slow: true },
  ])('buffers an opening $type before slow body audio (abort: $abort, slow: $slow)', async ({ type, wait, abort, slow }) => {
    if (slow) vi.useFakeTimers();
    const controller = new AbortController();
    const state = { testSilentTtsEnabled: true };
    const chunks = [{ type, speech: 'Short opening.' }, { type: 'paragraph', speech: 'The following paragraph has more words and needs more time to generate its audio.' }];
    const played = [];
    let releaseBody;
    const body = new Promise((resolve) => { releaseBody = resolve; });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: { beginRun: () => 1, getRunSignal: () => controller.signal, isCurrentRun: () => true },
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => chunks.length,
        getLoadedChunkText: () => chunks.map(({ speech }) => speech).join(' '),
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({ tabId: 2, url: 'https://example.test/opening', source: 'html', text: 'Short opening. Body.', chunks }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1, speechPreloadTimeoutMs: 60_000 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro', lang: 'en-US', detectCode: 'en' }),
      ensureSpeechPreloadWindow: ({ speechPreloads, currentIndex }) => {
        speechPreloads.set(0, Promise.resolve({ result: {} }));
        speechPreloads.set(1, body);
        return speechPreloads.get(currentIndex);
      },
      readPreloadedSpeech: async (preload) => (await preload).result,
      playKokoroSpeech: async (_speech, chunk) => { played.push(chunk.speech); },
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });
    const read = orchestrator.readPage();
    for (let attempt = 0; attempt < 80; attempt++) await Promise.resolve();
    try {
      if (slow) await vi.advanceTimersByTimeAsync(3000);
      expect(played).toEqual(wait ? [] : ['Short opening.']);
      if (abort) {
        controller.abort();
        await read;
        expect(played).toEqual([]);
      }
    } finally {
      releaseBody({ result: {} });
      await read;
      if (slow) vi.useRealTimers();
    }
    if (!abort) expect(played).toEqual(chunks.map(({ speech }) => speech));
  });

  it('waits for a pending read pause before generated audio playback starts', async () => {
    const state = {};
    const order = [];
    let releasePause = () => {};
    let enteredPause = () => {};
    let pauseGateUsed = false;
    const pauseEntered = new Promise((resolve) => {
      enteredPause = resolve;
    });
    const pauseRelease = new Promise((resolve) => {
      releasePause = resolve;
    });
    const playGeneratedAudio = vi.fn(async () => {
      order.push('play-generated-audio');
    });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'A long enough generated audio section.',
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/pause',
        title: 'Pause gate',
        source: 'selection',
        text: 'A long enough generated audio section for the read loop pause gate.',
        chunks: [{ speech: 'A long enough generated audio section for the read loop pause gate.' }],
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
      ensureSpeechPreloadWindow: () => ({}),
      readPreloadedSpeech: async () => ({
        blob: new Blob(['audio']),
        wordTimings: [],
      }),
      playKokoroSpeech: playGeneratedAudio,
      waitForReadPause: async () => {
        order.push('pause-gate');
        if (pauseGateUsed) return;
        pauseGateUsed = true;
        enteredPause();
        await pauseRelease;
        order.push('pause-released');
      },
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    const readPromise = orchestrator.readPage();
    await pauseEntered;

    expect(playGeneratedAudio).not.toHaveBeenCalled();

    releasePause();
    await readPromise;

    expect(order.indexOf('pause-released')).toBeLessThan(order.indexOf('play-generated-audio'));
    expect(playGeneratedAudio).toHaveBeenCalledTimes(1);
  });
});
