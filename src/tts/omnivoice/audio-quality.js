// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

// The 24 kHz decoder emits 40 ms of audio per code frame.
export const OMNIVOICE_SAMPLES_PER_FRAME = 960;

/** Locate sustained acoustic activity in codec frames. @param {Float32Array} pcm */
export function findOmniVoiceSpeechBounds(pcm) {
  const size = OMNIVOICE_SAMPLES_PER_FRAME;
  const energies = new Float64Array(Math.floor(pcm.length / size));
  let peak = 0;
  for (let frame = 0; frame < energies.length; frame += 1) {
    let energy = 0;
    for (let index = frame * size; index < (frame + 1) * size; index += 1) energy += pcm[index] ** 2;
    energies[frame] = energy / size;
    peak = Math.max(peak, energies[frame]);
  }
  if (!Number.isFinite(peak)) return null;
  // Require two adjacent active frames so a click does not define a speech edge.
  const threshold = Math.max(0.002 ** 2, peak * 0.02 ** 2);
  let first = -1, end = 0;
  for (let frame = 1; frame < energies.length; frame += 1) {
    if (energies[frame - 1] < threshold || energies[frame] < threshold) continue;
    if (first < 0) first = frame - 1;
    end = frame + 1;
  }
  return first < 0 ? null : { first, end };
}

/** Keep a short margin for soft consonants and natural phrasing.
 * @template {ArrayBufferLike} Buffer
 * @param {Float32Array<Buffer>} pcm @param {number} [minimumSamples] */
export function trimOmniVoicePlaybackEdges(pcm, minimumSamples = 0) {
  const bounds = findOmniVoiceSpeechBounds(pcm);
  if (!bounds) return pcm;
  const size = OMNIVOICE_SAMPLES_PER_FRAME;
  const start = Math.max(0, bounds.first - 3) * size;
  const end = Math.min(pcm.length, (bounds.end + 3) * size);
  const length = Math.min(pcm.length, Math.max(end - start, minimumSamples));
  const extraBefore = Math.floor((length - (end - start)) / 2);
  const offset = Math.min(pcm.length - length, Math.max(0, start - extraBefore));
  return pcm.subarray(offset, offset + length);
}

/** @param {Float32Array} pcm @param {number} offset */
function framePeriodicity(pcm, offset) {
  const samples = new Float64Array(OMNIVOICE_SAMPLES_PER_FRAME / 4);
  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = pcm[offset + i * 4];
    mean += samples[i] / samples.length;
  }
  let energy = 0, motion = 0;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] -= mean;
    energy += samples[i] ** 2;
    if (i > 0) motion += (samples[i] - samples[i - 1]) ** 2;
  }
  // Ignore near-constant drift. Test for pitch periods of 75–500 Hz at 6 kHz.
  if (energy === 0 || motion < 0.04 ** 2 * energy) return 0;
  let best = 0;
  for (let lag = 12; lag <= 80; lag += 1) {
    let correlation = 0;
    for (let i = lag; i < samples.length; i += 1) correlation += samples[i] * samples[i - lag];
    best = Math.max(best, correlation);
  }
  return best / energy;
}

/** @param {Float32Array} pcm @param {Float64Array} levels @param {number} peak @param {boolean} trailing */
function detachedEdgeFrames(pcm, levels, peak, trailing) {
  const quiet = Math.min(0.002, peak * 0.02);
  const weak = Math.min(Math.max(0.012, peak * 0.09), peak * 0.13);
  const limit = 25;
  let noise = false, previousVoiced = false;
  const levelAt = (/** @type {number} */ i) => levels[trailing ? levels.length - 1 - i : i];
  for (let i = 0; i < limit;) {
    const level = levelAt(i);
    if (level > weak) return 0;
    if (level >= quiet) {
      const frame = trailing ? levels.length - 1 - i : i;
      const periodicity = level >= Math.max(0.0015, peak * 0.022)
        ? framePeriodicity(pcm, frame * OMNIVOICE_SAMPLES_PER_FRAME) : 0;
      const voiced = periodicity > 0.65;
      // A weak ending vowel can fit inside a single codec frame.
      if (periodicity > (trailing ? 0.65 : 0.88) || (voiced && previousVoiced)) return 0;
      previousVoiced = voiced;
      noise = true;
      i += 1;
      continue;
    }
    const start = i;
    let floor = level;
    while (i < limit && levelAt(i) < quiet) {
      floor = Math.min(floor, levelAt(i));
      i += 1;
    }
    previousVoiced = false;
    // Require a distinct quiet gap in a long edge, then keep 120 ms beside speech.
    if (noise && i - start >= 2 && i >= 8 && i < limit && floor < quiet / 2) return i - 3;
  }
  return 0;
}

/** Trim weak decoder noise separated from spoken narration by a quiet gap.
 * @template {ArrayBufferLike} Buffer @param {Float32Array<Buffer>} pcm */
export function trimOmniVoiceNarrationEdges(pcm) {
  const audio = trimOmniVoicePlaybackEdges(pcm);
  const size = OMNIVOICE_SAMPLES_PER_FRAME;
  const frames = Math.floor(audio.length / size);
  if (frames < 25) return audio;
  const levels = new Float64Array(frames);
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0, energy = 0;
    for (let i = frame * size; i < (frame + 1) * size; i += 1) {
      sum += audio[i];
      energy += audio[i] ** 2;
    }
    levels[frame] = Math.sqrt(Math.max(0, energy / size - (sum / size) ** 2));
    peak = Math.max(peak, levels[frame]);
  }
  if (!Number.isFinite(peak) || peak < 0.03) return audio;
  const leading = detachedEdgeFrames(audio, levels, peak, false);
  const trailing = detachedEdgeFrames(audio, levels, peak, true);
  if (leading + trailing >= frames || (!leading && !trailing)) return audio;
  return audio.subarray(leading * size, trailing ? (frames - trailing) * size : audio.length);
}

/** Reject clear signal failures before playback or reuse as a speaker reference.
 * This is not a pronunciation, language or naturalness classifier.
 * @param {Float32Array} pcm @param {number} sampleRate
 */
export function assertOmniVoiceAudio(pcm, sampleRate) {
  /** @param {string} reason */
  const fail = reason => {
    const error = new Error(`OmniVoice returned invalid audio (${reason}). Stop and try again or choose another voice variation.`);
    error.name = 'OmniVoiceAudioQualityError';
    throw error;
  };
  if (!pcm.length || sampleRate !== 24000) fail('empty or unsupported format');
  let energy = 0, sum = 0, difference = 0, crossings = 0, clipped = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const value = pcm[index];
    if (!Number.isFinite(value)) fail('non-finite samples');
    energy += value * value;
    sum += value;
    if (Math.abs(value) >= 0.999) clipped += 1;
    if (index) {
      difference += (value - pcm[index - 1]) ** 2;
      if (value * pcm[index - 1] < 0) crossings += 1;
    }
  }
  // Require enough audio before classifying silence or noise statistically.
  if (pcm.length < sampleRate / 4) return;
  if (energy / pcm.length - (sum / pcm.length) ** 2 < 1e-10) fail('silence or constant output');
  if (clipped / pcm.length > 0.2) fail('severe clipping');
  // Conservative: ordinary speech and whisper contain noise. Only reject
  // predominantly broadband, rapidly alternating output characteristic of static.
  if (crossings / pcm.length > 0.35 && difference / energy > 1.5) fail('broadband static');
}
