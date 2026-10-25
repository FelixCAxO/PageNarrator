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

  it('surfaces generated speech synthesis timeouts without browser speech', async () => {
    const states = [];
    const flowEvents = [];
    const timeoutError = new Error('Generated speech did not finish promptly.');
    timeoutError.code = 'generated_speech_timeout';
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'Timed out generated speech should report the error.',
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
        text: 'Timed out generated speech should report the error.',
        chunks: [{ speech: 'Timed out generated speech should report the error.' }],
      }),
      getActiveTtsProfileConfig: () => ({
        requestedProfile: 'auto',
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
        customVoiceConfig: { consentConfirmedAt: Date.now() },
      }),
      ensureSpeechPreloadWindow: () => Promise.resolve({
        result: {
          blob: new Blob(['audio']),
          wordTimings: [],
        },
      }),
      readPreloadedSpeech: async () => {
        throw timeoutError;
      },
      playKokoroSpeech: async () => {
        throw new Error('generated audio should not be used after timeout');
      },
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
      flowRecorder: { record: (event) => flowEvents.push(event) },
    });

    await orchestrator.readPage();

    expect(systemSpeech.speak).not.toHaveBeenCalled();
    expect(flowEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'synthesis_failed',
        chunkIndex: 0,
      }),
    ]));
    expect(flowEvents.some((event) => event.kind === 'browser_voice_fallback')).toBe(false);
    expect(states.at(-1)).toMatchObject({
      state: 'error',
      message: 'Generated speech did not finish promptly.',
      errorCode: 'generated_speech_timeout',
    });
  });

  it('stops instead of draining the queue when generated speech fails', async () => {
    const states = [];
    const preloadError = new Error('Kokoro synthesis failed.');
    const readPreloadedSpeech = vi.fn(async () => {
      throw preloadError;
    });
    const playKokoroSpeech = vi.fn(async () => {});
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 2,
        getLoadedChunkText: () => 'First section. Second section.',
      },
      setReadingState: (state, options = {}) => states.push({ state, ...options }),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/tts-fail',
        title: 'TTS fail',
        source: 'reading-model',
        text: 'First section. Second section.',
        chunks: [
          { speech: 'First section.' },
          { speech: 'Second section.' },
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
      ensureSpeechPreloadWindow: () => ({}),
      readPreloadedSpeech,
      playKokoroSpeech,
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(readPreloadedSpeech).toHaveBeenCalledTimes(1);
    expect(playKokoroSpeech).not.toHaveBeenCalled();
    expect(systemSpeech.speak).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      state: 'error',
      message: 'Kokoro synthesis failed.',
    });
  });

  it('loads Kokoro on auto CPU-only reads', async () => {
    const ensureModel = vi.fn(async () => {});
    const playKokoroSpeech = vi.fn(async () => {});
    const backendPlan = {
      device: 'wasm',
      dtype: 'q8',
      reason: 'no-webgpu',
      cpuBudgetTarget: true,
    };
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'CPU-only generated voice setup should not block the read.',
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => backendPlan,
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/cpu-only',
        title: 'CPU only',
        source: 'reading-model',
        text: 'CPU-only generated voice setup should not block the read.',
        chunks: [{ speech: 'CPU-only generated voice setup should not block the read.' }],
      }),
      getActiveTtsProfileConfig: () => ({
        requestedProfile: 'auto',
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
      readPreloadedSpeech: async () => ({
        blob: new Blob(['audio']),
        wordTimings: [],
      }),
      playKokoroSpeech,
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({
      warmupVoice: 'af_heart',
      backendPlan,
      warmupText: 'CPU-only generated voice setup should not block the read.',
    }));
    expect(playKokoroSpeech).toHaveBeenCalledTimes(1);
  });

  it('normalizes stale English Kokoro IDs before model warmup', async () => {
    const ensureModel = vi.fn(async () => {});
    const playKokoroSpeech = vi.fn(async () => {});
    const selectedVoice = {
      id: 'af_heart',
      engine: 'kokoro',
      lang: 'en-US',
      detectCode: 'en',
    };
    const orchestrator = createReadLoopOrchestrator({
      state: { testSilentTtsEnabled: false },
      readRunTracker: createRunTracker(),
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 1,
        getLoadedChunkText: () => 'A stale English voice ID should still load Heart.',
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
        url: 'https://example.test/stale-english-voice',
        title: 'Stale English voice',
        source: 'reading-model',
        text: 'A stale English voice ID should still load Heart.',
        chunks: [{ speech: 'A stale English voice ID should still load Heart.' }],
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
      resolveSelectedVoice: () => selectedVoice,
      getSelectedVoiceId: () => 'kokoro-af-heart',
      ensureModel,
      readPreloadedSpeech: async () => ({
        blob: new Blob(['audio']),
        wordTimings: [],
      }),
      playKokoroSpeech,
      waitBetweenSections: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({
      warmupVoice: 'af_heart',
    }));
    expect(ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({
      warmupVoice: 'kokoro-af-heart',
    }));
    expect(playKokoroSpeech).toHaveBeenCalledTimes(1);
  });
});
