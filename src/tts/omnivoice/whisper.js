// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const RATE = 24000;
const FRAME = 720;
const HOP = 180;
const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));

/** @param {number} seed */
function gaussianSource(seed) {
  let state = seed >>> 0;
  /** @returns {number} */
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return (((value ^ value >>> 14) >>> 0) + 0.5) / 4294967296;
  };
  /** @type {number|null} */
  let spare = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const radius = Math.sqrt(-2 * Math.log(uniform())), angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/** Keep the selected speaker's vocal-tract envelope and replace periodic excitation with breath noise.
 * @param {Float32Array} pcm @param {number} seed @param {string} lang */
export function renderOmniVoiceWhisper(pcm, seed, lang) {
  if (!(pcm instanceof Float32Array) || !Number.isInteger(seed)) throw new Error('Invalid whisper audio or seed.');
  if (!pcm.length) return new Float32Array();
  const vietnamese = lang === 'vi';
  const order = vietnamese ? 20 : lang === 'is' ? 32 : 24, deemphasis = vietnamese ? 0.65 : 0.75;
  const cutoff = vietnamese ? 150 : 200;
  // A quiet voiced component retains Cantonese tone cues under the breath excitation.
  const voicedMix = lang === 'yue' ? 0.3 : 0;
  const length = pcm.length + 2 * FRAME;
  const pre = new Float64Array(length), accumulation = new Float64Array(length), weights = new Float64Array(length);
  const windowed = new Float64Array(FRAME), noise = new Float64Array(FRAME);
  const correlation = new Float64Array(order + 1), coefficients = new Float64Array(order + 1), next = new Float64Array(order + 1);
  const gaussian = gaussianSource(seed);
  let previous = 0, sourceEnergy = 0;
  for (let i = 0; i < pcm.length; i++) {
    const value = pcm[i];
    if (!Number.isFinite(value)) throw new Error('Whisper requires finite audio.');
    sourceEnergy += value * value;
    pre[i + FRAME] = value - 0.95 * previous;
    previous = value;
  }
  pre[pcm.length + FRAME] = -0.95 * previous;
  for (let start = 0; start < length - FRAME; start += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const value = pre[start + i];
      windowed[i] = value * WINDOW[i]; energy += value * value;
      weights[start + i] += WINDOW[i];
    }
    if (energy === 0) continue;
    for (let lag = 0; lag <= order; lag++) {
      let value = 0;
      for (let i = lag; i < FRAME; i++) value += windowed[i] * windowed[i - lag];
      correlation[lag] = value;
    }
    correlation[0] += Math.max(correlation[0] * 1e-4, 1e-10);
    coefficients.fill(0); coefficients[0] = 1;
    let error = correlation[0];
    for (let degree = 1; degree <= order; degree++) {
      let value = correlation[degree];
      for (let j = 1; j < degree; j++) value += coefficients[j] * correlation[degree - j];
      const reflection = Math.max(-0.999, Math.min(0.999, -value / Math.max(error, 1e-20)));
      next[0] = 1; next[degree] = reflection;
      for (let j = 1; j < degree; j++) next[j] = coefficients[j] + reflection * coefficients[degree - j];
      coefficients.set(next.subarray(0, degree + 1));
      error *= 1 - reflection * reflection;
    }
    for (let j = 1; j <= order; j++) coefficients[j] *= 0.97 ** j;
    let noiseEnergy = 0;
    for (let i = 0; i < FRAME; i++) {
      let value = gaussian();
      for (let j = 1; j <= Math.min(order, i); j++) value -= coefficients[j] * noise[i - j];
      noise[i] = value; noiseEnergy += value * value;
    }
    const gain = Math.sqrt(energy / Math.max(1e-12, noiseEnergy));
    for (let i = 0; i < FRAME; i++) accumulation[start + i] += noise[i] * gain * WINDOW[i];
  }
  const restored = new Float64Array(pcm.length);
  previous = 0;
  for (let i = 0; i < length; i++) {
    previous = accumulation[i] / Math.max(weights[i], 1e-6) + deemphasis * previous;
    if (i >= FRAME && i < FRAME + pcm.length) restored[i - FRAME] = previous;
  }
  const k = Math.tan(Math.PI * cutoff / RATE), norm = 1 / (1 + Math.SQRT2 * k + k * k);
  const a1 = 2 * (k * k - 1) * norm, a2 = (1 - Math.SQRT2 * k + k * k) * norm;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, convertedEnergy = 0;
  for (let i = 0; i < restored.length; i++) {
    const x = restored[i], y = norm * (x - 2 * x1 + x2) - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    restored[i] = y; convertedEnergy += y * y;
  }
  const gain = Math.sqrt((sourceEnergy / pcm.length) / Math.max(1e-12, convertedEnergy / pcm.length));
  return Float32Array.from(restored, (value, i) => 0.35 * Math.max(-0.98, Math.min(0.98, (1 - voicedMix) * value * gain + voicedMix * pcm[i])));
}
