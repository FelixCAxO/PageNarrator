import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupGlobalDom, installGlobalDom } from '../fixtures/jsdom-helpers.js';
import { createMemoryStorage } from '../fixtures/storage-mocks.js';
import { getReaderEngineElements } from '../../src/lib/reader-engine-dom.js';
import { createReadRunTracker } from '../../src/lib/reader-engine-read-lifecycle.js';
import { createReadLoopOrchestrator } from '../../src/lib/reader-engine-read-loop.js';
import { createReaderEngineStorageAdapter } from '../../src/lib/reader-engine-storage-adapter.js';
import { createReaderEngineVoiceSettingsController } from '../../src/lib/reader-engine-voice-settings-controller.js';
import { getVoiceById } from '../../src/lib/voice-registry.js';

describe('language detection in the shipped read loop and voice settings', () => {
  let els;
  let state;
  let article;
  let detectLanguage;
  let populateVoices;
  let renderLanguageStatus;
  let applyDetectedVoice;
  let canUseOmniVoice;
  let storage;
  let ensureModel;
  let playKokoroSpeech;
  let readRunTracker;
  let readLoop;

  beforeEach(async () => {
    const dom = installGlobalDom(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
    els = getReaderEngineElements(dom.window.document);
    state = { selectedLanguageCode: 'en' };
    article = {
      tabId: 2, url: 'https://example.test/article', source: 'page',
      text: 'This article explains how people can select a local English voice and follow the text while PageNarrator reads it aloud.',
    };
    detectLanguage = vi.fn(async () => ({ isReliable: true, languages: [{ language: 'en', percentage: 94 }] }));
    vi.stubGlobal('chrome', { ...globalThis.chrome, i18n: { detectLanguage } });
    vi.stubGlobal('__pnReaderEngineInitStage', globalThis.__pnReaderEngineInitStage);
    storage = createMemoryStorage();
    const voiceSettings = createReaderEngineVoiceSettingsController({
      els,
      readerEngineStorage: createReaderEngineStorageAdapter({ storage }),
      state: {
        get selectedLanguageCode() { return state.selectedLanguageCode; },
        setSelectedLanguageCode(value) { state.selectedLanguageCode = value; },
      },
    });
    await voiceSettings.populateVoices();
    populateVoices = vi.fn(voiceSettings.populateVoices);
    renderLanguageStatus = vi.fn(voiceSettings.renderLanguageStatus);
    applyDetectedVoice = vi.fn(voiceSettings.applyDetectedVoice);
    canUseOmniVoice = vi.fn(async () => false);
    ensureModel = vi.fn(async () => {});
    playKokoroSpeech = vi.fn(async () => {});
    readRunTracker = createReadRunTracker();
    readLoop = createReadLoopOrchestrator({
      state, readRunTracker,
      extractActiveTab: async () => article,
      setReadingState: (next) => { state.readingState = next; },
      renderLanguageStatus, applyDetectedVoice, canUseOmniVoice, isEngineAuto: voiceSettings.isEngineAuto,
      resolveSelectedVoice: voiceSettings.resolveSelectedVoice,
      ensureModel, playKokoroSpeech,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanupGlobalDom();
  });

  it('detects English, renders all ten Kokoro voices, and prepares the selected voice', async () => {
    await readLoop.readPage();

    expect(detectLanguage).toHaveBeenCalledWith(article.text);
    expect(applyDetectedVoice).not.toHaveBeenCalled();
    expect(els.language.value).toBe('en');
    const voices = [...els.voice.options].map((option) => getVoiceById(option.value));
    expect(voices).toHaveLength(10);
    expect(voices.every((voice) => voice?.engine === 'kokoro' && voice.detectCode === 'en')).toBe(true);
    expect(els.languageStatus.textContent).toContain('Detected English (94%).');
    expect(els.languageStatus.textContent).toContain('Missing voice files download from Hugging Face');
    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: els.voice.value }));
    expect(playKokoroSpeech).toHaveBeenCalledOnce();
    expect(state.readingState).toBe('finished');
  });

  it.each(['short', 'ambiguous'])('preserves a manually selected voice when %s text does not establish a reliable language', async (sample) => {
    els.voice.value = 'am_michael';
    if (sample === 'short') article.text = 'short text';
    else detectLanguage.mockResolvedValue({ languages: [{ language: 'fr', percentage: 55 }, { language: 'en', percentage: 45 }] });

    await readLoop.readPage();

    expect(detectLanguage).toHaveBeenCalledTimes(sample === 'short' ? 0 : 1);
    expect(applyDetectedVoice).not.toHaveBeenCalled();
    expect(populateVoices).not.toHaveBeenCalled();
    expect(state.selectedLanguageCode).toBe('en');
    expect(els.language.value).toBe('en');
    expect(els.voice.value).toBe('am_michael');
    expect(els.voice.options).toHaveLength(10);
    expect(els.languageStatus.textContent).toContain('Language detection was uncertain.');
    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: 'am_michael' }));
    expect(playKokoroSpeech).toHaveBeenCalledOnce();
    expect(state.readingState).toBe('finished');
  });

  it('ignores a late language result after the read is cancelled while detection is pending', async () => {
    let finishDetection;
    let signalDetectionStarted;
    const started = new Promise((resolve) => { signalDetectionStarted = resolve; });
    const detection = new Promise((resolve) => { finishDetection = resolve; });
    detectLanguage.mockImplementation(() => {
      signalDetectionStarted();
      return detection;
    });
    els.voice.value = 'am_michael';
    const statusBeforeRead = els.languageStatus.textContent;
    const reading = readLoop.readPage();
    await started;
    readRunTracker.abortCurrentRun();
    finishDetection({ languages: [{ language: 'fr', percentage: 94 }] });
    await reading;

    expect(applyDetectedVoice).not.toHaveBeenCalled();
    expect(populateVoices).not.toHaveBeenCalled();
    expect(renderLanguageStatus).not.toHaveBeenCalled();
    expect(state.selectedLanguageCode).toBe('en');
    expect(els.voice.value).toBe('am_michael');
    expect(els.languageStatus.textContent).toBe(statusBeforeRead);
    expect(ensureModel).not.toHaveBeenCalled();
    expect(playKokoroSpeech).not.toHaveBeenCalled();
    expect(state.readingState).toBe('idle');
    expect(state.activeReadingCursor).toBeNull();
  });

  it('keeps English Kokoro and explains OmniVoice when this browser cannot run it', async () => {
    detectLanguage.mockResolvedValue({ isReliable: true, languages: [{ language: 'de', percentage: 99 }] });
    await readLoop.readPage();
    expect(canUseOmniVoice).toHaveBeenCalledOnce();
    expect(applyDetectedVoice).not.toHaveBeenCalled();
    expect(state.selectedLanguageCode).toBe('en');
    expect(state.readingState).toBe('error');
    expect(els.languageStatus.textContent).toContain('Choose OmniVoice and German');
    expect(ensureModel).not.toHaveBeenCalled();
    expect(playKokoroSpeech).not.toHaveBeenCalled();
  });

  it('switches a German page from Kokoro to German OmniVoice and remembers detection chose it', async () => {
    canUseOmniVoice.mockResolvedValue(true);
    detectLanguage.mockResolvedValue({ isReliable: true, languages: [{ language: 'de', percentage: 99 }] });
    await readLoop.readPage();
    expect(applyDetectedVoice).toHaveBeenCalledExactlyOnceWith({ engine: 'omnivoice', code: 'de', autoEngine: true });
    expect(els.ttsEngine.value).toBe('omnivoice');
    expect(els.language.value).toBe('de');
    expect((await storage.get('playbackSettings')).playbackSettings).toMatchObject({ ttsEngine: 'omnivoice', language: 'de', ttsEngineAuto: true });
    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: expect.stringContaining('omnivoice:de:') }));
    expect(els.languageStatus.textContent).toContain('Detected German (99%).');
  });

  it('switches the chosen OmniVoice language to the detected page language', async () => {
    els.ttsEngine.value = 'omnivoice';
    state.selectedLanguageCode = 'sv';
    await populateVoices();
    detectLanguage.mockResolvedValue({ isReliable: true, languages: [{ language: 'zh-CN', percentage: 99 }] });
    await readLoop.readPage();
    expect(applyDetectedVoice).toHaveBeenCalledExactlyOnceWith({ engine: 'omnivoice', code: 'zh', autoEngine: false });
    expect(els.language.value).toBe('zh');
    expect(canUseOmniVoice).not.toHaveBeenCalled();
    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: expect.stringContaining('omnivoice:zh:') }));
    expect(els.languageStatus.textContent).toContain('Detected Chinese (99%).');
  });

  it.each([[true, 'kokoro'], [false, 'omnivoice']])('returns an English page to Kokoro only when detection chose OmniVoice (auto %s)', async (auto, engine) => {
    await storage.set({ playbackSettings: { ttsEngine: 'omnivoice', language: 'de', ...(auto ? { ttsEngineAuto: true } : {}) } });
    els.ttsEngine.value = 'omnivoice';
    state.selectedLanguageCode = 'de';
    await populateVoices();
    await readLoop.readPage();
    expect(applyDetectedVoice).toHaveBeenCalledExactlyOnceWith({ engine, code: 'en', autoEngine: false });
    expect(els.ttsEngine.value).toBe(engine);
    const stored = (await storage.get('playbackSettings')).playbackSettings;
    expect(stored.ttsEngine).toBe(engine);
    expect(stored.ttsEngineAuto).toBeUndefined();
    expect(state.readingState).toBe('finished');
  });
});
