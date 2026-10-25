import { describe, expect, it, vi } from 'vitest';
import {
  clampSectionPauseSeconds,
  DEFAULT_HIGHLIGHT_SETTINGS,
  DEFAULT_IDLE_RELEASE_ENABLED,
  DEFAULT_SECTION_PAUSE_SECONDS,
  DEFAULT_SKIP_CODE_SNIPPETS,
  DEFAULT_TTS_BACKEND_PREFERENCE,
  formatSectionPauseLabel,
  getPlaybackSettings,
  isPlaybackSettingsCorrupted,
  MAX_SECTION_PAUSE_SECONDS,
  MIN_SECTION_PAUSE_SECONDS,
  normalizeHighlightSettings,
  normalizeTtsBackendPreference,
  repairPlaybackSettings,
  TTS_PERFORMANCE_PROFILE_DEFAULT,
} from '../../src/lib/playback-settings.js';
import {
  createTtsPerformanceGovernor,
  formatTtsPerformanceProfileOptionLabel,
  getTtsPerformanceProfileConfig,
  normalizeTtsPerformanceProfile,
} from '../../src/lib/tts-performance-profile.js';
import {
  saveIdleReleaseDiagnostic,
  saveReadingCleanupSetting,
  saveTtsDiagnostics,
} from '../../src/platform/storage/settings-store.js';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';
import { createReaderEngineSettingsManager } from '../../src/lib/reader-engine-settings-manager.js';
import { createReaderEngineStorageAdapter } from '../../src/lib/reader-engine-storage-adapter.js';

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

describe('Advanced Settings: Verification, Ease of Change & Self-Repair', () => {
  describe('1. Section Pauses (sectionPauseSeconds)', () => {
    it('works: clamps values and produces accurate timing labels', () => {
      expect(clampSectionPauseSeconds(0)).toBe(0);
      expect(formatSectionPauseLabel(0)).toBe('Normal');

      expect(clampSectionPauseSeconds(-2.5)).toBe(-2.5);
      expect(formatSectionPauseLabel(-2.5)).toBe('Faster');

      expect(clampSectionPauseSeconds(1.5)).toBe(1.5);
      expect(formatSectionPauseLabel(1.5)).toBe('1.5s slower');

      expect(clampSectionPauseSeconds(3)).toBe(3);
      expect(formatSectionPauseLabel(3)).toBe('3s slower');
    });

    it('is easily changed: updates UI outputs and persists via manager and reader storage adapter', async () => {
      const storage = createMemoryStorage();
      const adapter = createReaderEngineStorageAdapter({ storage });
      const els = {
        sectionPause: { value: '0' },
        sectionPauseOut: { textContent: '' },
      };
      const reschedule = vi.fn();
      const saveFn = vi.spyOn(adapter, 'savePlaybackSettings');
      const manager = createReaderEngineSettingsManager({
        els,
        storage: adapter,
        rescheduleCurrentSectionTiming: reschedule,
      });

      manager.setSectionPause(2.5);
      expect(saveFn).toHaveBeenCalledTimes(1);
      expect(saveFn).toHaveBeenLastCalledWith({ sectionPauseSeconds: 2.5 });
      await saveFn.mock.results[0].value;
      expect((await adapter.getPlaybackSettings()).sectionPauseSeconds).toBe(2.5);
      expect(els.sectionPause.value).toBe('2.5');
      expect(els.sectionPauseOut.textContent).toBe('2.5s slower');
      expect(reschedule).toHaveBeenCalledTimes(1);

      manager.setSectionPause(-1.2);
      expect(saveFn).toHaveBeenCalledTimes(2);
      await saveFn.mock.results[1].value;
      expect(els.sectionPause.value).toBe('-1.2');
      expect(els.sectionPauseOut.textContent).toBe('Faster');
      expect(saveFn).toHaveBeenCalledWith({ sectionPauseSeconds: -1.2 });
      expect(reschedule).toHaveBeenCalledTimes(2);
      expect((await adapter.getPlaybackSettings()).sectionPauseSeconds).toBe(-1.2);
    });

    it('self-repairs: clamps extreme out-of-range values and fixes malformed non-numbers', () => {
      expect(clampSectionPauseSeconds(999)).toBe(MAX_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds(-999)).toBe(MIN_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds('corrupted')).toBe(DEFAULT_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds(null)).toBe(DEFAULT_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds(undefined)).toBe(DEFAULT_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds(NaN)).toBe(DEFAULT_SECTION_PAUSE_SECONDS);
      expect(clampSectionPauseSeconds({})).toBe(DEFAULT_SECTION_PAUSE_SECONDS);
    });
  });

  describe('2. TTS Performance Profile (ttsPerformanceProfile)', () => {
    it('works: configures profile settings and labels across all supported tiers', () => {
      const profiles = ['auto', 'quality', 'balanced', 'lowPower'];
      for (const profile of profiles) {
        expect(normalizeTtsPerformanceProfile(profile)).toBe(profile);
        const config = getTtsPerformanceProfileConfig(profile);
        expect(config).toBeDefined();
        expect(config.maxChunkLength).toBeGreaterThan(0);
        expect(typeof config.preloadAhead).toBe('number');
      }

      expect(formatTtsPerformanceProfileOptionLabel('quality')).toBe('High quality');
      expect(formatTtsPerformanceProfileOptionLabel('balanced')).toBe('Balanced');
      expect(formatTtsPerformanceProfileOptionLabel('lowPower')).toBe('Battery saver');
    });

    it('is easily changed: updates governor state and persists to storage', async () => {
      const storage = createMemoryStorage();
      await saveTtsDiagnostics({ ttsPerformanceProfile: 'lowPower' }, { storage });

      const settings = await getPlaybackSettings({ storage });
      expect(settings.ttsPerformanceProfile).toBe('lowPower');

      const governor = createTtsPerformanceGovernor({ setting: 'quality' });
      expect(governor.requestedProfile()).toBe('quality');
      expect(governor.currentProfile()).toBe('quality');
    });

    it('self-repairs: normalizes invalid, misspelled, or non-string profile options to auto', () => {
      expect(normalizeTtsPerformanceProfile('turbo')).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
      expect(normalizeTtsPerformanceProfile('ultra_fast')).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
      expect(normalizeTtsPerformanceProfile(12345)).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
      expect(normalizeTtsPerformanceProfile(null)).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
      expect(normalizeTtsPerformanceProfile(undefined)).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
      expect(normalizeTtsPerformanceProfile({})).toBe(TTS_PERFORMANCE_PROFILE_DEFAULT);
    });
  });

  describe('3. TTS Backend Preference (ttsBackendPreference)', () => {
    it('works: accepts valid backend options', () => {
      expect(normalizeTtsBackendPreference('auto')).toBe('auto');
      expect(normalizeTtsBackendPreference('webgpu')).toBe('webgpu');
      expect(normalizeTtsBackendPreference('wasm')).toBe('wasm');
    });

    it('is easily changed: saves and reads from storage smoothly', async () => {
      const storage = createMemoryStorage();
      await saveTtsDiagnostics({ ttsBackendPreference: 'wasm' }, { storage });

      const settings = await getPlaybackSettings({ storage });
      expect(settings.ttsBackendPreference).toBe('wasm');
    });

    it('self-repairs: gracefully falls back to auto on invalid backend preferences', () => {
      expect(normalizeTtsBackendPreference('directx')).toBe(DEFAULT_TTS_BACKEND_PREFERENCE);
      expect(normalizeTtsBackendPreference('vulkan')).toBe(DEFAULT_TTS_BACKEND_PREFERENCE);
      expect(normalizeTtsBackendPreference(null)).toBe(DEFAULT_TTS_BACKEND_PREFERENCE);
      expect(normalizeTtsBackendPreference(undefined)).toBe(DEFAULT_TTS_BACKEND_PREFERENCE);
      expect(normalizeTtsBackendPreference(99)).toBe(DEFAULT_TTS_BACKEND_PREFERENCE);
    });
  });

  describe('4. Idle Release Memory (idleReleaseEnabled)', () => {
    it('works: stores and checks boolean states correctly', async () => {
      const storage = createMemoryStorage();
      await saveIdleReleaseDiagnostic(true, { storage });
      let settings = await getPlaybackSettings({ storage });
      expect(settings.idleReleaseEnabled).toBe(true);

      await saveIdleReleaseDiagnostic(false, { storage });
      settings = await getPlaybackSettings({ storage });
      expect(settings.idleReleaseEnabled).toBe(false);
    });

    it('is easily changed: updates diagnostic toggle through storage API', async () => {
      const storage = createMemoryStorage();
      const adapter = createReaderEngineStorageAdapter({ storage });
      await adapter.savePlaybackSettings({ idleReleaseEnabled: false });
      const settings = await adapter.getPlaybackSettings();
      expect(settings.idleReleaseEnabled).toBe(false);
    });

    it('self-repairs: resets invalid non-boolean types to default true', () => {
      const repaired = repairPlaybackSettings({ idleReleaseEnabled: 'invalid_string' });
      expect(repaired.idleReleaseEnabled).toBe(DEFAULT_IDLE_RELEASE_ENABLED);

      const repairedNumber = repairPlaybackSettings({ idleReleaseEnabled: 0 });
      expect(repairedNumber.idleReleaseEnabled).toBe(DEFAULT_IDLE_RELEASE_ENABLED);
    });
  });

  describe('5. Skip Code Snippets (skipCodeSnippets)', () => {
    it('works: stores and checks boolean flag', async () => {
      const storage = createMemoryStorage();
      await saveReadingCleanupSetting(true, { storage });
      const settings = await getPlaybackSettings({ storage });
      expect(settings.skipCodeSnippets).toBe(true);
    });

    it('is easily changed: toggles easily through storage helper', async () => {
      const storage = createMemoryStorage();
      await saveReadingCleanupSetting(false, { storage });
      let settings = await getPlaybackSettings({ storage });
      expect(settings.skipCodeSnippets).toBe(false);

      await saveReadingCleanupSetting(true, { storage });
      settings = await getPlaybackSettings({ storage });
      expect(settings.skipCodeSnippets).toBe(true);
    });

    it('self-repairs: resets invalid non-boolean types to default false', () => {
      const repaired = repairPlaybackSettings({ skipCodeSnippets: 'yes' });
      expect(repaired.skipCodeSnippets).toBe(DEFAULT_SKIP_CODE_SNIPPETS);

      const repairedNull = repairPlaybackSettings({ skipCodeSnippets: null });
      expect(repairedNull.skipCodeSnippets).toBe(DEFAULT_SKIP_CODE_SNIPPETS);
    });
  });

  describe('6. Highlight Styles (highlight: { area, word })', () => {
    it('works: normalizes valid hex colors and opacities', () => {
      const custom = {
        area: { color: '#00aa55', opacity: 0.2 },
        word: { color: '#7c3aed', opacity: 0.8 },
      };
      expect(normalizeHighlightSettings(custom)).toEqual(custom);
    });

    it('is easily changed: debounces inputs, renders outputs, and triggers live updates', () => {
      vi.useFakeTimers();
      const savePlaybackSettings = vi.fn();
      const configurePageHighlight = vi.fn(() => Promise.resolve());
      const els = {
        highlightAreaColor: { value: '#123456' },
        highlightAreaOpacity: { value: '0.4' },
        highlightWordColor: { value: '#654321' },
        highlightWordOpacity: { value: '0.7' },
        highlightAreaOpacityOut: { textContent: '' },
        highlightWordOpacityOut: { textContent: '' },
      };
      const manager = createReaderEngineSettingsManager({
        els,
        storage: { savePlaybackSettings },
        configurePageHighlight,
        debounceMs: 100,
      });

      manager.handleHighlightSettingsInput();
      expect(els.highlightAreaOpacityOut.textContent).toBe('40%');
      expect(els.highlightWordOpacityOut.textContent).toBe('70%');

      vi.advanceTimersByTime(100);
      expect(savePlaybackSettings).toHaveBeenCalledWith({
        highlight: {
          area: { color: '#123456', opacity: 0.4 },
          word: { color: '#654321', opacity: 0.7 },
        },
      });
      expect(configurePageHighlight).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('self-repairs: heals invalid hex codes, out-of-bounds opacities, and missing parts to defaults', () => {
      const brokenHighlight = {
        area: { color: 'blue', opacity: 99 },
        word: { color: '#123', opacity: -5 },
      };
      expect(normalizeHighlightSettings(brokenHighlight)).toEqual(DEFAULT_HIGHLIGHT_SETTINGS);

      const partialHighlight = {
        area: { color: '#00ff00' },
      };
      expect(normalizeHighlightSettings(partialHighlight)).toEqual({
        area: { color: '#00ff00', opacity: DEFAULT_HIGHLIGHT_SETTINGS.area.opacity },
        word: DEFAULT_HIGHLIGHT_SETTINGS.word,
      });

      const nullHighlight = normalizeHighlightSettings(null);
      expect(nullHighlight).toEqual(DEFAULT_HIGHLIGHT_SETTINGS);
    });
  });

  describe('8. Automated Storage Self-Repair Engine', () => {
    it('detects corruption accurately with isPlaybackSettingsCorrupted', () => {
      expect(isPlaybackSettingsCorrupted(null)).toBe(true);
      expect(isPlaybackSettingsCorrupted('string')).toBe(true);
      expect(isPlaybackSettingsCorrupted({ language: '' })).toBe(true);
      expect(isPlaybackSettingsCorrupted({ speed: 'fast' })).toBe(true);
      expect(isPlaybackSettingsCorrupted({
        language: 'en',
        voice: 'af_heart',
        speed: 1,
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
      })).toBe(false);
    });

    it('auto-repairs corrupted storage records in-place without data loss', async () => {
      const storage = createMemoryStorage({
        [STORAGE_KEYS.PLAYBACK_SETTINGS]: {
          language: 'de',
          speed: 1.5,
          sectionPauseSeconds: 9999, // Corrupted
          ttsPerformanceProfile: 'nonexistent', // Corrupted
          highlight: 'not-an-object', // Corrupted
          skipCodeSnippets: 'maybe', // Corrupted
          idleReleaseEnabled: null, // Corrupted
        },
      });

      const settings = await getPlaybackSettings({ storage, autoRepair: true });

      // Valid fields preserved
      expect(settings.language).toBe('de');
      expect(settings.speed).toBe(1.5);

      // Corrupted fields repaired
      expect(settings.sectionPauseSeconds).toBe(5);
      expect(settings.ttsPerformanceProfile).toBe('auto');
      expect(settings.highlight).toEqual(DEFAULT_HIGHLIGHT_SETTINGS);
      expect(settings.skipCodeSnippets).toBe(false);
      expect(settings.idleReleaseEnabled).toBe(true);

      // Storage record healed
      expect(storage.state[STORAGE_KEYS.PLAYBACK_SETTINGS]).toEqual(settings);
    });
  });
});
