// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { withAbortSignal } from '../../lib/abort-signal.js';
import { trimOmniVoicePlaybackEdges } from './audio-quality.js';
import { REFERENCE_SAMPLE_RATE } from './reference-encoder.js';
import { MIN_SAMPLE_SECONDS } from './reference-import.js';
import { SIDON_INPUT_RATE, SIDON_OUTPUT_RATE } from './sidon-features.js';

/** @param {Float32Array<ArrayBuffer>} pcm @param {number} from @param {number} to
 * @param {number} length @param {AbortSignal} signal */
async function resample(pcm, from, to, length, signal) {
  const context = new OfflineAudioContext(1, length, to);
  const buffer = context.createBuffer(1, pcm.length, from);
  buffer.copyToChannel(pcm, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return (await withAbortSignal(context.startRendering(), signal)).getChannelData(0);
}

/** @param {Float32Array<ArrayBuffer>} pcm
 * @param {{signal:AbortSignal, onProgress:(progress:{loaded:number,total:number})=>void, onProcessing:()=>void}} options */
export async function cleanOmniVoiceSample(pcm, { signal, onProgress, onProcessing }) {
  signal.throwIfAborted();
  const input = await resample(pcm, REFERENCE_SAMPLE_RATE, SIDON_INPUT_RATE,
    Math.round(pcm.length * SIDON_INPUT_RATE / REFERENCE_SAMPLE_RATE), signal);
  signal.throwIfAborted();
  const worker = new Worker(new URL('./reference-cleanup-worker.js', import.meta.url), { type: 'module' });
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    /** @type {Promise<Float32Array<ArrayBuffer>>} */
    const result = new Promise((resolve, reject) => {
      /** @param {string} message */
      const watch = message => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), 180_000);
      };
      watch('Noise cleanup worker did not start.');
      worker.onmessage = ({ data }) => {
        if (data.progress) {
          watch('Noise cleanup model download stalled.');
          onProgress(data.progress);
        } else if (data.processing) {
          watch('Noise cleanup processing timed out.');
          onProcessing();
        } else if (data.error) reject(new Error(data.error));
        else resolve(data.pcm);
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error(event.message)); };
      worker.onmessageerror = () => reject(new Error('Sidon returned an unreadable result.'));
      worker.postMessage({ pcm: input }, [input.buffer]);
    });
    const output = await withAbortSignal(result, signal);
    clearTimeout(timer);
    const cleaned = await resample(output, SIDON_OUTPUT_RATE, REFERENCE_SAMPLE_RATE, pcm.length, signal);
    if (cleaned.some(sample => !Number.isFinite(sample)) || cleaned.reduce((energy, sample) => energy + sample * sample, 0) < 1e-6 * cleaned.length) {
      throw new Error('Sidon returned silent or invalid audio.');
    }
    return trimOmniVoicePlaybackEdges(cleaned, MIN_SAMPLE_SECONDS * REFERENCE_SAMPLE_RATE);
  } finally { clearTimeout(timer); worker.terminate(); }
}
