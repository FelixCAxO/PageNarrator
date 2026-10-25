// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Probe-only alternative. Production imports neither this module nor its model data.
import { InferenceSession, Tensor } from './browser-inference.js';
import { WasmOcrCompute } from './wasm-ocr-compute.js';
import { detectPdfOcrLines, recognizePdfOcrDetectedLines } from '../lib/pdf-ocr-detector.js';
import { orderPdfOcrMarginalLines } from '../lib/pdf-ocr-lines.js';
import { decodePdfOcrCtcBeam, OCR_CTC_BEAM_POLICY } from '../lib/pdf-ocr-ctc-beam.js';

export function englishCandidateSession(session, alphabet, { bgr = true, beam = false } = {}) {
  if (!Array.isArray(alphabet) || ![438, 838, 18710].includes(alphabet.length) || alphabet[0] !== '' || alphabet.at(-1) !== ' ') throw new Error('Invalid English candidate alphabet.');
  const classes = alphabet.length;
  return {
    inputNames: session.inputNames,
    async run(feeds) {
      const name = session.inputNames[0], input = feeds[name];
      if (input.type !== 'float32' || input.dims.length !== 4 || input.dims[1] !== 3) throw new Error('English OCR candidate requires RGB source planes.');
      // Pinned preprocessing specifies BGR; the shared browser crop packer produces RGB.
      const data = bgr ? input.data.slice() : input.data, plane = input.dims[2] * input.dims[3];
      for (let b = 0; bgr && b < input.dims[0]; b++) {
        const base = b * plane * 3;
        data.set(input.data.subarray(base + plane * 2, base + plane * 3), base);
        data.set(input.data.subarray(base, base + plane), base + plane * 2);
      }
      const outputs = await session.run({ [name]: new Tensor('float32', data, input.dims) });
      const dense = outputs[session.outputNames[0]];
      if (dense?.dims.length !== 3 || dense.dims[0] !== input.dims[0] || dense.dims[2] !== classes
        || dense.data.length !== dense.dims[0] * dense.dims[1] * classes) throw new Error('Invalid English candidate recognition output.');
      const count = dense.dims[0] * dense.dims[1], labels = new Int32Array(count), scores = new Float32Array(count), spaces = new Float32Array(count);
      if (beam) {
        const steps = dense.dims[1];
        for (let b = 0; b < dense.dims[0]; b++) {
          const result = decodePdfOcrCtcBeam(dense.data.subarray(b * steps * classes, (b + 1) * steps * classes), steps, alphabet, OCR_CTC_BEAM_POLICY);
          labels.set(result.labels, b * steps); scores.set(result.scores, b * steps);
        }
        // Leave the heuristic space channel zero: this probe uses only the CTC path.
        const dims = dense.dims.slice(0, 2);
        return { ocr_labels: { data: labels, dims }, ocr_scores: { data: scores, dims }, ocr_spaces: { data: spaces, dims } };
      }
      for (let i = 0; i < count; i++) {
        let best = 0;
        for (let c = 0; c < classes; c++) {
          const value = dense.data[i * classes + c];
          if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid English candidate confidence.');
          if (value > dense.data[i * classes + best]) best = c;
        }
        labels[i] = best; scores[i] = dense.data[i * classes + best]; spaces[i] = dense.data[i * classes + classes - 1];
      }
      const dims = dense.dims.slice(0, 2);
      return { ocr_labels: { data: labels, dims }, ocr_scores: { data: scores, dims }, ocr_spaces: { data: spaces, dims } };
    },
  };
}

export async function createEnglishOcrCandidate({ detectorBytes, recognizerBytes, wasmBytes, alphabet, bgr = true, beam = false }) {
  const engine = await WasmOcrCompute.create(wasmBytes);
  let detector, recognizer, closed = false;
  try {
    detector = await InferenceSession.create(detectorBytes, { executionProviders: ['wasm'], engine });
    recognizer = await InferenceSession.create(recognizerBytes, { executionProviders: ['wasm'], engine });
    const adapter = englishCandidateSession(recognizer, alphabet, { bgr, beam });
    return {
      async recognize(canvas, { mode = 'page' } = {}) {
        if (closed) throw new Error('English OCR candidate is closed.');
        if (!['page', 'crop'].includes(mode) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)
          || canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 4_000_000) throw new Error('Invalid English candidate image.');
        const boxes = await detectPdfOcrLines(canvas, { Tensor }, detector, mode === 'crop' ? 1280 : 640);
        const lines = await recognizePdfOcrDetectedLines(canvas, { Tensor }, detector, adapter, alphabet, () => closed, boxes);
        if (closed) throw new Error('English OCR candidate is closed.');
        return { data: { blocks: [{ paragraphs: [{ lines: orderPdfOcrMarginalLines(lines || []) }] }] } };
      },
      async dispose() {
        if (closed) return;
        closed = true;
        try { await Promise.allSettled([detector.release(), recognizer.release()]); }
        finally { await engine.dispose(); }
      },
    };
  } catch (error) {
    await Promise.allSettled([detector?.release(), recognizer?.release()]); await engine.dispose(); throw error;
  }
}
