import {
  getPlaybackSettings,
  getStoredVoiceForLanguage,
  savePlaybackSettings,
} from './playback-settings.js';

/**
 * Creates the readerEngine storage boundary around chrome.storage.local.
 * @param {{ storage?: { get?: Function, set?: Function, remove?: Function } }} options
 */
export function createReaderEngineStorageAdapter({
  storage = globalThis.chrome?.storage?.local,
} = {}) {
  return {
    rawStorage: storage,
    get: (key) => storage.get(key),
    set: (value) => storage.set(value),
    remove: (key) => storage.remove(key),
    getPlaybackSettings: () => getPlaybackSettings({ storage }),
    savePlaybackSettings: (settings) => savePlaybackSettings(settings, { storage }),
    getStoredVoiceForLanguage: (language) => getStoredVoiceForLanguage(language, { storage }),
  };
}
