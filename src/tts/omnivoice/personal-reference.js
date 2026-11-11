// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { getOmniVoiceLanguageOptions } from './languages.js';
import { findOmniVoiceSpeechBounds, OMNIVOICE_SAMPLES_PER_FRAME } from './audio-quality.js';

const languages = new Set(getOmniVoiceLanguageOptions().map(language => language.code));
const idPattern = /^clone:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/** @param {unknown} value @returns {value is string} */
export function isPersonalVoiceId(value) {
  return typeof value === 'string' && idPattern.test(value);
}

/** Validate the persisted prompt before it reaches the model. @param {any} reference */
export function isPersonalVoiceReference(reference) {
  return reference && isPersonalVoiceId(reference.id)
    && typeof reference.name === 'string' && Boolean(reference.name.trim()) && reference.name.length <= 80
    && languages.has(reference.lang)
    && typeof reference.text === 'string' && Boolean(reference.text.trim()) && reference.text.length <= 400
    && !/<\||\|>/u.test(reference.text)
    && Number.isInteger(reference.frames) && reference.frames >= 76 && reference.frames <= 250 && reference.frames % 2 === 0
    && Array.isArray(reference.codes) && reference.codes.length === 8 * reference.frames
    && Array.from(reference.codes).every(code => Number.isInteger(code) && code >= 0 && code < 1024)
    && typeof reference.hash === 'string' && /^[\da-f]{64}$/u.test(reference.hash);
}

/** @param {any} reference @param {unknown} id */
export function getPersonalVoiceSpeaker(reference, id) {
  if (!isPersonalVoiceReference(reference) || reference.id !== id) throw new Error('Invalid OmniVoice personal voice reference.');
  return { id: reference.id, referenceId: reference.id, referenceLanguage: reference.lang,
    text: reference.text.trim(), frames: reference.frames, codes: BigInt64Array.from(reference.codes, BigInt),
    hash: reference.hash, durationSource: 'recording' };
}

/** Prepare a recorded prompt, including saved voices with silence already encoded.
 * @param {ReturnType<typeof getPersonalVoiceSpeaker>} speaker @param {Float32Array} pcm */
export function preparePersonalVoiceSpeaker(speaker, pcm) {
  const text = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}"'’”]*$/u.test(speaker.text) ? speaker.text : `${speaker.text}.`;
  const bounds = findOmniVoiceSpeechBounds(pcm);
  if (!bounds || pcm.length !== speaker.frames * OMNIVOICE_SAMPLES_PER_FRAME) return { ...speaker, text };
  // Keep one frame after the speech so the prompt ends at a natural boundary.
  const first = bounds.first;
  const end = Math.min(speaker.frames, bounds.end + 1);
  const frames = end - first;
  if (frames === speaker.frames) return { ...speaker, text };
  const codes = new BigInt64Array(8 * frames);
  for (let book = 0; book < 8; book += 1) {
    const offset = book * speaker.frames;
    codes.set(speaker.codes.subarray(offset + first, offset + end), book * frames);
  }
  return { ...speaker, text, frames, codes };
}
