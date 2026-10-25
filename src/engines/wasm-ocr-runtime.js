// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { InferenceSession, Tensor } from './browser-inference.js';
import { WasmOcrCompute } from './wasm-ocr-compute.js';
import { detectPdfOcrLines, recognizePdfOcrDetectedLines } from '../lib/pdf-ocr-detector.js';
import { orderPdfOcrMarginalLines } from '../lib/pdf-ocr-lines.js';
import { initializeNativeKernels } from '../lib/native-kernels.js';

const FILES = Object.freeze({
  'tiny-det.onnx': '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
  'small-rec.onnx': 'c3a4550768b962131ed08dde81e73e2258f2c1d32a0e2ecb0fd80a223c6252f5',
  'small-rec-alphabet.json': 'b50d01361bea9087ccb896a6381c1a8334e2af14ae0f1036571bd06cdc3832bf',
});

async function fetchData(url, expectedHash = null) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Packaged OCR data unavailable (${response.status}). Reinstall or retry the extension.`);
  const bytes = await response.arrayBuffer();
  if (expectedHash) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== expectedHash) throw new Error('Packaged OCR model data are corrupt. Reinstall the extension.');
  }
  return bytes;
}

/** One English CPU fallback, using the same licensed neural weights, without Tesseract. */
export async function createWasmOcrRuntime(runtimeRoot, { engine: sharedEngine = null, verifyLine = null } = {}) {
  const root = new URL(runtimeRoot);
  if (!['chrome-extension:', 'moz-extension:', 'http:', 'https:'].includes(root.protocol)) throw new Error('Invalid OCR runtime root.');
  let engine, detector, recognizer;
  try {
    const [wasm, ...models] = await Promise.all([
      sharedEngine ? null : fetchData(new URL('native/ocr-engine.wasm', root)),
      ...Object.entries(FILES).map(([file, hash]) => fetchData(new URL(`assets/ocr/${file}`, root), hash)),
    ]);
    engine = sharedEngine || await WasmOcrCompute.create(wasm);
    detector = await InferenceSession.create(models[0], { executionProviders: ['wasm'], engine });
    recognizer = await InferenceSession.create(models[1], { executionProviders: ['wasm'], engine });
    const alphabet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(models[2]));
    if (!Array.isArray(alphabet) || alphabet.length !== 18710 || alphabet[0] !== '' || alphabet.at(-1) !== ' '
      || alphabet.some(value => typeof value !== 'string')) throw new Error('Invalid OCR recognition alphabet.');
    await initializeNativeKernels(new URL('native/kernels.wasm', root).href);
    let closed = false;
    return {
      async recognize(canvas, { mode = 'page' } = {}) {
        if (closed) throw new Error('OCR CPU runtime is closed.');
        if (!['page', 'crop'].includes(mode) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)
          || canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 4_000_000) throw new RangeError('Invalid OCR image or retry mode.');
        // A retry examines more source pixels; the weights do not become an independent verifier.
        const boxes = await detectPdfOcrLines(canvas, { Tensor }, detector, mode === 'crop' ? 1280 : 640);
        const lines = await recognizePdfOcrDetectedLines(canvas, { Tensor }, detector, recognizer, alphabet, () => closed, boxes, verifyLine?.(() => closed));
        if (closed) throw new Error('OCR CPU runtime is closed.');
        return { data: { blocks: [{ paragraphs: [{ lines: orderPdfOcrMarginalLines(lines || []) }] }] } };
      },
      async dispose() {
        if (closed) return;
        closed = true;
        try { await Promise.allSettled([detector.release(), recognizer.release()]); }
        finally { if (!sharedEngine) await engine.dispose(); }
      },
    };
  } catch (error) {
    await Promise.allSettled([detector?.release(), recognizer?.release()]);
    if (!sharedEngine) await engine?.dispose(); throw error;
  }
}
