import { expect, it, vi } from 'vitest';
import { deletePersonalVoiceReference, listPersonalVoiceReferences, savePersonalVoiceReference } from '../../src/platform/storage/personal-voice-store.js';
import { getPlaybackSettings, savePlaybackSettings } from '../../src/lib/playback-settings.js';

function storage() {
  const records = {};
  return { get: vi.fn(async key => ({ [key]: structuredClone(records[key]) })),
    set: vi.fn(async patch => Object.assign(records, structuredClone(patch))) };
}

it('keeps separate personal presets across reads and deletes only the selected one', async () => {
  const local = storage();
  const sample = { lang: 'sv', text: 'Det här är ett ljudprov.', frames: 76, codes: new Uint16Array(8 * 76).fill(511) };
  const first = await savePersonalVoiceReference({ ...sample, name: '  Min röst  ' }, local);
  const second = await savePersonalVoiceReference({ ...sample, name: 'En annan röst' }, local);
  expect(first).toMatchObject({ name: 'Min röst', lang: 'sv', hash: second.hash, frames: 76 });
  expect(first.id).not.toEqual(second.id);
  expect(await listPersonalVoiceReferences(local)).toEqual([first, second]);
  await expect(savePersonalVoiceReference({ ...sample, name: 'Ogiltig', codes: new Uint16Array(608).fill(1024) }, local)).rejects.toThrow(/personal voice reference/i);
  await deletePersonalVoiceReference(first.id, local);
  expect(await listPersonalVoiceReferences(local)).toEqual([second]);
});

it('clears the selected clone when deleting it and rejects a stale selection without changing other settings', async () => {
  const local = storage();
  const sample = { name: 'Min röst', lang: 'sv', text: 'Det här är ett ljudprov.', frames: 76, codes: new Uint16Array(8 * 76).fill(511) };
  const reference = await savePersonalVoiceReference(sample, local);
  const selection = { ttsEngine: 'omnivoice-clone', personalVoiceId: reference.id, language: 'sv' };
  await savePlaybackSettings({ ...selection, speed: 1.5 }, { storage: local });
  await deletePersonalVoiceReference(reference.id, local);
  expect(await getPlaybackSettings({ storage: local })).not.toHaveProperty('personalVoiceId');
  await expect(savePlaybackSettings(selection, { storage: local })).rejects.toThrow(/personal voice preset/i);
  expect(await getPlaybackSettings({ storage: local })).toMatchObject({ ttsEngine: 'omnivoice-clone', speed: 1.5, language: 'sv' });
});

it.skipIf(typeof navigator.locks?.request !== 'function')('serializes preset deletion with a selection that starts before deletion completes', async () => {
  const local = storage();
  const reference = await savePersonalVoiceReference({ name: 'Voice', lang: 'en', text: 'A voice sample.',
    frames: 76, codes: new Uint16Array(8 * 76).fill(511) }, local);
  const results = await Promise.allSettled([
    deletePersonalVoiceReference(reference.id, local),
    savePlaybackSettings({ ttsEngine: 'omnivoice-clone', personalVoiceId: reference.id }, { storage: local }),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(await getPlaybackSettings({ storage: local })).not.toHaveProperty('personalVoiceId');
  expect(await listPersonalVoiceReferences(local)).toEqual([]);
});
