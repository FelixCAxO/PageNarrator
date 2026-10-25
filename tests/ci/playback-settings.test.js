import { DEFAULT_OMNIVOICE_SETTINGS } from '../../src/lib/omnivoice-settings.js';
import { describe, expect, it } from 'vitest';
import {
  clampPlaybackSpeed,
  clampSectionPauseSeconds,
  DEFAULT_HIGHLIGHT_SETTINGS,
  DEFAULT_IDLE_RELEASE_ENABLED,
  DEFAULT_SECTION_PAUSE_SECONDS,
  DEFAULT_SKIP_CODE_SNIPPETS,
  TTS_PERFORMANCE_PROFILE_DEFAULT,
  formatSectionPauseLabel,
  getPlaybackSettings,
  getMaxPlaybackSpeed,
  MAX_SECTION_PAUSE_SECONDS,
  MIN_SECTION_PAUSE_SECONDS,
  PLAYBACK_SETTINGS_KEY,
  getStoredVoiceForLanguage,
  normalizeHighlightSettings,
  savePlaybackSettings,
  saveSelectedVoice,
} from '../../src/lib/playback-settings.js';

describe('clampPlaybackSpeed', () => {
  it('keeps a normal speed value untouched', () => {
    expect(clampPlaybackSpeed('1.25')).toBe(1.25);
    expect(clampPlaybackSpeed(0.75)).toBe(0.75);
  });

  it('clamps below 0.5x to 0.5x', () => {
    expect(clampPlaybackSpeed(0.1)).toBe(0.5);
    expect(clampPlaybackSpeed('0')).toBe(0.5);
  });

  it('clamps above 3x to 3x', () => {
    expect(clampPlaybackSpeed(5)).toBe(3);
    expect(clampPlaybackSpeed('10')).toBe(3);
  });

  it('allows playback speed up to 3x', () => {
    expect(getMaxPlaybackSpeed()).toBe(3);
    expect(clampPlaybackSpeed(2.75)).toBe(2.75);
    expect(clampPlaybackSpeed(4)).toBe(3);
  });

  it('falls back to 1x when given garbage', () => {
    expect(clampPlaybackSpeed('not a number')).toBe(1);
    expect(clampPlaybackSpeed(null)).toBe(1);
    expect(clampPlaybackSpeed(undefined)).toBe(1);
    expect(clampPlaybackSpeed(NaN)).toBe(1);
  });
});

describe('highlight customization settings', () => {
  it('normalizes separate area and word colors and opacities', () => {
    expect(normalizeHighlightSettings({
      area: { color: '#00aa55', opacity: '0.42' },
      word: { color: '#7c3aed', opacity: 0.68 },
    })).toEqual({
      area: { color: '#00aa55', opacity: 0.42 },
      word: { color: '#7c3aed', opacity: 0.68 },
    });
  });

  it('falls back to the default yellow highlight style for invalid values', () => {
    expect(normalizeHighlightSettings({
      area: { color: 'green', opacity: 4 },
      word: { color: '#bad', opacity: -1 },
    })).toEqual(DEFAULT_HIGHLIGHT_SETTINGS);
  });
});

describe('section pause settings', () => {
  it('keeps section pacing between faster, normal, and five seconds slower', () => {
    expect(DEFAULT_SECTION_PAUSE_SECONDS).toBe(0);
    expect(MIN_SECTION_PAUSE_SECONDS).toBe(-5);
    expect(MAX_SECTION_PAUSE_SECONDS).toBe(5);
    expect(clampSectionPauseSeconds(0)).toBe(0);
    expect(clampSectionPauseSeconds('-2.5')).toBe(-2.5);
    expect(clampSectionPauseSeconds('2.35')).toBe(2.35);
    expect(clampSectionPauseSeconds(8)).toBe(5);
    expect(clampSectionPauseSeconds(-8)).toBe(-5);
    expect(clampSectionPauseSeconds('not a number')).toBe(0);
  });

  it('formats section pacing labels around the centered Normal point', () => {
    expect(formatSectionPauseLabel(-1.5)).toBe('Faster');
    expect(formatSectionPauseLabel(0)).toBe('Normal');
    expect(formatSectionPauseLabel(2)).toBe('2s slower');
    expect(formatSectionPauseLabel(2.35)).toBe('2.4s slower');
  });
});

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

function createYieldingSnapshotStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(key) {
      const snapshot = { ...state };
      await Promise.resolve();
      return { [key]: snapshot[key] };
    },
    async set(values) {
      Object.assign(state, values);
    },
  };
}

describe('playback settings storage', () => {
  it('persists language, default voice, per-language voices, and clamped speed in chrome storage', async () => {
    const storage = createMemoryStorage();

    await savePlaybackSettings({
      language: 'sv',
      voice: 'piper-sv-se-nst-medium',
      speed: '1.75',
    }, { storage });
    await saveSelectedVoice('de', 'piper-de-de-mls-medium', { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toEqual({
      ttsEngine: 'kokoro',
      omniVoice: DEFAULT_OMNIVOICE_SETTINGS,
      language: 'sv',
      voice: 'piper-de-de-mls-medium',
      speed: 1.75,
      sectionPauseSeconds: DEFAULT_SECTION_PAUSE_SECONDS,
      highlight: DEFAULT_HIGHLIGHT_SETTINGS,
      skipCodeSnippets: DEFAULT_SKIP_CODE_SNIPPETS,
      idleReleaseEnabled: DEFAULT_IDLE_RELEASE_ENABLED,
      ttsPerformanceProfile: TTS_PERFORMANCE_PROFILE_DEFAULT,
      ttsBackendPreference: 'auto',
      voicesByLanguage: {
        sv: 'piper-sv-se-nst-medium',
        de: 'piper-de-de-mls-medium',
      },
    });
    await expect(getStoredVoiceForLanguage('sv', { storage })).resolves.toBe('piper-sv-se-nst-medium');
    await expect(getStoredVoiceForLanguage('de', { storage })).resolves.toBe('piper-de-de-mls-medium');
  });

  it('normalizes missing or invalid stored settings to safe defaults', async () => {
    const storage = createMemoryStorage({
      playbackSettings: {
        language: '',
        voice: '',
        speed: 99,
        sectionPauseSeconds: 99,
        ttsPerformanceProfile: 'fast',
        voicesByLanguage: { sv: 'piper-sv-se-nst-medium' },
      },
    });

    await expect(getPlaybackSettings({ storage })).resolves.toEqual({
      ttsEngine: 'kokoro',
      omniVoice: DEFAULT_OMNIVOICE_SETTINGS,
      language: 'en',
      voice: null,
      speed: 3,
      sectionPauseSeconds: 5,
      highlight: DEFAULT_HIGHLIGHT_SETTINGS,
      skipCodeSnippets: DEFAULT_SKIP_CODE_SNIPPETS,
      idleReleaseEnabled: DEFAULT_IDLE_RELEASE_ENABLED,
      ttsPerformanceProfile: TTS_PERFORMANCE_PROFILE_DEFAULT,
      ttsBackendPreference: 'auto',
      voicesByLanguage: { sv: 'piper-sv-se-nst-medium' },
    });
  });

  it('stores TTS performance profile with standard playback settings', async () => {
    const storage = createMemoryStorage();

    await savePlaybackSettings({
      ttsPerformanceProfile: 'lowPower',
    }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      ttsPerformanceProfile: 'lowPower',
    });

    await savePlaybackSettings({
      ttsPerformanceProfile: 'invalid',
    }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      ttsPerformanceProfile: TTS_PERFORMANCE_PROFILE_DEFAULT,
    });
  });

  it('stores the TTS backend preference with standard playback settings', async () => {
    const storage = createMemoryStorage();

    await savePlaybackSettings({ ttsBackendPreference: 'wasm' }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      ttsBackendPreference: 'wasm',
    });

    await savePlaybackSettings({ ttsBackendPreference: 'invalid' }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      ttsBackendPreference: 'auto',
    });
  });

  it('stores cleanup, highlight settings, section pause, and 3x speed for everyone', async () => {
    const storage = createMemoryStorage();

    await savePlaybackSettings({
      speed: 2.85,
      sectionPauseSeconds: 3.4,
      skipCodeSnippets: true,
      highlight: {
        area: { color: '#00aa55', opacity: 0.45 },
        word: { color: '#7c3aed', opacity: 0.72 },
      },
    }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      speed: 2.85,
      sectionPauseSeconds: 3.4,
      skipCodeSnippets: true,
      highlight: {
        area: { color: '#00aa55', opacity: 0.45 },
        word: { color: '#7c3aed', opacity: 0.72 },
      },
    });
    await savePlaybackSettings({ voice: 'af_heart' }, { storage });

    await expect(getPlaybackSettings({ storage })).resolves.toMatchObject({
      speed: 2.85,
      sectionPauseSeconds: 3.4,
      voice: 'af_heart',
      skipCodeSnippets: true,
      highlight: {
        area: { color: '#00aa55', opacity: 0.45 },
        word: { color: '#7c3aed', opacity: 0.72 },
      },
      ttsPerformanceProfile: TTS_PERFORMANCE_PROFILE_DEFAULT,
    });
  });

  // Some supported Node versions lack this browser API; retain native coverage where available.
  it.skipIf(typeof globalThis.navigator?.locks?.request !== 'function')('loses none of 1,000 concurrent speed and section-pause writes under native Web Locks', async () => {
    expect(globalThis.navigator?.locks?.request).toEqual(expect.any(Function));

    let losses = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const storage = createYieldingSnapshotStorage();
      await Promise.all([
        savePlaybackSettings({ speed: 1.75 }, { storage }),
        savePlaybackSettings({ sectionPauseSeconds: 2 }, { storage }),
      ]);

      const saved = storage.state[PLAYBACK_SETTINGS_KEY];
      if (saved.speed !== 1.75 || saved.sectionPauseSeconds !== 2) losses += 1;
    }

    expect(losses).toBe(0);
  });
});
