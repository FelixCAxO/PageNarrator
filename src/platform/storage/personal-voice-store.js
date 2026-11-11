// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { isPersonalVoiceReference } from '../../tts/omnivoice/personal-reference.js';
import { PERSONAL_VOICE_REFERENCES_KEY as STORAGE_KEY, PLAYBACK_SETTINGS_KEY, withPlaybackSettingsWriteLock } from './playback-settings-storage.js';

const MAX_PRESETS = 24;

/** @typedef {{id:string, name:string, lang:string, text:string, frames:number, codes:number[], hash:string}} PersonalVoiceReference */

/** @returns {Promise<PersonalVoiceReference[]>} */
export async function listPersonalVoiceReferences(storage = globalThis.chrome?.storage?.local) {
  const saved = (await storage?.get?.(STORAGE_KEY))?.[STORAGE_KEY];
  return Array.isArray(saved) ? saved.filter(isPersonalVoiceReference) : [];
}

/** @param {{name:string, lang:string, text:string, frames:number, codes:Uint16Array}} sample */
export async function savePersonalVoiceReference(sample, storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get || !storage?.set) throw new Error('Local voice storage is unavailable.');
  const write = storage.set.bind(storage);
  const { name, lang, text, frames, codes } = sample;
  if (!(codes instanceof Uint16Array) || codes.length > 8 * 250) throw new Error('Invalid OmniVoice personal voice reference.');
  const bytes = new DataView(new ArrayBuffer(codes.length * 8));
  codes.forEach((code, index) => bytes.setBigUint64(index * 8, BigInt(code), true));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const reference = { id: `clone:${crypto.randomUUID()}`, name: name.trim(), lang, text: text.trim(), frames, codes: Array.from(codes), hash };
  if (!isPersonalVoiceReference(reference)) throw new Error('Invalid OmniVoice personal voice reference.');
  return withPlaybackSettingsWriteLock(async () => {
    const saved = await listPersonalVoiceReferences(storage);
    if (saved.length >= MAX_PRESETS) throw new Error('Delete a voice preset before creating another.');
    await write({ [STORAGE_KEY]: [...saved, reference] });
    return reference;
  });
}

/** @param {string} id */
export async function deletePersonalVoiceReference(id, storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get || !storage?.set) throw new Error('Local voice storage is unavailable.');
  const get = storage.get.bind(storage);
  const set = storage.set.bind(storage);
  await withPlaybackSettingsWriteLock(async () => {
    const saved = await listPersonalVoiceReferences(storage);
    const settings = (await get(PLAYBACK_SETTINGS_KEY))[PLAYBACK_SETTINGS_KEY];
    const { personalVoiceId, ...remaining } = settings ?? {};
    await set({ [STORAGE_KEY]: saved.filter(reference => reference.id !== id),
      ...(personalVoiceId === id ? { [PLAYBACK_SETTINGS_KEY]: remaining } : {}) });
  });
}
