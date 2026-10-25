import { expect, it, vi } from 'vitest';
import { synthesizeSpeechChunk } from '../../src/lib/speech-audio.js';

it('preserves exhausted OmniVoice quality failures instead of retrying split text again', async () => {
  const error = Object.assign(new Error('OmniVoice returned invalid audio (broadband static).'), { name: 'OmniVoiceAudioQualityError' });
  const tts = { generate: vi.fn().mockRejectedValue(error) };
  await expect(synthesizeSpeechChunk(tts, 'Det här är en hel mening. Här kommer nästa mening.', {
    voice: { engine: 'omnivoice', detectCode: 'sv' }, languageCode: 'sv',
  })).rejects.toBe(error);
  expect(tts.generate).toHaveBeenCalledOnce();
});
