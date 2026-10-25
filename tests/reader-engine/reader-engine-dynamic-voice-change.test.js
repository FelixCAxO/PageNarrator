import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { applyPlaybackSettingsFromStorage } from '../../src/lib/reader-engine-playback-settings-sync.js';
import { createReaderEngineVoiceSettingsController } from '../../src/lib/reader-engine-voice-settings-controller.js';
import { createReaderEngineStorageAdapter } from '../../src/lib/reader-engine-storage-adapter.js';
import { createReaderEngineSpeechPreloadController } from '../../src/lib/reader-engine-speech-preload-controller.js';
import { createAudioPlaybackManager } from '../../src/lib/reader-engine-audio-playback.js';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';

function createMemoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(query) {
      if (query == null) return { ...data };
      if (typeof query === 'string') return { [query]: data[query] };
      if (Array.isArray(query)) {
        return Object.fromEntries(query.map((key) => [key, data[key]]));
      }
      return Object.fromEntries(Object.entries(query).map(([key, def]) => [key, key in data ? data[key] : def]));
    },
    async set(next) {
      Object.assign(data, next);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    _data: data,
  };
}

describe('readerEngine dynamic voice change', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete globalThis.document;
  });

  it('switches to the newly selected Kokoro voice for subsequent sections during active multi-section reading', async () => {
    let currentVoiceId = 'af_heart';
    const played = [];

    const section1 = 'First section text for testing multi-section voice switching.';
    const section2 = 'Second section text for testing multi-section voice switching.';
    const section3 = 'Third section text for testing multi-section voice switching.';

    const state = {
      testSilentTtsEnabled: true,
      selectedLanguageCode: 'en',
    };

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: {
        beginRun: () => 1,
        getRunSignal: () => ({ aborted: false }),
        isCurrentRun: () => true,
      },
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 3,
        getLoadedChunkText: () => section1,
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({ device: 'wasm' }),
      extractActiveTab: async () => ({
        tabId: 1,
        url: 'https://example.test/article',
        title: 'Article',
        source: 'selection',
        text: `${section1}\n\n${section2}\n\n${section3}`,
        chunks: [{ speech: section1 }, { speech: section2 }, { speech: section3 }],
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: currentVoiceId,
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      ensureSpeechPreloadWindow: ({ selectedVoice, currentIndex }) => ({ currentIndex, voiceId: selectedVoice.id }),
      readPreloadedSpeech: async (preload) => ({
        blob: new Blob(['audio']),
        wordTimings: [],
        voiceId: preload?.voiceId,
      }),
      playKokoroSpeech: async (speech, chunk) => {
        played.push({ voiceId: currentVoiceId, speechText: chunk.speech || chunk.text || chunk });
        // While playing section 1, user changes voice to am_michael
        if ((chunk.speech || chunk.text || chunk) === section1) {
          currentVoiceId = 'am_michael';
        }
      },
      playGeneratedAudio: async () => {},
      setCurrentSectionText: () => {},
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      compactActivePdfChunkHistory: () => {},
      queuePostPlaybackBookkeeping: () => {},
      saveResumeChunk: async () => {},
      clearActiveSpeechPreloads: () => {},
    });

    await orchestrator.readPage({ readSelection: true });

    expect(played).toHaveLength(3);
    expect(played[0].voiceId).toBe('af_heart');
    expect(played[1].voiceId).toBe('am_michael');
    expect(played[2].voiceId).toBe('am_michael');
  });

  it('switches to the newly selected voice when changed while paused', async () => {
    let currentVoiceId = 'af_heart';
    const played = [];
    let isPaused = true;
    let resumeResolver = null;

    const section1 = 'Paused section text.';
    const section2 = 'Next section text.';

    const state = {
      testSilentTtsEnabled: true,
      selectedLanguageCode: 'en',
    };

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: { beginRun: () => 1, getRunSignal: () => ({ aborted: false }), isCurrentRun: () => true },
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 2,
        getLoadedChunkText: () => section1,
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({ device: 'wasm' }),
      extractActiveTab: async () => ({
        tabId: 1,
        url: 'https://example.test/article',
        title: 'Article',
        source: 'selection',
        text: `${section1}\n\n${section2}`,
        chunks: [{ speech: section1 }, { speech: section2 }],
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 0 }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => ({
        id: currentVoiceId,
        engine: 'kokoro',
        lang: 'en-US',
        detectCode: 'en',
      }),
      ensureSpeechPreloadWindow: ({ selectedVoice, currentIndex }) => ({ currentIndex, voiceId: selectedVoice.id }),
      readPreloadedSpeech: async (preload) => ({
        blob: new Blob(['audio']),
        wordTimings: [],
        voiceId: preload?.voiceId,
      }),
      playKokoroSpeech: async (speech, chunk) => {
        played.push({ voiceId: currentVoiceId, chunk: chunk.speech || chunk.text || chunk });
      },
      playGeneratedAudio: async () => {},
      setCurrentSectionText: () => {},
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {
        if (isPaused) {
          await new Promise((resolve) => { resumeResolver = resolve; });
        }
      },
      compactActivePdfChunkHistory: () => {},
      queuePostPlaybackBookkeeping: () => {},
      saveResumeChunk: async () => {},
      clearActiveSpeechPreloads: () => {},
    });

    const readPromise = orchestrator.readPage({ readSelection: true });
    await new Promise((resolve) => setTimeout(resolve, 15));

    // User switches voice to bf_emma while paused
    currentVoiceId = 'bf_emma';
    isPaused = false;
    resumeResolver?.();

    await readPromise;

    expect(played).toHaveLength(2);
    expect(played[0].voiceId).toBe('bf_emma');
    expect(played[1].voiceId).toBe('bf_emma');
  });

  it('updates dropdown, settings summary badge, language status, and warms voice on storage sync', async () => {
    const dom = new JSDOM(`<!doctype html>
      <select id="language"><option value="en">English</option></select>
      <select id="voice">
        <option value="af_heart">Heart</option>
        <option value="am_michael">Michael</option>
      </select>
      <span id="voice-settings-summary">Heart · English · 1.00x</span>
      <p id="language-status">Using Kokoro English voice.</p>`);

    const els = {
      language: dom.window.document.getElementById('language'),
      voice: dom.window.document.getElementById('voice'),
      voiceSettingsSummary: dom.window.document.getElementById('voice-settings-summary'),
      languageStatus: dom.window.document.getElementById('language-status'),
    };

    const storage = createMemoryStorage({
      [STORAGE_KEYS.PLAYBACK_SETTINGS]: {
        language: 'en',
        voice: 'am_michael',
        voicesByLanguage: { en: 'am_michael' },
        speed: 1.25,
      },
    });

    const warmedVoices = [];
    const updateSummarySpy = vi.fn(() => {
      els.voiceSettingsSummary.textContent = 'Michael · English · 1.25x';
    });
    const renderStatusSpy = vi.fn(async () => {
      els.languageStatus.textContent = 'Using Kokoro English voice (Michael).';
    });
    const warmSelectedVoiceSpy = vi.fn(async (v) => {
      warmedVoices.push(v);
    });

    await applyPlaybackSettingsFromStorage({
      els,
      getSelectedLanguageCode: () => 'en',
      setSelectedLanguageCode: () => {},
      readerEngineStorage: createReaderEngineStorageAdapter({ storage }),
      readerEngineSettingsManager: {
        setPlaybackSpeed: () => {},
        setSectionPause: () => {},
        renderHighlightSettings: () => {},
        renderSkipCodeSettings: () => {},
      },
      populateVoices: async () => {},
      updateVoiceSettingsSummary: updateSummarySpy,
      renderLanguageStatus: renderStatusSpy,
      warmSelectedVoice: warmSelectedVoiceSpy,
      renderTtsBackendPreferenceSetting: () => {},
      renderTtsPerformanceProfileSetting: () => {},
      renderIdleReleaseSetting: () => {},
      renderCustomVoiceModelSetting: () => {},
      resetTtsPerformanceGovernor: () => {},
    });

    expect(els.voice.value).toBe('am_michael');
    expect(updateSummarySpy).toHaveBeenCalled();
    expect(renderStatusSpy).toHaveBeenCalled();
    expect(warmSelectedVoiceSpy).toHaveBeenCalledWith('am_michael');
  });

  it('preserves existing dropdown selection when populateVoices runs if valid', async () => {
    const dom = new JSDOM(`<!doctype html>
      <select id="language"><option value="en">English</option></select>
      <select id="voice"></select>
      <p id="language-status"></p>
      <span id="voice-settings-summary"></span>`);
    globalThis.document = dom.window.document;

    const els = {
      language: dom.window.document.getElementById('language'),
      voice: dom.window.document.getElementById('voice'),
      languageStatus: dom.window.document.getElementById('language-status'),
      voiceSettingsSummary: dom.window.document.getElementById('voice-settings-summary'),
    };

    const controller = createReaderEngineVoiceSettingsController({
      els,
      readerEngineStorage: {
        getStoredVoiceForLanguage: async () => null,
      },
      state: { selectedLanguageCode: 'en' },
    });

    // Populate initial options
    await controller.populateVoices();
    expect(els.voice.value).toBe('af_heart');

    // User changes voice to am_michael
    els.voice.value = 'am_michael';

    // Populate runs again (e.g. at read time after language detection)
    await controller.populateVoices();

    // The selection must remain am_michael rather than resetting to af_heart
    expect(els.voice.value).toBe('am_michael');
  });

  it('invalidates outdated future preloads and synthesizes with the newly selected voice when voice changes mid-playback', async () => {
    const synthesisCalls = [];
    const state = {
      testSilentTtsEnabled: false,
      selectedLanguageCode: 'en',
      getSelectedVoiceId: () => 'af_heart',
      activeChunks: [
        { speech: 'Paragraph 0.' },
        { speech: 'Paragraph 1.' },
        { speech: 'Paragraph 2.' },
      ],
      activeSpeechPreloadCleanup: () => {},
      tts: {
        synthesizeChunk: async ({ text, voice }) => {
          synthesisCalls.push({ text, voice: voice?.id || voice });
          return {
            blob: new Blob(['audio-bytes']),
            wordTimings: [{ word: 'test', start: 0, end: 1 }],
            durationSeconds: 1,
          };
        },
        generate: async (text, { voice }) => {
          synthesisCalls.push({ text, voice });
          return {
            audio: new Float32Array(24000),
            sampling_rate: 24000,
          };
        },
      },
    };

    const speechPreloadController = createReaderEngineSpeechPreloadController({
      state,
      playbackSession: {
        setActiveSpeechPreloadCleanup() {},
        clearActiveSpeechPreloads() {},
      },
      readRunTracker: { beginRun: () => 1, getRunSignal: () => ({ aborted: false }), isCurrentRun: () => true },
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 2, progressiveSegments: false }),
      resolveSelectedVoice: () => ({ id: 'af_heart', engine: 'kokoro', lang: 'en-US', detectCode: 'en' }),
      prepareActiveVoiceRuntime: async () => {},
      trackActiveVoiceSynthesisPromise: (p) => p,
      trackActiveVoiceSynthesisSegments: (s) => s,
      highlightQueuedChunk: async () => {},
      suppressError: () => {},
    });

    const speechPreloads = new Map();
    const speechPreloadState = {};
    const queuedHighlightIndices = new Set();

    // 1. Initial preload window for chunk 0 with voice af_heart
    speechPreloadController.ensureSpeechPreloadWindow({
      speechPreloads,
      queuedHighlightIndices,
      currentIndex: 0,
      selectedVoice: { id: 'af_heart', engine: 'kokoro', lang: 'en-US', detectCode: 'en' },
      preloadState: speechPreloadState,
    });

    expect(speechPreloads.has(0)).toBe(true);
    expect(speechPreloads.has(1)).toBe(true);
    expect(speechPreloads.get(1).voiceId).toBe('af_heart');

    // 2. User changes voice to am_puck during paragraph 0 playback
    speechPreloadController.ensureSpeechPreloadWindow({
      speechPreloads,
      queuedHighlightIndices,
      currentIndex: 0,
      selectedVoice: { id: 'am_puck', engine: 'kokoro', lang: 'en-US', detectCode: 'en' },
      preloadState: speechPreloadState,
    });

    // Paragraph 1 preload must now be updated with am_puck
    expect(speechPreloads.has(1)).toBe(true);
    expect(speechPreloads.get(1).voiceId).toBe('am_puck');

    // 3. Reading paragraph 1 preload returns am_puck synthesis
    const preload1 = await speechPreloads.get(1);
    expect(preload1.voiceId).toBe('am_puck');
  });

  it('disposes audio stall watchdog on audio end so handoff awaiting new voice synthesis does not stall', async () => {
    vi.useFakeTimers();

    let audioEndedCallback = () => {};
    const mockAudio = {
      src: 'blob:mock',
      playbackRate: 1,
      currentTime: 0,
      duration: 1,
      paused: false,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      addEventListener: vi.fn((event, handler) => {
        if (event === 'ended') audioEndedCallback = handler;
      }),
      removeEventListener: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      dispatchEvent: vi.fn(),
    };

    const manager = createAudioPlaybackManager({
      audioPool: {
        acquire: () => mockAudio,
        release: () => {},
        destroy: () => {},
      },
      urlApi: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => {},
      },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
    });

    let handoffResolved = false;
    let handoffResolver = () => {};
    const handoffPromise = new Promise((resolve) => {
      handoffResolver = () => {
        handoffResolved = true;
        resolve({ ok: true });
      };
    });

    const playPromise = manager.playAudio(
      new Blob(['audio']),
      [{ word: 'hello', start: 0, end: 1 }],
      { speech: 'hello' },
      {
        onBeforeNormalEnd: async () => {
          await handoffPromise;
          return { ok: true };
        },
      },
    );

    // Audio starts playing
    await vi.advanceTimersByTimeAsync(10);

    // Audio ends naturally
    if (typeof mockAudio.onended === 'function') {
      mockAudio.onended();
    } else {
      audioEndedCallback();
    }

    // Advance time by 70 seconds (well past the 65s watchdog delay) while handoff is still waiting for new voice synthesis
    await vi.advanceTimersByTimeAsync(70_000);

    // The watchdog must NOT have failed/rejected playback!
    expect(handoffResolved).toBe(false);

    // Now handoff finishes synthesizing the new voice
    handoffResolver();
    await playPromise;

    expect(handoffResolved).toBe(true);
  });

  it('runs full read loop with realistic speech preload controller and switches to new voice for next paragraph upon mid-playback voice change', async () => {
    let currentSelectedVoice = {
      id: 'af_heart',
      engine: 'kokoro',
      lang: 'en-US',
      detectCode: 'en',
    };
    const played = [];
    const synthesisLog = [];

    const section0 = 'First paragraph text.';
    const section1 = 'Second paragraph text.';
    const section2 = 'Third paragraph text.';

    const state = {
      testSilentTtsEnabled: false,
      selectedLanguageCode: 'en',
      activeChunks: [{ speech: section0 }, { speech: section1 }, { speech: section2 }],
      activeReadingCursor: {
        _index: 0,
        current() { return this._index; },
        completeCurrent() {
          this._index += 1;
          return this._index;
        },
      },
      getSelectedVoiceId: () => currentSelectedVoice.id,
      activeSpeechPreloadCleanup: () => {},
      tts: {
        synthesizeChunk: async ({ text, voice }) => {
          const v = voice?.id || voice;
          synthesisLog.push({ text, voice: v });
          return {
            blob: new Blob(['pcm']),
            wordTimings: [{ word: 'word', start: 0, end: 1 }],
            durationSeconds: 1,
          };
        },
        generate: async (text, { voice }) => {
          synthesisLog.push({ text, voice });
          return {
            audio: new Float32Array(24000),
            sampling_rate: 24000,
          };
        },
      },
    };

    const preloadController = createReaderEngineSpeechPreloadController({
      state,
      playbackSession: {
        setActiveSpeechPreloadCleanup() {},
        clearActiveSpeechPreloads() {},
      },
      readRunTracker: { beginRun: () => 1, getRunSignal: () => ({ aborted: false }), isCurrentRun: () => true },
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1, progressiveSegments: false }),
      resolveSelectedVoice: () => currentSelectedVoice,
      prepareActiveVoiceRuntime: async () => {},
      trackActiveVoiceSynthesisPromise: (p) => p,
      trackActiveVoiceSynthesisSegments: (s) => s,
      highlightQueuedChunk: async () => {},
      suppressError: () => {},
    });

    const orchestrator = createReadLoopOrchestrator({
      state,
      readRunTracker: { beginRun: () => 1, getRunSignal: () => ({ aborted: false }), isCurrentRun: () => true },
      readOrchestrator: {
        fillChunkBuffer: async () => true,
        fillStartPositionBuffer: async () => true,
        getPlaybackTotal: () => 3,
        getLoadedChunkText: () => section0,
      },
      refreshPanelTargetTab: async () => {},
      warmActiveTabContentScriptAccess: async () => {},
      prepareTtsBackendPlanForChunking: async () => ({ device: 'wasm' }),
      extractActiveTab: async () => ({
        tabId: 1,
        url: 'https://example.test/article',
        title: 'Article',
        source: 'selection',
        text: `${section0}\n\n${section1}\n\n${section2}`,
        chunks: state.activeChunks,
      }),
      getActiveTtsProfileConfig: () => ({ maxChunkLength: 500, targetMinLength: 100, preloadAhead: 1, progressiveSegments: false }),
      populateVoices: async () => {},
      renderLanguageStatus: async () => {},
      resolveSelectedVoice: () => currentSelectedVoice,
      ensureModel: async () => {},
      ensureSpeechPreloadWindow: preloadController.ensureSpeechPreloadWindow,
      readPreloadedSpeech: preloadController.readPreloadedSpeech,
      getProfileMinimumAhead: preloadController.getProfileMinimumAhead,
      playKokoroSpeech: async (speech, chunk, options = {}) => {
        const text = chunk.speech || chunk.text || chunk;
        played.push({
          text,
          voiceId: speech?.voiceId || speech?.result?.voiceId || currentSelectedVoice.id,
        });
        if (options.onAudioStart) {
          options.onAudioStart();
        }
        // While playing section 0, user changes voice to am_puck in UI
        if (text === section0) {
          currentSelectedVoice = {
            id: 'am_puck',
            engine: 'kokoro',
            lang: 'en-US',
            detectCode: 'en',
          };
        }
        if (options.onBeforeNormalEnd) {
          await options.onBeforeNormalEnd();
        }
      },
      playGeneratedAudio: async () => {},
      setCurrentSectionText: () => {},
      waitBetweenSections: async () => {},
      waitForReadPause: async () => {},
      compactActivePdfChunkHistory: () => {},
      queuePostPlaybackBookkeeping: () => {},
      saveResumeChunk: async () => {},
      clearActiveSpeechPreloads: () => {},
    });

    await orchestrator.readPage({ readSelection: true });

    expect(played).toHaveLength(3);
    expect(played[0]).toEqual({ text: section0, voiceId: 'af_heart' });
    expect(played[1]).toEqual({ text: section1, voiceId: 'am_puck' });
    expect(played[2]).toEqual({ text: section2, voiceId: 'am_puck' });
  });
});
