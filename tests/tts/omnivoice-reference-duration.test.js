import { expect, it } from 'vitest';
import { estimateOmniVoiceFrames } from '../../src/tts/omnivoice/runtime.js';

it.each(['recording', 'recording-derived'])('calibrates target pace from the complete %s reference', durationSource => {
  const reference = { durationSource, text: 'abcdefgh', frames: 200 };
  expect(estimateOmniVoiceFrames(reference.text, 1, reference)).toBe(200);
  expect(estimateOmniVoiceFrames('abcd', 1, reference)).toBe(100);
  expect(estimateOmniVoiceFrames('abcd', 1.25, reference)).toBe(80);
});

it('keeps the short-text duration boost and rounds only the final target', () => {
  const reference = { durationSource: 'recording', text: 'abcdefghijklmnop', frames: 100 };
  expect(estimateOmniVoiceFrames('abcd', 1, reference)).toBe(39);
  expect(estimateOmniVoiceFrames('abcd', 1.5, reference)).toBe(26);
});

it.each([
  { generationSpeed: 0.8, frames: 250 },
  { generationSpeed: 1.25, frames: 160 },
])('applies speed once when a refreshed card was generated at $generationSpeed', ({ generationSpeed, frames }) => {
  const reference = {
    durationSource: 'recording-derived', text: 'abcdefgh', frames,
    source: { generation: { speed: generationSpeed } },
  };
  expect(estimateOmniVoiceFrames(reference.text, generationSpeed, reference)).toBe(frames);
  expect(estimateOmniVoiceFrames(reference.text, 1, reference)).toBe(200);
  expect(estimateOmniVoiceFrames('abcd', 1, reference)).toBe(100);
});

it('preserves generated-reference durations without calibrating from rounded frames', () => {
  const text = 'Today we are reading a short story.';
  const reference = { text: 'A bundled generated reference.', frames: 131 };
  expect(estimateOmniVoiceFrames(text, 1, reference)).toBe(estimateOmniVoiceFrames(text, 1));
  expect(estimateOmniVoiceFrames(text, 1, { ...reference, durationSource: 'generated' })).toBe(estimateOmniVoiceFrames(text, 1));
});
