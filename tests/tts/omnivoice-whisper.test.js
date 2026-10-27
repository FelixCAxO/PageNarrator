import { expect, it } from 'vitest';
import { renderOmniVoiceWhisper } from '../../src/tts/omnivoice/whisper.js';

const speech = Float32Array.from({ length: 24000 }, (_, i) => {
  const t = i / 24000, envelope = t < 0.1 || t > 0.9 ? 0 : Math.sin(Math.PI * (t - 0.1) / 0.8);
  return envelope * (0.12 * Math.sin(2 * Math.PI * 150 * t) + 0.04 * Math.sin(2 * Math.PI * 600 * t) + 0.02 * Math.sin(2 * Math.PI * 1500 * t));
});
const rms = pcm => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);

it.each(['sv','yue','vi'])('preserves timing, input and useful signal levels for %s with independently seeded breath excitation', lang => {
  const before = speech.slice(), result = renderOmniVoiceWhisper(speech, 42, lang);
  expect(result).toHaveLength(speech.length);
  expect(speech).toEqual(before);
  expect(result.every(value => Number.isFinite(value) && Math.abs(value) <= 0.981)).toBe(true);
  expect(rms(result) / rms(speech)).toBeGreaterThan(0.2);
  expect(rms(result) / rms(speech)).toBeLessThan(0.4);
  expect(renderOmniVoiceWhisper(speech, 42, lang)).toEqual(result);
  expect(renderOmniVoiceWhisper(speech, 43, lang)).not.toEqual(result);
});

it('removes dominant voiced periodicity while keeping silence silent', () => {
  const periodicity = pcm => {
    let product = 0, energy = 0;
    for (let i = 4800; i < 19200; i++) { product += pcm[i] * pcm[i - 160]; energy += pcm[i] * pcm[i]; }
    return product / energy;
  };
  expect(periodicity(speech)).toBeGreaterThan(0.95);
  expect(periodicity(renderOmniVoiceWhisper(speech, 42, 'sv'))).toBeLessThan(0.5);
  expect(renderOmniVoiceWhisper(new Float32Array(2400), 42, 'sv').every(value => value === 0)).toBe(true);
  expect(() => renderOmniVoiceWhisper(Float32Array.of(NaN), 42, 'sv')).toThrow('finite');
});
