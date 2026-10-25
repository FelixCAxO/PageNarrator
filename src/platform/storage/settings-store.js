import { getDefaultVoiceId, normalizeStoredVoiceId } from '../../lib/voice-registry.js';
import { PLAYBACK_SETTINGS_KEY, savePlaybackSettings } from '../../lib/playback-settings.js';

export async function saveVoiceSelection({ language = 'en', voice = null, storage = globalThis.chrome?.storage?.local } = {}) {
  return savePlaybackSettings({
    language,
    ...(voice ? {
      voice,
      voicesByLanguage: { [language]: voice },
      lastBuiltInVoiceId: voice,
    } : {}),
  }, { storage });
}

export async function savePlaybackSpeed(speed, { storage = globalThis.chrome?.storage?.local } = {}) {
  return savePlaybackSettings({ speed }, { storage });
}

export async function saveReadingCleanupSetting(skipCodeSnippets, { storage = globalThis.chrome?.storage?.local } = {}) {
  return savePlaybackSettings({ skipCodeSnippets: Boolean(skipCodeSnippets) }, { storage });
}

export async function saveIdleReleaseDiagnostic(idleReleaseEnabled, { storage = globalThis.chrome?.storage?.local } = {}) {
  return savePlaybackSettings({ idleReleaseEnabled: idleReleaseEnabled !== false }, { storage });
}

export async function saveTtsDiagnostics(settings = {}, { storage = globalThis.chrome?.storage?.local } = {}) {
  const { ttsPerformanceProfile, ttsBackendPreference } = /** @type {{ ttsPerformanceProfile?: string, ttsBackendPreference?: string }} */ (settings);
  return savePlaybackSettings({
    ...(ttsPerformanceProfile ? { ttsPerformanceProfile } : {}),
    ...(ttsBackendPreference ? { ttsBackendPreference } : {}),
  }, { storage });
}


// Upgrade cleanup only: these keys and this cache belonged to the removed custom voice feature.
const RETIRED_KEYS = ['byoVoiceConfigs.v1', 'byoVoiceUsage.v1', 'byoVoiceColdStartProbe'];

export async function removeRetiredVoiceData({
  storage = globalThis.chrome?.storage?.local,
  cacheStorage = globalThis.caches,
  permissions = globalThis.chrome?.permissions,
} = {}) {
  if (!storage?.get || !storage?.remove) throw new Error('Extension storage is unavailable for voice cleanup.');
  const saved = await storage.get([...RETIRED_KEYS, PLAYBACK_SETTINGS_KEY]);
  const settings = saved[PLAYBACK_SETTINGS_KEY];
  const configs = saved[RETIRED_KEYS[0]];
  const origins = new Set();
  for (const config of Array.isArray(configs) ? configs : []) {
    if (config?.sourceType === 'local-file') continue;
    try {
      const url = new URL(config.sourceUri);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(`${url.protocol}//${url.hostname}/*`);
    } catch { /* Invalid saved endpoints have no host permission to remove. */ }
  }
  if (settings && (String(settings.voice).startsWith('custom-voice:')
    || Object.values(settings.voicesByLanguage || {}).some((voice) => String(voice).startsWith('custom-voice:')))) {
    const voice = normalizeStoredVoiceId(settings.lastBuiltInVoiceId)
      || normalizeStoredVoiceId(settings.voicesByLanguage?.en)
      || normalizeStoredVoiceId(settings.voice)
      || getDefaultVoiceId();
    await savePlaybackSettings({ language: 'en', voice, lastBuiltInVoiceId: voice, voicesByLanguage: { en: voice } }, { storage });
  }
  // Keep configs until dependent cleanup succeeds so a transient failure can be retried.
  await cacheStorage?.delete('pagenarrator-local-voice-models-v1');
  if (origins.size) await permissions?.remove?.({ origins: [...origins] });
  await storage.remove(RETIRED_KEYS);
}
