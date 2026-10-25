// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

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
