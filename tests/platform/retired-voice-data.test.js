import { describe, expect, it, vi } from 'vitest';
import { removeRetiredVoiceData } from '../../src/platform/storage/settings-store.js';

function fixture(settings = {}) {
  const data = {
    playbackSettings: { language: 'sv', voice: 'custom-voice:studio', voicesByLanguage: { sv: 'custom-voice:studio', en: 'bf_emma' }, speed: 1.5, ...settings },
    'byoVoiceConfigs.v1': [{ sourceUri: 'https://voice.example.test/tts', apiKey: 'saved-secret' }, { sourceUri: 'invalid' }],
    'byoVoiceUsage.v1': [{ text: 'history' }],
    byoVoiceColdStartProbe: {},
    'pos:https://example.test': { chunkIndex: 4, anchorText: 'Saved position' },
  };
  const storage = {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (values) => Object.assign(data, values)),
    remove: vi.fn(async (keys) => keys.forEach((key) => delete data[key])),
  };
  const cacheStorage = { delete: vi.fn(async () => true) };
  const permissions = { remove: vi.fn(async () => true) };
  return { data, storage, cacheStorage, permissions };
}

describe('retired voice data cleanup', () => {
  it('restores a built-in voice and deletes endpoint secrets, history, and imported model data on upgrade', async () => {
    const input = fixture({ lastBuiltInVoiceId: 'af_bella' });
    await removeRetiredVoiceData(input);
    expect(input.data.playbackSettings).toMatchObject({ language: 'en', voice: 'af_bella', voicesByLanguage: { en: 'af_bella' }, speed: 1.5 });
    expect(JSON.stringify(input.data)).not.toMatch(/custom-voice|saved-secret|byoVoice/);
    expect(input.data['pos:https://example.test']).toEqual({ chunkIndex: 4, anchorText: 'Saved position' });
    expect(input.cacheStorage.delete).toHaveBeenCalledExactlyOnceWith('pagenarrator-local-voice-models-v1');
    expect(input.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: ['https://voice.example.test/*'] });
    await removeRetiredVoiceData(input);
    expect(input.data.playbackSettings.voice).toBe('af_bella');
    expect(input.permissions.remove).toHaveBeenCalledTimes(1);
  });

  it.each([{ lastBuiltInVoiceId: 'unknown', voicesByLanguage: { en: 'bf_emma' } }, { lastBuiltInVoiceId: 'custom-voice:old', voicesByLanguage: {} }])('uses a saved English voice or Heart when the last selection is invalid: %j', async (settings) => {
    const input = fixture(settings);
    await removeRetiredVoiceData(input);
    expect(input.data.playbackSettings.voice).toBe(settings.voicesByLanguage.en || 'af_heart');
  });

  it('preserves a built-in selection and retries dependent cleanup after a cache failure', async () => {
    const input = fixture({ language: 'en', voice: 'af_nicole', voicesByLanguage: { en: 'af_nicole' } });
    input.cacheStorage.delete.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(removeRetiredVoiceData(input)).rejects.toThrow('cache unavailable');
    expect(input.data['byoVoiceConfigs.v1'][0].apiKey).toBe('saved-secret');
    await removeRetiredVoiceData(input);
    expect(input.storage.set).not.toHaveBeenCalled();
    expect(input.data.playbackSettings.voice).toBe('af_nicole');
    expect(input.data['byoVoiceConfigs.v1']).toBeUndefined();
  });
});
