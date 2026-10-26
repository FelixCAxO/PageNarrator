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
  let setLanguageSelectValue;
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
    const storage = createMemoryStorage();
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
    setLanguageSelectValue = vi.fn((value) => { els.language.value = value; });
    ensureModel = vi.fn(async () => {});
    playKokoroSpeech = vi.fn(async () => {});
    readRunTracker = createReadRunTracker();
    readLoop = createReadLoopOrchestrator({
      state, readRunTracker,
      extractActiveTab: async () => article,
      setReadingState: (next) => { state.readingState = next; },
      populateVoices, renderLanguageStatus, setLanguageSelectValue,
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
    expect(setLanguageSelectValue).toHaveBeenCalledExactlyOnceWith('en');
    expect(populateVoices).toHaveBeenCalledOnce();
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
    expect(setLanguageSelectValue).not.toHaveBeenCalled();
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

    expect(setLanguageSelectValue).not.toHaveBeenCalled();
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

  it('suggests OmniVoice and does not synthesize reliably detected foreign text with English Kokoro', async () => {
    detectLanguage.mockResolvedValue({ isReliable: true, languages: [{ language: 'de', percentage: 99 }] });
    await readLoop.readPage();
    expect(state.selectedLanguageCode).toBe('en');
    expect(state.readingState).toBe('error');
    expect(els.languageStatus.textContent).toContain('Choose OmniVoice and German');
    expect(ensureModel).not.toHaveBeenCalled();
    expect(playKokoroSpeech).not.toHaveBeenCalled();
  });

  it('automatically selects a detected language within OmniVoice', async () => {
    els.ttsEngine.value = 'omnivoice';
    detectLanguage.mockResolvedValue({ isReliable: true, languages: [{ language: 'zh-CN', percentage: 99 }] });
    await readLoop.readPage();
    expect(state.selectedLanguageCode).toBe('zh');
    expect(els.language.value).toBe('zh');
    expect(ensureModel).toHaveBeenCalledWith(expect.objectContaining({ warmupVoice: expect.stringContaining('omnivoice:zh:') }));
    expect(els.languageStatus.textContent).toContain('Detected Chinese (99%).');
  });
});
