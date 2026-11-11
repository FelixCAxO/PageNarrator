/** Serialize writes that can change the playback settings or their personal voice references.
 * @template T @param {() => Promise<T>} write @returns {Promise<T>} */
export function withPlaybackSettingsWriteLock(write) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('pagenarrator:playback-settings', write) : write();
}
export const PLAYBACK_SETTINGS_KEY = 'playbackSettings';
export const PERSONAL_VOICE_REFERENCES_KEY = 'omnivoicePersonalReferences.v1';
