import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ponytail: PCM16 WAV only; reject other encodings instead of silently misreading them.
export function inspectWav(bytes) {
  if (!bytes || bytes.length < 12) throw new Error('Missing audio');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV');
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Truncated WAV');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new Error('Truncated WAV chunk');
    if (name === 'fmt ') format = bytes.subarray(offset + 8, end);
    if (name === 'data') data = bytes.subarray(offset + 8, end);
    offset = end + (length % 2);
  }
  if (!format || format.length < 16 || !data) throw new Error('Missing WAV chunks');
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
  if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16 || !channels || !rate || data.length % (2 * channels)) throw new Error('Unsupported WAV format');
  let peak = 0, clipped = 0, first = null;
  for (let i = 0; i < data.length; i += 2) {
    const amplitude = Math.abs(data.readInt16LE(i));
    peak = Math.max(peak, amplitude);
    if (amplitude >= 32767) clipped++;
    if (first === null && amplitude >= 328) first = Math.floor(i / (2 * channels)) / rate;
  }
  return { frames: data.length / (2 * channels), durationSeconds: data.length / (2 * channels * rate),
    peak, clippingFraction: data.length ? clipped / (data.length / 2) : null,
    firstSignalSeconds: first, silent: first === null };
}

// These observations require external evidence. A passed capture is not a passed product benchmark.
export function captureGate({ launched, supported, modelAvailable, requestedBackend, observedBackend,
  contentTransmissionObserved, audio, complete, attributable, speechVerified, blocker }) {
  if (supported === false) return { status: 'unsupported', reason: 'Capability explicitly unsupported' };
  if (blocker) return { status: 'blocked', reason: blocker };
  if (launched === false) return { status: 'blocked', reason: 'Launch failed' };
  if (modelAvailable === false) return { status: 'blocked', reason: 'Model unavailable' };
  if (contentTransmissionObserved === true) return { status: 'failed', reason: 'Content transmission observed' };
  if (requestedBackend && observedBackend && requestedBackend !== observedBackend) return { status: 'failed', reason: 'Backend mismatch' };
  let measured;
  try { measured = inspectWav(audio); } catch (error) { return { status: 'failed', reason: error.message }; }
  if (measured.silent) return { status: 'failed', reason: 'Silent playback' };
  if (complete === false) return { status: 'failed', reason: 'Truncated speech' };
  if (launched !== true || supported !== true || modelAvailable !== true || !observedBackend ||
      complete !== true || attributable !== true || speechVerified !== true) return { status: 'not_measured', reason: 'Missing affirmative capture evidence' };
  return { status: 'passed', reason: 'Speech capture gate only; acceptance workload remains separate' };
}
