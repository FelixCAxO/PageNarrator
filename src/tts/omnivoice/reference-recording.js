// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { withAbortSignal } from '../../lib/abort-signal.js';
import { MAX_SAMPLE_SECONDS } from './reference-import.js';

/** @param {MediaStream} stream */
function stopTracks(stream) {
  for (const track of stream.getTracks()) track.stop();
}

/** @param {{signal:AbortSignal, onStart:(stop:()=>void)=>void}} options */
export async function recordOmniVoiceSample({ signal, onStart }) {
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
    throw new DOMException('Microphone recording is unavailable.', 'NotSupportedError');
  }
  // The browser prompt can finish after the user cancels in the extension.
  const stream = await withAbortSignal(navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    if (signal.aborted) {
      stopTracks(stream);
      signal.throwIfAborted();
    }
    return stream;
  }), signal);
  let timer;
  /** @type {MediaRecorder|undefined} */
  let recorder;
  const stop = () => {
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks(stream);
  };
  try {
    signal.throwIfAborted();
    const capture = recorder = new MediaRecorder(stream);
    /** @type {Blob[]} */
    const chunks = [];
    /** @type {Promise<Blob>} */
    const result = new Promise((resolve, reject) => {
      capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      capture.onstop = () => resolve(new Blob(chunks, { type: capture.mimeType }));
      capture.onerror = () => reject(new Error('Microphone recording stopped unexpectedly.'));
    });
    capture.start();
    timer = setTimeout(stop, MAX_SAMPLE_SECONDS * 1000);
    onStart(stop);
    return await withAbortSignal(result, signal);
  } finally {
    clearTimeout(timer);
    stop();
  }
}
