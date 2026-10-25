import { createRunTracker } from './reader-engine-read-loop.fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';

import { createReaderEngineSpeechPreloadController } from '../../src/lib/reader-engine-speech-preload-controller.js';

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

  it('does not preempt an explicit Balanced Kokoro CPU read with browser voice before setup', async () => {
    const ensureModel = vi.fn(async () => {});
    const playKokoroSpeech = vi.fn(async () => {});
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Explicit Balanced should keep Kokoro on CPU-only reads.',
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({
        device: 'wasm',
        dtype: 'q8',
        reason: 'explicit-balanced',
        cpuBudgetTarget: true,
      }),
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/explicit-balanced',
        title: 'Explicit Balanced',
        source: 'reading-model',
        text: 'Explicit Balanced should keep Kokoro on CPU-only reads.',
        chunks: [{ speech: 'Explicit Balanced should keep Kokoro on CPU-only reads.' }],
      }),
      getActiveTtsProfileConfig: () => ({
        requestedProfile: 'balanced',
        profile: 'balanced',
        maxChunkLength: 500,
        targetMinLength: 100,
        preloadAhead: 0,
      }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      getSelectedVoiceId: () => 'af_heart',
      ensureModel,
      playKokoroSpeech,
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({
      warmupVoice: 'af_heart',
      backendPlan: expect.objectContaining({ reason: 'explicit-balanced' }),
    }));
    expect(playKokoroSpeech).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for CPU-friendly generated speech past 12s when no browser fallback is available', async () => {
    vi.useFakeTimers();
    const text = 'A';
    const states = [];
    const played = [];
    const readyTimeouts = [];
    const activeProfile = {
      requestedProfile: 'balanced',
      profile: 'balanced',
      maxChunkLength: 500,
      targetMinLength: 100,
      preloadAhead: 0,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: false,
    };
    let releaseGenerate;
    const state = {
      testSilentTtsEnabled: false,
      selectedLanguageCode: 'en',
      activeChunks: [],
      activeSpeechPreloadCleanup: () => {},
      getSelectedVoiceId: () => 'af_heart',
      tts: {
        generate: vi.fn(() => new Promise((resolve) => {
          releaseGenerate = () => resolve({
            audio: new Float32Array(240_000),
            sampling_rate: 24_000,
          });
        })),
      },
    };
    const readRunTracker = createRunTracker();
    const preloadController = createReaderEngineSpeechPreloadController({
      state,
      playbackSession: {
        setActiveSpeechPreloadCleanup() {},
        clearActiveSpeechPreloads() {},
      },
      readRunTracker,
      getActiveTtsProfileConfig: () => activeProfile,
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      prepareActiveVoiceRuntime: async () => {},
      trackActiveVoiceSynthesisPromise: (promise) => promise,
      trackActiveVoiceSynthesisSegments: (segments) => segments,
      highlightQueuedChunk: async () => {},
      suppressError: () => {},
    });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker,
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => text,
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({
        device: 'wasm',
        dtype: 'q8',
        reason: 'explicit-balanced',
        cpuBudgetTarget: true,
      }),
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/no-browser-fallback',
        title: 'No browser fallback',
        source: 'selection',
        text,
        chunks: [{ speech: text }],
      }),
      getActiveTtsProfileConfig: () => activeProfile,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      getSelectedVoiceId: () => 'af_heart',
      ensureModel: async () => {},
      ensureSpeechPreloadWindow: preloadController.ensureSpeechPreloadWindow,
      readPreloadedSpeech: (preload, options = {}) => {
        readyTimeouts.push(options.readyTimeoutMs);
        return preloadController.readPreloadedSpeech(preload, options);
      },
      getProfileMinimumAhead: preloadController.getProfileMinimumAhead,
      playKokoroSpeech: async (speech) => played.push(speech),
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    let readSettled = false;
    const read = orchestrator.readPage().finally(() => {
      readSettled = true;
    });
    for (let attempt = 0; attempt < 100 && state.tts.generate.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(state.tts.generate).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 100 && readyTimeouts.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(readyTimeouts).toEqual([60_000]);

    vi.advanceTimersByTime(12_000);
    await Promise.resolve();

    expect(states.at(-1)).not.toMatchObject({
      state: 'error',
      message: 'Speech preload did not become ready within 12000 ms.',
    });

    releaseGenerate();
    for (let attempt = 0; attempt < 100 && !readSettled; attempt += 1) {
      await Promise.resolve();
    }
    expect(readSettled).toBe(true);
    await read;

    expect(played).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ state: 'finished' });
  }, 10_000);

  it('keeps balanced Kokoro waiting past 12s for the selected voice', async () => {
    vi.useFakeTimers();
    const text = 'Balanced generated speech should keep the selected AI voice.';
    const played = [];
    const states = [];
    const activeProfile = {
      requestedProfile: 'balanced',
      profile: 'balanced',
      maxChunkLength: 500,
      targetMinLength: 100,
      preloadAhead: 0,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: false,
    };
    const state = {
      testSilentTtsEnabled: false,
      selectedLanguageCode: 'en',
      activeChunks: [],
      activeSpeechPreloadCleanup: () => {},
      getSelectedVoiceId: () => 'af_heart',
      tts: {
        generate: vi.fn(() => new Promise((resolve) => {
          releaseGenerate = () => resolve({
            audio: new Float32Array(240_000),
            sampling_rate: 24_000,
          });
        })),
      },
    };
    let releaseGenerate;
    const readRunTracker = createRunTracker();
    const preloadController = createReaderEngineSpeechPreloadController({
      state,
      playbackSession: {
        setActiveSpeechPreloadCleanup() {},
        clearActiveSpeechPreloads() {},
      },
      readRunTracker,
      getActiveTtsProfileConfig: () => activeProfile,
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      prepareActiveVoiceRuntime: async () => {},
      trackActiveVoiceSynthesisPromise: (promise) => promise,
      trackActiveVoiceSynthesisSegments: (segments) => segments,
      highlightQueuedChunk: async () => {},
      suppressError: () => {},
    });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker,
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => text,
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({
        device: 'wasm',
        dtype: 'q8',
        reason: 'explicit-balanced',
        cpuBudgetTarget: true,
      }),
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/no-browser-fallback',
        title: 'No browser fallback',
        source: 'selection',
        text,
        chunks: [{ speech: text }],
      }),
      getActiveTtsProfileConfig: () => activeProfile,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      getSelectedVoiceId: () => 'af_heart',
      ensureModel: async () => {},
      ensureSpeechPreloadWindow: preloadController.ensureSpeechPreloadWindow,
      readPreloadedSpeech: preloadController.readPreloadedSpeech,
      getProfileMinimumAhead: preloadController.getProfileMinimumAhead,
      playKokoroSpeech: async (speech) => played.push(speech),
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    let readSettled = false;
    const read = orchestrator.readPage().finally(() => {
      readSettled = true;
    });
    for (let attempt = 0; attempt < 100 && state.tts.generate.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(state.tts.generate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(12_000);
    await Promise.resolve();
    expect(readSettled).toBe(false);

    releaseGenerate();
    for (let attempt = 0; attempt < 100 && !readSettled; attempt += 1) await Promise.resolve();
    await read;

    expect(played, JSON.stringify({ states }, null, 2)).toHaveLength(1);
    expect(systemSpeech.speak).not.toHaveBeenCalled();
  }, 10_000);

  it('plays selected voice after a later low-power retier', async () => {
    const text = 'Balanced generated audio should still play after a later governor retier.';
    const played = [];
    const balancedProfile = {
      requestedProfile: 'auto',
      profile: 'balanced',
      maxChunkLength: 500,
      targetMinLength: 100,
      preloadAhead: 0,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: false,
    };
    const lowPowerProfile = {
      requestedProfile: 'auto',
      profile: 'lowPower',
      maxChunkLength: 240,
      targetMinLength: 100,
      preloadAhead: 0,
      progressiveSegments: true,
    };
    let activeProfile = balancedProfile;
    const orchestrator = createReadLoopOrchestrator({
      state: {
        testSilentTtsEnabled: false,
      },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => text,
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({
        device: 'wasm',
        dtype: 'q8',
        reason: 'auto-balanced',
        cpuBudgetTarget: true,
      }),
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/balanced-retier',
        title: 'Balanced retier',
        source: 'selection',
        text,
        chunks: [{ speech: text }],
      }),
      getActiveTtsProfileConfig: () => activeProfile,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      ensureModel: async () => {},
      ensureSpeechPreloadWindow: () => ({}),
      readPreloadedSpeech: async () => {
        activeProfile = lowPowerProfile;
        return {
          blob: new Blob(['audio']),
          wordTimings: [],
          synthesisMetrics: {
            synthesisMs: 4000,
            audioDurationSeconds: 2,
            realTimeFactor: 2,
          },
        };
      },
      playKokoroSpeech: async (speech) => played.push(speech),
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(played).toHaveLength(1);
    expect(systemSpeech.speak).not.toHaveBeenCalled();
  });

  it('plays slow generated speech with the selected voice instead of browser speech', async () => {
    const states = [];
    const playKokoroSpeech = vi.fn(async () => {});
    const orchestrator = createReadLoopOrchestrator({
      state: {},
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Slow generated speech should keep the selected voice.',
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/slow-synthesis',
        title: 'Slow synthesis',
        source: 'reading-model',
        text: 'Slow generated speech should keep the selected voice.',
        chunks: [{ speech: 'Slow generated speech should keep the selected voice.' }],
      }),
      getActiveTtsProfileConfig: () => ({
        maxChunkLength: 500,
        targetMinLength: 100,
        preloadAhead: 0,
      }),
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
        synthesisMetrics: {
          synthesisMs: 4000,
          audioDurationSeconds: 2,
          realTimeFactor: 2,
        },
      }),
      playKokoroSpeech,
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(playKokoroSpeech).toHaveBeenCalledTimes(1);
    expect(systemSpeech.speak).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ state: 'finished' });
  });
});
