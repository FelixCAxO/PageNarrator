import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReaderEngineVoiceSettingsController } from '../../src/lib/reader-engine-voice-settings-controller.js';
import { getReaderEngineSettingsElements } from '../../src/ui/reader-engine/elements/settings-elements.js';

describe('reader engine voice settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores a failed engine switch without overwriting the other engine\'s saved voice', async () => {
    const dom = new JSDOM(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
    vi.stubGlobal('document', dom.window.document);
    const els = getReaderEngineSettingsElements(dom.window.document);
    const state = { selectedLanguageCode: 'en', setSelectedLanguageCode(value) { this.selectedLanguageCode = value; } };
    const savePlaybackSettingsSoon = vi.fn();
    const controller = createReaderEngineVoiceSettingsController({ els, state, savePlaybackSettingsSoon,
      readerEngineStorage: { getStoredVoiceForLanguage: async () => 'am_michael' } });
    const omniVoice = { gender: 'male', variation: 8, whisper: true };
    controller.renderVoiceEngineSetting({ ttsEngine: 'omnivoice', omniVoice });
    await controller.populateVoices();

    // OmniVoice failed to load while Kokoro kept reading.
    await controller.restoreVoiceSelection({ id: 'am_michael', engine: 'kokoro', lang: 'en-US' });
    expect(savePlaybackSettingsSoon).toHaveBeenLastCalledWith({ ttsEngine: 'kokoro', language: 'en', voice: 'am_michael' });
    expect(controller.resolveSelectedVoice().id).toBe('am_michael');
    expect(els.omniVoiceVariation.value).toBe('8');

    // Kokoro failed to load while OmniVoice kept reading.
    await controller.restoreVoiceSelection({ id: 'omnivoice:sv', engine: 'omnivoice', detectCode: 'sv', omniVoice });
    expect(savePlaybackSettingsSoon).toHaveBeenLastCalledWith({ ttsEngine: 'omnivoice', language: 'sv', omniVoice });
    expect(controller.resolveSelectedVoice()).toMatchObject({ engine: 'omnivoice', detectCode: 'sv', omniVoice });
    dom.window.close();
  });

  it('restores OmniVoice controls, saves slider changes, and returns to the saved Kokoro voice', async () => {
    const dom = new JSDOM(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
    vi.stubGlobal('document', dom.window.document);
    const els = getReaderEngineSettingsElements(dom.window.document);
    const state = { selectedLanguageCode: 'en', setSelectedLanguageCode(value) { this.selectedLanguageCode = value; } };
    const savePlaybackSettingsSoon = vi.fn();
    const controller = createReaderEngineVoiceSettingsController({ els, state, savePlaybackSettingsSoon,
      readerEngineStorage: { getStoredVoiceForLanguage: async () => 'am_michael' } });
    controller.renderVoiceEngineSetting({});
    await controller.populateVoices();
    controller.bindVoiceSettings();
    expect(controller.resolveSelectedVoice().id).toBe('am_michael');
    expect(els.omniVoiceSettings.hidden).toBe(true);
    expect(els.ttsEngine.closest('details')).toBeNull();
    expect(els.readerSettings.open).toBe(false);
    els.ttsEngine.value = 'omnivoice';
    els.ttsEngine.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect(savePlaybackSettingsSoon).toHaveBeenCalledWith({ ttsEngine: 'omnivoice', language: 'en' }));
    expect(els.language.options).toHaveLength(646);
    expect([...els.language.options].map(option => option.value)).toContain('yue');
    expect(els.omniVoiceSettings.hidden).toBe(false);
    expect(els.readerSettings.open).toBe(true);
    expect(els.voiceEngineHelp.textContent).toContain('1.35 GB');
    expect(els.kokoroRequirements.hidden).toBe(true);
    expect(els.voice.closest('label').hidden).toBe(true);
    const firstVoiceId = controller.resolveSelectedVoice().id;
    expect(dom.window.document.getElementById('omnivoice-pitch')).toBeNull();
    expect(dom.window.document.getElementById('omnivoice-age')).toBeNull();
    els.omniVoiceVariation.value = '4';
    els.omniVoiceVariation.dispatchEvent(new dom.window.Event('input'));
    expect(els.omniVoiceVariationOut.textContent).toBe('4 / 10');
    expect(savePlaybackSettingsSoon).toHaveBeenLastCalledWith({ omniVoice: { gender: 'female', variation: 4, whisper: false } });
    expect(controller.resolveSelectedVoice().id).not.toBe(firstVoiceId);
    const saved = { ttsEngine: 'omnivoice', omniVoice: { gender: 'male', variation: 8, whisper: true } };
    controller.renderVoiceEngineSetting(saved);
    expect(controller.resolveSelectedVoice().omniVoice).toEqual(saved.omniVoice);
    expect(els.omniVoiceVariation.value).toBe('8');
    controller.renderVoiceEngineSetting({ ttsEngine: 'kokoro' });
    await controller.populateVoices();
    expect(controller.resolveSelectedVoice().id).toBe('am_michael');
    expect(els.omniVoiceSettings.hidden).toBe(true);
    expect(els.language.closest('label').hidden).toBe(true);
    expect(els.kokoroRequirements.hidden).toBe(false);
    dom.window.close();
  });

  it.each(['auto', 'quality', 'balanced', 'lowPower'])('keeps %s GPU-first unless CPU is explicitly selected', (ttsPerformanceProfile) => {
    const controller = createReaderEngineVoiceSettingsController({ els: {}, state: {}, navigator: { gpu: {} } });
    controller.resetTtsPerformanceGovernor({ ttsPerformanceProfile, ttsBackendPreference: 'auto' });
    expect(controller.shouldForceWasmVoiceModel()).toBe(false);
    controller.renderTtsBackendPreferenceSetting('wasm');
    expect(controller.shouldForceWasmVoiceModel()).toBe(true);
    controller.renderTtsBackendPreferenceSetting('webgpu');
    expect(controller.shouldForceWasmVoiceModel()).toBe(false);
  });

  it('renders only English Kokoro voices', async () => {
    const dom = new JSDOM('<select id="language"></select><select id="voice"></select><p id="status"></p>');
    const els = {
      language: dom.window.document.getElementById('language'),
      voice: dom.window.document.getElementById('voice'),
      languageStatus: dom.window.document.getElementById('status'),
    };
    vi.stubGlobal('document', dom.window.document);
    const controller = createReaderEngineVoiceSettingsController({
      els,
      readerEngineStorage: { getStoredVoiceForLanguage: async () => null },
      documentRef: dom.window.document,
      state: { settings: { language: 'en', voice: 'af_heart' } },
    });

    controller.populateLanguageOptions();
    await controller.populateVoices();

    expect([...els.language.options].map((option) => option.value)).toEqual(['en']);
    expect([...els.voice.options]).toHaveLength(10);
    expect([...els.voice.options].map((option) => option.value)).toContain('af_heart');
  });
});
