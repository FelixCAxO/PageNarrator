// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// SeamlessM4T's Kaldi log-mel front end for Sidon's w2v-BERT predictor.
export const SIDON_INPUT_RATE = 16_000;
export const SIDON_OUTPUT_RATE = 48_000;
export const SIDON_FEATURE_WIDTH = 160;
const FFT = 512;
const WINDOW = 400;
const HOP = 160;
const MEL_BINS = 80;
/** @param {number} frequency */
const mel = frequency => 1127 * Math.log1p(frequency / 700);
const melStart = mel(20);
const melStep = (mel(SIDON_INPUT_RATE / 2) - melStart) / (MEL_BINS + 1);
const melWeights = Array.from({ length: FFT / 2 }, (_, bin) => {
  const position = (mel(bin * SIDON_INPUT_RATE / FFT) - melStart) / melStep;
  return { left: Math.floor(position) - 1, fraction: position - Math.floor(position) };
});
const povey = Float64Array.from({ length: WINDOW }, (_, i) => (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1))) ** 0.85);
const cos = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / FFT));
const sin = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / FFT));
const bitReversed = Uint16Array.from({ length: FFT }, (_, i) => {
  let reversed = 0;
  for (let bit = 1; bit < FFT; bit *= 2) {
    reversed = 2 * reversed + i % 2;
    i >>= 1;
  }
  return reversed;
});

/** @param {Float64Array} real @param {Float64Array} imaginary */
function fftInPlace(real, imaginary) {
  for (let width = 2; width <= FFT; width *= 2) {
    const half = width / 2;
    for (let start = 0; start < FFT; start += width) {
      for (let j = 0; j < half; j++) {
        const a = start + j, b = a + half, k = j * FFT / width;
        const re = real[b] * cos[k] - imaginary[b] * sin[k];
        const im = real[b] * sin[k] + imaginary[b] * cos[k];
        real[b] = real[a] - re;
        imaginary[b] = imaginary[a] - im;
        real[a] += re;
        imaginary[a] += im;
      }
    }
  }
}

/** @param {Float32Array} pcm 16 kHz mono PCM, padded by the caller. */
export function sidonFeatures(pcm) {
  const frames = 1 + Math.floor((pcm.length - WINDOW) / HOP);
  if (frames < 2) throw new RangeError('Sidon needs at least two feature frames.');
  const features = new Float32Array(Math.ceil(frames / 2) * SIDON_FEATURE_WIDTH);
  const real = new Float64Array(FFT), imaginary = new Float64Array(FFT);
  const bands = new Float64Array(MEL_BINS);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * HOP;
    let mean = 0;
    for (let j = 0; j < WINDOW; j++) mean += pcm[start + j];
    mean /= WINDOW;
    let previous = pcm[start] - mean;
    real.fill(0);
    imaginary.fill(0);
    for (let j = 0; j < WINDOW; j++) {
      const sample = pcm[start + j] - mean;
      real[bitReversed[j]] = (sample - 0.97 * previous) * povey[j] * 32768;
      previous = sample;
    }
    fftInPlace(real, imaginary);
    bands.fill(0);
    for (let bin = 0; bin < melWeights.length; bin++) {
      const { left, fraction } = melWeights[bin];
      const power = real[bin] ** 2 + imaginary[bin] ** 2;
      if (left >= 0 && left < MEL_BINS) bands[left] += power * (1 - fraction);
      if (left + 1 >= 0 && left + 1 < MEL_BINS) bands[left + 1] += power * fraction;
    }
    for (let bin = 0; bin < MEL_BINS; bin++) features[frame * MEL_BINS + bin] = Math.log(Math.max(2 ** -23, bands[bin]));
  }
  for (let bin = 0; bin < MEL_BINS; bin++) {
    let mean = 0, variance = 0;
    for (let frame = 0; frame < frames; frame++) mean += features[frame * MEL_BINS + bin];
    mean /= frames;
    for (let frame = 0; frame < frames; frame++) variance += (features[frame * MEL_BINS + bin] - mean) ** 2;
    const deviation = Math.sqrt(variance / (frames - 1) + 1e-7);
    for (let frame = 0; frame < frames; frame++) {
      const index = frame * MEL_BINS + bin;
      features[index] = (features[index] - mean) / deviation;
    }
  }
  if (frames % 2) features.fill(1, frames * MEL_BINS);
  return features;
}
