import { DEFAULT_OMNIVOICE_SETTINGS } from '../../src/lib/omnivoice-settings.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';
import { createReaderEngineStorageAdapter } from '../../src/lib/reader-engine-storage-adapter.js';
import { createReaderEngineSettingsManager } from '../../src/lib/reader-engine-settings-manager.js';
import {
  saveIdleReleaseDiagnostic,
  savePlaybackSpeed,
  saveReadingCleanupSetting,
  saveTtsDiagnostics,
  saveVoiceSelection,
} from '../../src/platform/storage/settings-store.js';

function createMemoryStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(key) {
      if (typeof key === 'string') return { [key]: state[key] };
      return { ...state };
    },
    async set(values) {
      Object.assign(state, values);
    },
  };
}

describe('settings store', () => {
  afterEach(() => vi.useRealTimers());

  it('loads saved product and diagnostic fields together through the reader storage adapter', async () => {
    const storage = createMemoryStorage({
      [STORAGE_KEYS.PLAYBACK_SETTINGS]: {
        language: 'sv',
        voice: 'piper-sv-se-nst-medium',
        voicesByLanguage: { sv: 'piper-sv-se-nst-medium' },
        speed: 1.35,
        ttsPerformanceProfile: 'lowPower',
        ttsBackendPreference: 'wasm',
        idleReleaseEnabled: false,
        skipCodeSnippets: true,
      },
    });

    const adapter = createReaderEngineStorageAdapter({ storage });
    await expect(adapter.getPlaybackSettings()).resolves.toEqual({
      ttsEngine: 'kokoro',
      omniVoice: DEFAULT_OMNIVOICE_SETTINGS,
      language: 'sv',
      voice: 'piper-sv-se-nst-medium',
      voicesByLanguage: { sv: 'piper-sv-se-nst-medium' },
      speed: 1.35,
      sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'lowPower',
      ttsBackendPreference: 'wasm',
      idleReleaseEnabled: false,
      skipCodeSnippets: true,
      highlight: {
        area: { color: '#ffdd57', opacity: 0.1 },
        word: { color: '#ffdd57', opacity: 0.38 },
      },
    });
  });

  it('saves voice and speed without changing the playbackSettings storage key', async () => {
    const storage = createMemoryStorage();

    await saveVoiceSelection({ storage, language: 'de', voice: 'piper-de-de-mls-medium' });
    await savePlaybackSpeed(1.8, { storage });

    expect(Object.keys(storage.state)).toEqual([STORAGE_KEYS.PLAYBACK_SETTINGS]);
    expect(storage.state[STORAGE_KEYS.PLAYBACK_SETTINGS]).toMatchObject({
      language: 'de',
      voice: 'piper-de-de-mls-medium',
      voicesByLanguage: { de: 'piper-de-de-mls-medium' },
      speed: 1.8,
    });
  });

  it('saves diagnostic and advanced settings through named store methods', async () => {
    const storage = createMemoryStorage();

    await saveReadingCleanupSetting(true, { storage });
    await saveIdleReleaseDiagnostic(false, { storage });
    await saveTtsDiagnostics({
      ttsPerformanceProfile: 'lowPower',
      ttsBackendPreference: 'wasm',
    }, { storage });

    expect(storage.state[STORAGE_KEYS.PLAYBACK_SETTINGS]).toMatchObject({
      skipCodeSnippets: true,
      idleReleaseEnabled: false,
      ttsPerformanceProfile: 'lowPower',
      ttsBackendPreference: 'wasm',
    });
  });

  it('persists highlight inputs through the settings manager and reader storage adapter', async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const adapter = createReaderEngineStorageAdapter({ storage });
    const save = vi.spyOn(adapter, 'savePlaybackSettings');
    const els = {
      highlightAreaColor: { value: '#00aa55' },
      highlightAreaOpacity: { value: '0.25' },
      highlightWordColor: { value: '#7c3aed' },
      highlightWordOpacity: { value: '0.75' },
      highlightAreaOpacityOut: { textContent: '' },
      highlightWordOpacityOut: { textContent: '' },
    };
    const manager = createReaderEngineSettingsManager({ els, storage: adapter });

    manager.handleHighlightSettingsInput();
    expect(els.highlightAreaOpacityOut.textContent).toBe('25%');
    expect(els.highlightWordOpacityOut.textContent).toBe('75%');
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(save).toHaveBeenCalledTimes(1);
    await save.mock.results[0].value;

    await expect(adapter.getPlaybackSettings()).resolves.toEqual({
      ttsEngine: 'kokoro',
      omniVoice: DEFAULT_OMNIVOICE_SETTINGS,
      language: 'en',
      voice: null,
      voicesByLanguage: {},
      speed: 1,
      sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'auto',
      ttsBackendPreference: 'auto',
      idleReleaseEnabled: true,
      skipCodeSnippets: false,
      highlight: {
        area: { color: '#00aa55', opacity: 0.25 },
        word: { color: '#7c3aed', opacity: 0.75 },
      },
    });
  });

  it('repairs and persists corrupted settings when the reader storage adapter loads them', async () => {
    const storage = createMemoryStorage({
      [STORAGE_KEYS.PLAYBACK_SETTINGS]: {
        language: '',
        speed: 999,
        sectionPauseSeconds: 'invalid',
        ttsPerformanceProfile: 'corrupted-profile',
        ttsBackendPreference: 'quantum',
        idleReleaseEnabled: 'yes',
        skipCodeSnippets: 123,
        highlight: {
          area: { color: 'not-a-hex', opacity: 5 },
          word: { color: '#bad', opacity: -2 },
        },
      },
    });

    const adapter = createReaderEngineStorageAdapter({ storage });
    const repaired = await adapter.getPlaybackSettings();

    expect(repaired).toEqual({
      ttsEngine: 'kokoro',
      omniVoice: DEFAULT_OMNIVOICE_SETTINGS,
      language: 'en',
      voice: null,
      speed: 3,
      sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'auto',
      ttsBackendPreference: 'auto',
      idleReleaseEnabled: true,
      skipCodeSnippets: false,
      voicesByLanguage: {},
      highlight: {
        area: { color: '#ffdd57', opacity: 0.1 },
        word: { color: '#ffdd57', opacity: 0.38 },
      },
    });

    expect(storage.state[STORAGE_KEYS.PLAYBACK_SETTINGS]).toEqual(repaired);
  });

  it('keeps readerEngine product setting writes on the settings-store API', () => {
    const controller = readFileSync(new URL('../../src/lib/reader-engine-voice-settings-controller.js', import.meta.url), 'utf8');
    const session = readFileSync(new URL('../../src/app/reader-engine/reader-engine-session.js', import.meta.url), 'utf8');

    expect(controller).toContain('saveVoiceSelection');
    expect(controller).toContain('savePlaybackSpeed');
    expect(controller).not.toMatch(/readerEngineStorage\.savePlaybackSettings\(\{\s*(language|lastBuiltInVoiceId|speed)/);
    expect(controller).not.toContain('readerEngineStorage.savePlaybackSettings(');
    expect(session).not.toContain('readerEngineStorage.savePlaybackSettings({ skipCodeSnippets');
  });
});

