import { expect, it, vi } from 'vitest';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';
import { getOmniVoicePresetSeed, getOmniVoicePresetNumStep, hasOmniVoicePresetGenderCue, getOmniVoicePresetGuidanceScale, getOmniVoicePresetSpeed, getOmniVoicePresetPronunciationVariant } from '../../src/tts/omnivoice/preset-seeds.js';

vi.mock('../../src/tts/omnivoice/preset-seeds.js', () => ({ getOmniVoicePresetSeed: vi.fn(() => 73), getOmniVoicePresetNumStep: vi.fn(() => 48), hasOmniVoicePresetGenderCue: vi.fn(() => false), getOmniVoicePresetGuidanceScale: vi.fn(() => 3), getOmniVoicePresetSpeed: vi.fn(() => .85), getOmniVoicePresetPronunciationVariant: vi.fn(() => null) }));

it('keeps measured seed and step settings across documents and whisper', () => {
  const voice = { detectCode: 'sv', omniVoice: { gender: 'female', variation: 8 } };
  for (const [text, whisper] of [['First document.', false], ['Another document.', false], ['Whisper document.', true], ['你好。', false]]) {
    const request = createOmniVoiceRequest(text, { ...voice, omniVoice: { ...voice.omniVoice, whisper } });
    expect(request).toMatchObject({ lang: 'sv', speakerId: 'female-8', seed: 73, numStep: 48, guidanceScale: 3, speed: .85, instruct: '' });
  }
  expect(getOmniVoicePresetSeed).toHaveBeenCalledTimes(4);
  expect(getOmniVoicePresetSeed).toHaveBeenLastCalledWith('sv', 'female', 8);
  expect(getOmniVoicePresetNumStep).toHaveBeenCalledTimes(4);
  expect(getOmniVoicePresetNumStep).toHaveBeenLastCalledWith('sv', 'female', 8);
  expect(hasOmniVoicePresetGenderCue).toHaveBeenCalledTimes(4);
  expect(getOmniVoicePresetGuidanceScale).toHaveBeenCalledTimes(4);
  expect(getOmniVoicePresetSpeed).toHaveBeenCalledTimes(4);
  expect(getOmniVoicePresetSpeed).toHaveBeenLastCalledWith('sv', 'female', 8);
});

it('keeps default guidance implicit in the factory request', () => {
  getOmniVoicePresetGuidanceScale.mockReturnValueOnce(2);
  expect(createOmniVoiceRequest('Another document.', { detectCode: 'sv', omniVoice: { gender: 'female', variation: 8 } })).not.toHaveProperty('guidanceScale');
});

it('preserves measured pronunciation across documents and whisper without changing their text', () => {
  for (const [text, whisper] of [['您好。', false], ['您嘅書喺枱面。', false], ['您好。', true], ['另一篇文章。', false]]) {
    getOmniVoicePresetPronunciationVariant.mockReturnValueOnce('yue-nei5');
    const result = createOmniVoiceRequest(text, { detectCode: 'yue', omniVoice: { gender: 'female', variation: 4, whisper } });
    expect(result).toMatchObject({ text, lang: 'yue', speakerId: 'female-4', pronunciationVariant: 'yue-nei5' });
    expect(result.whisper ?? false).toBe(whisper);
  }
  expect(createOmniVoiceRequest('Another document.', { detectCode: 'en', omniVoice: {} })).not.toHaveProperty('pronunciationVariant');
});
