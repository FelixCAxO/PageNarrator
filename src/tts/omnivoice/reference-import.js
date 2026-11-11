// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { withAbortSignal } from '../../lib/abort-signal.js';
import { REFERENCE_SAMPLE_RATE } from './reference-encoder.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
export const MIN_SAMPLE_SECONDS = 3;
export const MAX_SAMPLE_SECONDS = 10;

/** @param {File} file @param {AbortSignal|undefined} signal */
async function readDuration(file, signal) {
  const player = new Audio();
  const url = URL.createObjectURL(file);
  player.preload = 'metadata';
  const metadata = new Promise((resolve, reject) => {
    player.onloadedmetadata = () => resolve(player.duration);
    player.onerror = () => reject(new Error('This audio file could not be opened.'));
    player.src = url;
  });
  try {
    const timeout = AbortSignal.timeout(15_000);
    return await withAbortSignal(metadata, signal ? AbortSignal.any([signal, timeout]) : timeout);
  } finally {
    player.onloadedmetadata = player.onerror = null;
    player.removeAttribute('src');
    player.load();
    URL.revokeObjectURL(url);
  }
}

/** @param {Blob} blob @param {{signal?:AbortSignal, recorded?:boolean}} [options] */
export async function decodeOmniVoiceSample(blob, { signal, recorded = false } = {}) {
  const context = new OfflineAudioContext(1, 1, REFERENCE_SAMPLE_RATE);
  const data = await withAbortSignal(blob.arrayBuffer(), signal);
  const decoded = await withAbortSignal(context.decodeAudioData(data), signal);
  const maxLength = MAX_SAMPLE_SECONDS * REFERENCE_SAMPLE_RATE;
  if (decoded.length < MIN_SAMPLE_SECONDS * REFERENCE_SAMPLE_RATE || (!recorded && decoded.length > maxLength)) {
    throw new Error('Choose a voice sample between 3 and 10 seconds.');
  }
  // A late MediaRecorder stop event can include audio just past the time limit.
  const pcm = new Float32Array(Math.min(decoded.length, maxLength));
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    for (let index = 0; index < pcm.length; index++) pcm[index] += samples[index] / decoded.numberOfChannels;
  }
  return pcm;
}

/** @typedef {{signal?:AbortSignal, onProgress?:(progress:{loaded:number,total:number})=>void}} EncodeOptions */

/** @param {File} file @param {EncodeOptions} [options] */
export async function importOmniVoiceSample(file, options = {}) {
  return encodeOmniVoiceSample(await decodeOmniVoiceFile(file, options.signal), options);
}

/** @param {File} file @param {AbortSignal} [signal] */
export async function decodeOmniVoiceFile(file, signal) {
  signal?.throwIfAborted();
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Choose an audio file up to 20 MB.');
  const duration = Number(await readDuration(file, signal));
  if (!(duration >= MIN_SAMPLE_SECONDS && duration <= MAX_SAMPLE_SECONDS)) throw new Error('Choose a voice sample between 3 and 10 seconds.');
  return decodeOmniVoiceSample(file, { signal });
}

/** Takes ownership of the PCM buffer.
 * @param {Float32Array<ArrayBuffer>} pcm @param {EncodeOptions} [options]
 * @returns {Promise<{frames:number, codes:Uint16Array}>} */
export async function encodeOmniVoiceSample(pcm, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./reference-encoder-worker.js', import.meta.url), { type: 'module' });
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    const result = new Promise((resolve, reject) => {
      const restartTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('Voice encoding timed out.')), TIMEOUT_MS);
      };
      worker.onmessage = ({ data }) => {
        if (data.progress) { restartTimer(); onProgress(data.progress); return; }
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message || 'Voice encoding stopped.')); };
      worker.onmessageerror = () => reject(new Error('Voice encoding returned an unreadable result.'));
      restartTimer();
      worker.postMessage({ pcm }, [pcm.buffer]);
    });
    return await withAbortSignal(result, signal);
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
