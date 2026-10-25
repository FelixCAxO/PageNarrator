// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { TesseractLineModel } from './tesseract-line-model.js';
import { tesseractLineSession } from './tesseract-line-recognizer.js';
import { InferenceSession, Tensor } from './browser-inference.js';
import { detectPdfOcrLines, recognizePdfOcrDetectedLines } from '../lib/pdf-ocr-detector.js';
import { orderPdfOcrMarginalLines } from '../lib/pdf-ocr-lines.js';

/** Development-only retained English weights with original execution; never selected implicitly. */
export async function createTesseractOcrCandidate({ detectorBytes, manifest, learnedBytes, wasmBytes, beam = false }) {
  let model, detector, active, closing, closed = false;
  try {
    model = await TesseractLineModel.create(manifest, learnedBytes, wasmBytes);
    detector = await InferenceSession.create(detectorBytes, { executionProviders: ['wasm'], engine: model.engine });
    const adapter = tesseractLineSession(model, { beam });
    const infer = async (canvas, mode) => {
      if (!['page', 'crop'].includes(mode) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)
        || canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 4_000_000) throw new RangeError('Invalid original English OCR candidate image.');
      const boxes = await detectPdfOcrLines(canvas, { Tensor }, detector, mode === 'crop' ? 1280 : 640);
      const lines = await recognizePdfOcrDetectedLines(canvas, { Tensor }, detector, adapter, manifest.alphabet, () => closed, boxes);
      if (closed) throw new Error('Original English OCR candidate was closed.');
      return { data: { blocks: [{ paragraphs: [{ lines: orderPdfOcrMarginalLines(lines || []) }] }] } };
    };
    return {
      async recognize(canvas, { mode = 'page' } = {}) {
        if (closed || active) throw new Error('Original English OCR candidate is closed or busy.');
        active = infer(canvas, mode);
        try { return await active; } finally { active = null; }
      },
      dispose() {
        if (closing) return closing;
        closed = true;
        return closing = (async () => {
          await active?.catch(() => null);
          try { await detector.release(); } finally { await model.dispose(); }
        })();
      },
    };
  } catch (error) {
    try { await detector?.release(); } finally { await model?.dispose(); }
    throw error;
  }
}
