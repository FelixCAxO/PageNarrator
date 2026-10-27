import { t } from './i18n.js';
import { STORAGE_KEYS } from './storage-keys.js';
import { normalizeOmniVoiceSettings } from './omnivoice-settings.js';
import {
  TTS_PERFORMANCE_PROFILE_DEFAULT,
  normalizeTtsPerformanceProfile,
} from './tts-performance-profile.js';

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3.0;
export const PLAYBACK_SETTINGS_KEY = STORAGE_KEYS.PLAYBACK_SETTINGS;
const PLAYBACK_SETTINGS_WRITE_LOCK = 'pagenarrator:playback-settings';
export const DEFAULT_SECTION_PAUSE_SECONDS = 0;
export const MIN_SECTION_PAUSE_SECONDS = -5;
export const MAX_SECTION_PAUSE_SECONDS = 5;
export const DEFAULT_HIGHLIGHT_SETTINGS = Object.freeze({
  area: Object.freeze({ color: '#ffdd57', opacity: 0.1 }),
  word: Object.freeze({ color: '#ffdd57', opacity: 0.38 }),
});
export const DEFAULT_SKIP_CODE_SNIPPETS = false;
export const DEFAULT_IDLE_RELEASE_ENABLED = true;
export const DEFAULT_TTS_BACKEND_PREFERENCE = 'auto';
const TTS_BACKEND_PREFERENCES = Object.freeze(['auto', 'webgpu', 'wasm']);
export { TTS_PERFORMANCE_PROFILE_DEFAULT };

export function getMaxPlaybackSpeed() {
  return MAX_SPEED;
}

export function clampPlaybackSpeed(value, options = {}) {
  const speed = Number.parseFloat(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.max(MIN_SPEED, Math.min(getMaxPlaybackSpeed(options), speed));
}

export function clampSectionPauseSeconds(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return DEFAULT_SECTION_PAUSE_SECONDS;
  return Math.max(MIN_SECTION_PAUSE_SECONDS, Math.min(MAX_SECTION_PAUSE_SECONDS, seconds));
}

export function formatSectionPauseLabel(sectionPauseSeconds) {
  const value = clampSectionPauseSeconds(sectionPauseSeconds);
  if (value === DEFAULT_SECTION_PAUSE_SECONDS) return t("Normal");
  if (value < DEFAULT_SECTION_PAUSE_SECONDS) return t('Faster');

  const seconds = value.toFixed(value % 1 === 0 ? 0 : 1);
  return t("$1s slower", [seconds]);
}

export function normalizeTtsBackendPreference(value) {
  const preference = String(value || '').trim();
  return TTS_BACKEND_PREFERENCES.includes(preference) ? preference : DEFAULT_TTS_BACKEND_PREFERENCE;
}

export function normalizeHighlightSettings(settings = {}) {
  return {
    area: normalizeHighlightPart(settings?.area, DEFAULT_HIGHLIGHT_SETTINGS.area),
    word: normalizeHighlightPart(settings?.word, DEFAULT_HIGHLIGHT_SETTINGS.word),
  };
}

export async function getPlaybackSettings({ storage = globalThis.chrome?.storage?.local, autoRepair = true } = {}) {
  const current = storage?.get ? await storage.get(PLAYBACK_SETTINGS_KEY) : {};
  const raw = current?.[PLAYBACK_SETTINGS_KEY];
  const normalized = normalizePlaybackSettings(
    /** @type {Record<string, unknown>} */ (isPlainObject(raw) ? raw : {}),
  );
  if (autoRepair && typeof storage?.set === 'function' && isPlaybackSettingsCorrupted(raw)) {
    try {
      // Re-read under the write lock: a save may have landed since the corrupt read, and a
      // blind write of the stale snapshot would revert it.
      return await withPlaybackSettingsWriteLock(async () => {
        const latest = (await storage.get(PLAYBACK_SETTINGS_KEY))?.[PLAYBACK_SETTINGS_KEY];
        const repaired = normalizePlaybackSettings(
          /** @type {Record<string, unknown>} */ (isPlainObject(latest) ? latest : {}),
        );
        if (isPlaybackSettingsCorrupted(latest)) await storage.set({ [PLAYBACK_SETTINGS_KEY]: repaired });
        return repaired;
      });
    } catch {
      // Best-effort storage repair
    }
  }
  return normalized;
}

function withPlaybackSettingsWriteLock(task) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(PLAYBACK_SETTINGS_WRITE_LOCK, task) : task();
}

export async function savePlaybackSettings(settings, { storage = globalThis.chrome?.storage?.local } = {}) {
  if (!storage?.get || !storage?.set) throw new Error('chrome.storage.local is required to save playback settings.');

  const write = async () => {
    const stored = await storage.get(PLAYBACK_SETTINGS_KEY);
    const raw = /** @type {Record<string, unknown>} */ (
      isPlainObject(stored?.[PLAYBACK_SETTINGS_KEY]) ? stored[PLAYBACK_SETTINGS_KEY] : {}
    );
    const settingsObject = /** @type {Record<string, unknown>} */ (isPlainObject(settings) ? settings : {});
    const hasSetting = (name) => Object.prototype.hasOwnProperty.call(settingsObject, name);
    const next = {
      ttsEngine: normalizeTtsEngine(hasSetting('ttsEngine') ? settingsObject.ttsEngine : raw.ttsEngine),
      omniVoice: normalizeOmniVoiceSettings(hasSetting('omniVoice') ? settingsObject.omniVoice : raw.omniVoice),
      language: normalizeLanguageSetting(hasSetting('language') ? settingsObject.language : raw.language),
      voice: normalizeVoiceSetting(hasSetting('voice') ? settingsObject.voice : raw.voice),
      speed: hasSetting('speed')
        ? clampPlaybackSpeed(settingsObject.speed)
        : clampPlaybackSpeed(raw.speed),
      sectionPauseSeconds: hasSetting('sectionPauseSeconds')
        ? clampSectionPauseSeconds(settingsObject.sectionPauseSeconds)
        : clampSectionPauseSeconds(raw.sectionPauseSeconds),
      ttsPerformanceProfile: hasSetting('ttsPerformanceProfile')
        ? normalizeTtsPerformanceProfile(settingsObject.ttsPerformanceProfile)
        : normalizeTtsPerformanceProfile(raw.ttsPerformanceProfile),
      voicesByLanguage: normalizeVoicesByLanguage({
        .../** @type {Record<string, unknown>} */ (isPlainObject(raw.voicesByLanguage) ? raw.voicesByLanguage : {}),
        .../** @type {Record<string, unknown>} */ (isPlainObject(settingsObject.voicesByLanguage) ? settingsObject.voicesByLanguage : {}),
      }),
      idleReleaseEnabled: hasSetting('idleReleaseEnabled')
        ? normalizeBooleanSetting(settingsObject.idleReleaseEnabled, DEFAULT_IDLE_RELEASE_ENABLED)
        : normalizeBooleanSetting(raw.idleReleaseEnabled, DEFAULT_IDLE_RELEASE_ENABLED),
      ttsBackendPreference: hasSetting('ttsBackendPreference')
        ? normalizeTtsBackendPreference(settingsObject.ttsBackendPreference)
        : normalizeTtsBackendPreference(raw.ttsBackendPreference),
    };
    const lastBuiltInVoiceId = normalizeVoiceSetting(hasSetting('lastBuiltInVoiceId')
      ? settingsObject.lastBuiltInVoiceId
      : raw.lastBuiltInVoiceId);
    if (lastBuiltInVoiceId) next.lastBuiltInVoiceId = lastBuiltInVoiceId;

    if (settingsObject?.language && settingsObject?.voice) {
      next.voicesByLanguage[next.language] = next.voice;
    }

    if (hasSetting('highlight')) {
      next.highlight = normalizeHighlightSettings(settingsObject.highlight);
    } else if (isPlainObject(raw.highlight)) {
      next.highlight = normalizeHighlightSettings(raw.highlight);
    }

    if (hasSetting('skipCodeSnippets')) {
      next.skipCodeSnippets = normalizeBooleanSetting(settingsObject.skipCodeSnippets);
    } else if (typeof raw.skipCodeSnippets === 'boolean') {
      next.skipCodeSnippets = raw.skipCodeSnippets;
    }

    await storage.set({ [PLAYBACK_SETTINGS_KEY]: next });
    return normalizePlaybackSettings(next);
  };

  return withPlaybackSettingsWriteLock(write);
}

export async function saveSelectedVoice(language, voice, { storage = globalThis.chrome?.storage?.local } = {}) {
  const normalizedLanguage = normalizeLanguageSetting(language);
  const normalizedVoice = normalizeVoiceSetting(voice);
  return savePlaybackSettings({
    voice: normalizedVoice,
    voicesByLanguage: normalizedVoice ? { [normalizedLanguage]: normalizedVoice } : {},
  }, { storage });
}

export async function getStoredVoiceForLanguage(language, { storage = globalThis.chrome?.storage?.local } = {}) {
  const settings = await getPlaybackSettings({ storage });
  return settings.voicesByLanguage[normalizeLanguageSetting(language)] || settings.voice;
}

/**
 * @param {Record<string, unknown>} settings
 */
export function normalizePlaybackSettings(settings = {}) {
  const language = normalizeLanguageSetting(settings?.language);
  const normalized = {
    ttsEngine: normalizeTtsEngine(settings?.ttsEngine),
    omniVoice: normalizeOmniVoiceSettings(settings?.omniVoice, language),
    language,
    voice: normalizeVoiceSetting(settings?.voice),
    speed: clampPlaybackSpeed(settings?.speed),
    sectionPauseSeconds: clampSectionPauseSeconds(settings?.sectionPauseSeconds),
    highlight: normalizeHighlightSettings(settings?.highlight),
    skipCodeSnippets: normalizeBooleanSetting(settings?.skipCodeSnippets),
    idleReleaseEnabled: normalizeBooleanSetting(settings?.idleReleaseEnabled, DEFAULT_IDLE_RELEASE_ENABLED),
    ttsPerformanceProfile: normalizeTtsPerformanceProfile(settings?.ttsPerformanceProfile),
    ttsBackendPreference: normalizeTtsBackendPreference(settings?.ttsBackendPreference),
    voicesByLanguage: normalizeVoicesByLanguage(settings?.voicesByLanguage),
  };
  const lastBuiltInVoiceId = normalizeVoiceSetting(settings?.lastBuiltInVoiceId);
  if (lastBuiltInVoiceId) normalized.lastBuiltInVoiceId = lastBuiltInVoiceId;
  return normalized;
}

export function repairPlaybackSettings(settings = {}) {
  return normalizePlaybackSettings(isPlainObject(settings) ? settings : {});
}

export function isPlaybackSettingsCorrupted(raw) {
  if (!isPlainObject(raw)) return true;
  if (typeof raw.language !== 'string' || !raw.language.trim()) return true;
  if (raw.voice !== null && (typeof raw.voice !== 'string' || !raw.voice.trim())) return true;
  if (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed) || raw.speed < MIN_SPEED || raw.speed > MAX_SPEED) return true;
  if (typeof raw.sectionPauseSeconds !== 'number' || !Number.isFinite(raw.sectionPauseSeconds) || raw.sectionPauseSeconds < MIN_SECTION_PAUSE_SECONDS || raw.sectionPauseSeconds > MAX_SECTION_PAUSE_SECONDS) return true;
  if (!['auto', 'quality', 'balanced', 'lowPower'].includes(raw.ttsPerformanceProfile)) return true;
  if (!['auto', 'webgpu', 'wasm'].includes(raw.ttsBackendPreference)) return true;
  if (typeof raw.idleReleaseEnabled !== 'boolean') return true;
  if (typeof raw.skipCodeSnippets !== 'boolean') return true;
  if (!isPlainObject(raw.highlight) || !isPlainObject(raw.highlight.area) || !isPlainObject(raw.highlight.word)) return true;
  if (!normalizeHexColor(raw.highlight.area.color) || !normalizeHexColor(raw.highlight.word.color)) return true;
  if (typeof raw.highlight.area.opacity !== 'number' || !Number.isFinite(raw.highlight.area.opacity) || raw.highlight.area.opacity < 0 || raw.highlight.area.opacity > 1) return true;
  if (typeof raw.highlight.word.opacity !== 'number' || !Number.isFinite(raw.highlight.word.opacity) || raw.highlight.word.opacity < 0 || raw.highlight.word.opacity > 1) return true;
  if (!isPlainObject(raw.voicesByLanguage)) return true;
  return false;
}

export function normalizeLanguageSetting(language) {
  const value = String(language || '').trim();
  return value || 'en';
}

export function normalizeTtsEngine(engine) {
  return engine === 'omnivoice' ? 'omnivoice' : 'kokoro';
}

export function normalizeVoiceSetting(voice) {
  const value = String(voice || '').trim();
  return value && !value.startsWith('custom-voice:') ? value : null;
}

export function normalizeVoicesByLanguage(voicesByLanguage) {
  return isPlainObject(voicesByLanguage)
    ? Object.fromEntries(Object.entries(voicesByLanguage).filter(([, value]) => normalizeVoiceSetting(value)))
    : {};
}

export function normalizeHighlightPart(part, fallback) {
  return {
    color: normalizeHexColor(part?.color) || fallback.color,
    opacity: normalizeOpacity(part?.opacity, fallback.opacity),
  };
}

export function normalizeHexColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

export function normalizeOpacity(value, fallback) {
  const opacity = Number.parseFloat(value);
  return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : fallback;
}

export function normalizeBooleanSetting(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

