import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReaderEngineVoiceSettingsController } from '../../src/lib/reader-engine-voice-settings-controller.js';
import { createReaderEngineStorageAdapter } from '../../src/lib/reader-engine-storage-adapter.js';
import { createPageNarratorKokoroTts } from '../../src/lib/kokoro-multilingual.js';
import { synthesizeSpeechChunk } from '../../src/lib/speech-audio.js';

vi.mock('../../src/lib/voice-registry.js', async (importOriginal) => ({
  ...await importOriginal(), cacheKokoroVoiceStyle: vi.fn(async () => {}),
}));

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

function createController() {
  const dom = new JSDOM(`<!doctype html>
    <select id="language"></select>
    <p id="language-status"></p>
    <select id="voice"></select>
    <button id="download"></button>
    <span id="voice-settings-summary"></span>
    <input id="speed" value="1">
    <output id="speed-out"></output>`);
  globalThis.document = dom.window.document;
  const storage = createMemoryStorage();
  const readerEngineStorage = createReaderEngineStorageAdapter({ storage });
  const state = {
    selectedLanguageCode: 'en',
    setSelectedLanguageCode(value) { this.selectedLanguageCode = value; },
  };
  const controller = createReaderEngineVoiceSettingsController({
    els: {
      language: dom.window.document.getElementById('language'),
      voice: dom.window.document.getElementById('voice'),
      downloadVoice: dom.window.document.getElementById('download'),
      languageStatus: dom.window.document.getElementById('language-status'),
      voiceSettingsSummary: dom.window.document.getElementById('voice-settings-summary'),
      speed: dom.window.document.getElementById('speed'),
      speedOut: dom.window.document.getElementById('speed-out'),
    },
    readerEngineStorage,
    readerEngineSettingsManager: {
      getPlaybackSpeed: () => 1,
      renderSectionPauseSetting: () => {},
      renderHighlightSettings: () => {},
      getSelectedHighlightSettings: () => ({}),
      getSelectedSectionPauseSeconds: () => 0,
    },
    state,
    speechSynthesis: { getVoices: () => [] },
    savePlaybackSettingsSoon: () => {},
  });
  return { controller, dom, readerEngineStorage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete globalThis.document;
});

describe('voice selection persistence (real storage round trip)', () => {
  it('keeps a changed built-in voice selected after the picker is rebuilt at read time', async () => {
    const { controller, dom, readerEngineStorage } = createController();
    controller.bindVoiceSettings();

    await controller.populateVoices();
    const voiceSelect = dom.window.document.getElementById('voice');
    // The picker should default to the rank A Heart voice on a fresh profile.
    expect(voiceSelect.value).toBe('af_heart');
    expect([...voiceSelect.options].some((option) => option.value === 'am_michael')).toBe(true);

    // User picks a different built-in voice.
    voiceSelect.value = 'am_michael';
    voiceSelect.dispatchEvent(new dom.window.Event('change'));
    await flush();

    // It must persist for the language...
    await expect(readerEngineStorage.getStoredVoiceForLanguage('en')).resolves.toBe('am_michael');

    // ...and survive the picker rebuild the read loop performs after language detection.
    await controller.populateVoices();
    expect(voiceSelect.value).toBe('am_michael');
  });
});

describe('voice synthesis forwarding (selected voice reaches the kokoro engine)', () => {
  it('forwards the selected built-in English voice id to the base kokoro model', async () => {
    const calls = [];
    const baseTts = {
      stream(text, options) {
        calls.push(options?.voice);
        return (async function* yieldSegment() {
          yield { text, audio: { audio: new Float32Array(2400), sampling_rate: 24000 } };
        })();
      },
    };
    const tts = createPageNarratorKokoroTts(baseTts);

    const result = await synthesizeSpeechChunk(tts, 'Hello there, friend.', {
      voice: 'am_michael',
      languageCode: 'en',
    });

    expect(result?.blob).toBeTruthy();
    expect(calls, 'the chosen voice must reach the model, not the af_heart default').toContain('am_michael');
    expect(calls).not.toContain('af_heart');
  });
});
