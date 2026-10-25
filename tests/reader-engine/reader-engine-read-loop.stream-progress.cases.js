import {createRunTracker, createStreamingReadOrchestrator, createChunkStream} from './reader-engine-read-loop.fixtures.js';
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

  it('pulls the next streaming PDF chunk when generated audio starts', async () => {
    const state = {
      testSilentTtsEnabled: true,
    };
    const profile = {
      requestedProfile: 'auto',
      profile: 'balanced',
      maxChunkLength: 500,
      targetMinLength: 100,
      preloadAhead: 2,
      speechPreloadTimeoutMs: 60_000,
      progressiveSegments: false,
    };
    const sourceChunks = [
      { speech: 'Streaming PDF first section has enough words to be spoken smoothly.', pageNumber: 1 },
      { speech: 'Streaming PDF second section should already be loaded before playback.', pageNumber: 1 },
      { speech: 'Streaming PDF third section is still inside the initial preload window.', pageNumber: 1 },
      { speech: 'Streaming PDF fourth section must be pulled as soon as audio starts.', pageNumber: 1 },
    ];
    const stream = createChunkStream(sourceChunks);
    const baseReadOrchestrator = createStreamingReadOrchestrator(state);
    const fillTargets = [];
    const synthesisStarts = [];
    let fillTargetsAfterFirstAudioStart = null;
    let synthesisStartsAfterFirstAudioStart = null;
    const selectedVoice = {
      id: 'af_heart',
      engine: 'kokoro',
      detectCode: 'en',
    };
    const readRunTracker = createRunTracker();
    const preloadController = createReaderEngineSpeechPreloadController({
      state,
      playbackSession: {
        setActiveSpeechPreloadCleanup() {},
        clearActiveSpeechPreloads() {},
      },
      readRunTracker,
      getActiveTtsProfileConfig: () => profile,
      resolveSelectedVoice: () => selectedVoice,
      prepareActiveVoiceRuntime: async () => {},
      trackActiveVoiceSynthesisPromise: (promise) => promise,
      trackActiveVoiceSynthesisSegments: (segments) => segments,
      highlightQueuedChunk: async () => {},
      suppressError: () => {},
      synthesizeCustomVoiceSpeech: async (_voice, text) => {
        synthesisStarts.push(text);
        return {
          blob: new Blob(['audio']),
          wordTimings: [],
        };
      },
    });
    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker,
      readOrchestrator: {
        fillChunkBuffer: async (targetIndex, options) => {
          fillTargets.push(targetIndex);
          return baseReadOrchestrator.fillChunkBuffer(targetIndex, options);
        },
        fillStartPositionBuffer: (...args) => baseReadOrchestrator.fillStartPositionBuffer(...args),
        getPlaybackTotal: (...args) => baseReadOrchestrator.getPlaybackTotal(...args),
        getLoadedChunkText: (...args) => baseReadOrchestrator.getLoadedChunkText(...args),
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({
        device: 'wasm',
        dtype: 'q8',
        reason: 'no-adapter',
        cpuBudgetTarget: true,
      }),
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/streaming.pdf',
        title: 'Streaming PDF',
        source: 'pdf',
        pageCount: 1,
        chunkStream: stream,
      }),
      getActiveTtsProfileConfig: () => profile,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => selectedVoice,
      getSelectedVoiceId: () => selectedVoice.id,
      ensureModel: async () => {},
      getProfileMinimumAhead: preloadController.getProfileMinimumAhead,
      ensureSpeechPreloadWindow: preloadController.ensureSpeechPreloadWindow,
      readPreloadedSpeech: preloadController.readPreloadedSpeech,
      playKokoroSpeech: async (_speech, _chunk, options = {}) => {
        options.onAudioStart?.();
        for (let attempt = 0; attempt < 20 && synthesisStarts.length < 4; attempt += 1) {
          await Promise.resolve();
        }
        fillTargetsAfterFirstAudioStart ??= [...fillTargets];
        synthesisStartsAfterFirstAudioStart ??= [...synthesisStarts];
      },
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
    });

    await orchestrator.readPage();

    expect(fillTargetsAfterFirstAudioStart).toContain(3);
  });

  it('records the final streamed chunk count after playback drains the iterator', async () => {
    const state = {};
    const spoken = [];
    const flowEvents = [];

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: createRunTracker(),
      readOrchestrator: createStreamingReadOrchestrator(state),
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => {},
      extractActiveTab: async () => ({
        tabId: 2,
        url: 'https://example.test/streamed-final-count',
        title: 'Streamed final count',
        source: 'selection',
        text: '',
        chunks: [],
        streaming: true,
        startPosition: {
          source: 'viewport',
          text: 'Second streamed section.',
        },
        chunkStream: (async function* streamChunks() {
          yield { speech: 'Intro skipped section.' };
          yield { speech: 'Second streamed section.' };
          yield { speech: 'Third streamed section.' };
          yield { speech: 'Fourth streamed section.' };
        })(),
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1 }),
      loadSavedResumePosition: async () => null,
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: 'af_heart',
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      playKokoroSpeech: async (_speech, chunk) => spoken.push(chunk.speech),
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      saveResumeChunk: async () => {},
      refreshQuota: async () => {},
      queuePostPlaybackBookkeeping: () => {},
      flowRecorder: { record: (event) => flowEvents.push(event) },
    });

    await orchestrator.readPage({ readSelection: true });

    expect(flowEvents.filter((event) => event.kind === 'chunks_extracted')).toEqual([
      expect.objectContaining({
        totalChunks: 2,
        startChunk: 1,
        streaming: true,
      }),
      expect.objectContaining({
        totalChunks: 4,
        startChunk: 1,
        streaming: true,
        final: true,
      }),
    ]);
    expect(spoken).toEqual([
      'Second streamed section.',
      'Third streamed section.',
      'Fourth streamed section.',
    ]);
  });
});
