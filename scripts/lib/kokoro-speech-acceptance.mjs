// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { normalizeEnglishText } from '../../src/tts/kokoro/normalizer.js';
import { createHash } from 'node:crypto';

export function waveBytes(pcm) {
  if (!(pcm instanceof Float32Array) || !pcm.length || !pcm.every(Number.isFinite)) throw new Error('WAV export requires nonempty finite float32 audio.');
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((value, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)); return bytes;
}
export function comparePcm(reference, candidate, referenceRate = 24000, candidateRate = 24000) {
  const valid = pcm => pcm instanceof Float32Array && pcm.length > 0 && pcm.every(Number.isFinite)
    && audioMeasures(pcm).rms >= .001;
  if (!valid(reference) || !valid(candidate) || !Number.isFinite(referenceRate) || referenceRate <= 0 || referenceRate !== candidateRate) return { status: 'reject', reason: 'Invalid audio or sample rate' };
  const bytes = pcm => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const hash = pcm => createHash('sha256').update(bytes(pcm)).digest('hex');
  return { status: bytes(reference).equals(bytes(candidate)) ? 'accept' : 'reject',
    referenceSha256: hash(reference), candidateSha256: hash(candidate) };
}
export function audioMeasures(pcm) {
  let square = 0, peak = 0, finite = true;
  for (const value of pcm) { finite &&= Number.isFinite(value); square += value * value; peak = Math.max(peak, Math.abs(value)); }
  return { samples: pcm.length, seconds: pcm.length / 24000, finite: finite && pcm.length > 0, rms: Math.sqrt(square / Math.max(1, pcm.length)), peak };
}
export function compareAudio(candidate, reference, gates) {
  const a = audioMeasures(candidate), b = audioMeasures(reference), durationDifference = Math.abs(a.seconds - b.seconds);
  let maximumAbsolute = 0, squareError = 0, squareReference = 0, mismatches = Math.abs(candidate.length - reference.length);
  for (let i = 0; i < Math.max(candidate.length, reference.length); i++) {
    const x = candidate[i] ?? 0, y = reference[i] ?? 0, error = Math.abs(x - y);
    maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error * error; squareReference += y * y;
    if (i < Math.min(candidate.length, reference.length) && error > gates.pcmAbsoluteTolerance + gates.pcmRelativeTolerance * Math.abs(y)) mismatches++;
  }
  return { candidate: a, reference: b, durationDifference, finitePass: a.finite && b.finite, nonSilentPass: a.rms >= gates.minimumRms && b.rms >= gates.minimumRms,
    durationPass: durationDifference <= gates.maximumDurationAbsoluteDifferenceSeconds + gates.maximumDurationRelativeDifference * b.seconds,
    pcm: { pass: a.finite && b.finite && !mismatches, maximumAbsolute, mismatches, relativeRmse: Math.sqrt(squareError / Math.max(1e-30, squareReference)), absoluteTolerance: gates.pcmAbsoluteTolerance, relativeTolerance: gates.pcmRelativeTolerance } };
}
export function transcriptWords(text, dialect) { return normalizeEnglishText(text, dialect).flatMap(part => part.words); }
export function wordErrorRate(actual, expected) {
  let previous = Array.from({ length: expected.length + 1 }, (_, i) => i);
  for (let row = 0; row < actual.length; row++) {
    const next = [row + 1];
    for (let col = 0; col < expected.length; col++) next.push(Math.min(next[col] + 1, previous[col + 1] + 1, previous[col] + (actual[row] === expected[col] ? 0 : 1)));
    previous = next;
  }
  return previous.at(-1) / Math.max(1, expected.length);
}
export function compareTranscripts(asr, text, dialect, gates) {
  const expected = transcriptWords(text, dialect), candidate = transcriptWords(asr.candidate.transcript, dialect), reference = transcriptWords(asr.reference.transcript, dialect);
  const candidateWer = wordErrorRate(candidate, expected), referenceWer = wordErrorRate(reference, expected), finalWords = expected.slice(-3);
  const tailPass = candidate.slice(-finalWords.length).join(' ') === finalWords.join(' ');
  return { expected, candidate, reference, candidateWer, referenceWer, finalWords, tailPass,
    pass: candidateWer <= gates.maximumWordErrorRate && candidateWer - referenceWer <= gates.maximumWordErrorRateIncrease && (!gates.requireExpectedFinalThreeWords || tailPass) };
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
