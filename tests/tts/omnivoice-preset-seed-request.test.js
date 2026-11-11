import { afterEach, expect, it, vi } from 'vitest';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';
import * as presetIndex from '../../src/tts/omnivoice/preset-seeds.js';

const real = presetIndex.getOmniVoicePreset;
/** Measured playback settings, as the registry would freeze them for one voice. */
const measure = overrides => vi.spyOn(presetIndex, 'getOmniVoicePreset').mockImplementation(id => { const found = real(id); return found && { ...found, ...overrides }; });
afterEach(() => vi.restoreAllMocks());

it('keeps measured seed and step settings across documents and whisper', () => {
  const [id] = presetIndex.getOmniVoiceVoices('sv', 'female');
  measure({ seed: 73, numStep: 48, genderCue: false, guidanceScale: 3, speed: .85 });
  const voice = { detectCode: 'sv', omniVoice: { gender: 'female', voices: { sv: id } } };
  for (const [text, whisper] of [['First document.', false], ['Another document.', false], ['Whisper document.', true], ['你好。', false]]) {
    const request = createOmniVoiceRequest(text, { ...voice, omniVoice: { ...voice.omniVoice, whisper } });
    expect(request).toMatchObject({ lang: 'sv', speakerId: id, seed: 73, numStep: 48, guidanceScale: 3, speed: .85, instruct: '' });
  }
});

it('keeps default guidance implicit in the factory request', () => {
  measure({ guidanceScale: 2 });
  expect(createOmniVoiceRequest('Another document.', { detectCode: 'sv', omniVoice: { gender: 'female', variation: 8 } })).not.toHaveProperty('guidanceScale');
});

it('preserves measured pronunciation across documents and whisper without changing their text', () => {
  measure({ pronunciationVariant: 'yue-nei5' });
  const id = presetIndex.getOmniVoiceVoices('yue', 'female').at(-1);
  for (const [text, whisper] of [['您好。', false], ['您嘅書喺枱面。', false], ['您好。', true], ['另一篇文章。', false]]) {
    const result = createOmniVoiceRequest(text, { detectCode: 'yue', omniVoice: { gender: 'female', voices: { yue: id }, whisper } });
    expect(result).toMatchObject({ text, lang: 'yue', speakerId: id, pronunciationVariant: 'yue-nei5' });
    expect(result.whisper ?? false).toBe(whisper);
  }
  vi.restoreAllMocks();
  expect(createOmniVoiceRequest('Another document.', { detectCode: 'en', omniVoice: {} })).not.toHaveProperty('pronunciationVariant');
});
