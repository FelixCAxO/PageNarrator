import { expect, it } from 'vitest';
import { assertOmniVoiceAudio } from '../../src/tts/omnivoice/audio-quality.js';

const tone = (hz, level = 0.2) => Float32Array.from({ length: 24000 }, (_, i) => level * Math.sin(2 * Math.PI * hz * i / 24000));

it('rejects invalid samples, silence, clipping and broadband static', () => {
  let state = 42;
  const staticAudio = Float32Array.from({ length: 24000 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 0.5;
  });
  for (const pcm of [new Float32Array(), Float32Array.of(NaN), Float32Array.of(Infinity),
    new Float32Array(24000), new Float32Array(24000).fill(0.1), new Float32Array(24000).fill(1), tone(200, 4), staticAudio]) {
    expect(() => assertOmniVoiceAudio(pcm, 24000)).toThrow(expect.objectContaining({ name: 'OmniVoiceAudioQualityError' }));
  }
  expect(() => assertOmniVoiceAudio(tone(200), 48000)).toThrow('format');
});

it('allows quiet and ordinary voiced signals with pauses', () => {
  for (const level of [0.2, 0.0001]) {
    const pcm = tone(240, level);
    pcm.fill(0, 0, 4800);
    expect(() => assertOmniVoiceAudio(pcm, 24000)).not.toThrow();
  }
});
