// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmTesseractCompute } from './tesseract-line-compute.js';
import { TesseractLineModel } from './tesseract-line-model.js';
import { tesseractLineSession } from './tesseract-line-recognizer.js';
import { createWasmOcrRuntime } from './wasm-ocr-runtime.js';
import { boundedPdfOcrVerifier } from '../lib/pdf-ocr-independent.js';
import { defaultLogger } from '../lib/logger.js';

const ENGLISH_MANIFEST = '31b613c896e253ddc6f38df9f26a23d4ed844b7484cf6169870a5c7d6ff064c0';
const ENGLISH_WEIGHTS = 'ab437a3f500394377ad7da98c77d3d8477eb2423697b0e3849afbc3f5593c53a';
async function read(root, path, expected = null) {
  const response = await fetch(new URL(path, root), { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Packaged independent OCR data unavailable (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== expected) throw new Error('Packaged independent OCR learned data are corrupt.');
  }
  return bytes;
}

/** One worker, one bounded arena; GPU verification never loads CPU primary graphs. */
export function createOcrWorkerRuntime(runtimeRoot) {
  const root = new URL(runtimeRoot);
  if (!['chrome-extension:', 'moz-extension:', 'http:', 'https:'].includes(root.protocol)) throw new Error('Invalid OCR worker root.');
  let compute, primary, english, active, closing, closed = false;
  const unavailable = error => defaultLogger.warn('Independent OCR verification was unavailable; primary text retained.', error);
  const getCompute = () => compute ||= read(root, 'native/ocr-lstm-engine.wasm').then(bytes => WasmTesseractCompute.create(bytes)).catch(error => { compute = null; throw error; });
  const getEnglish = () => english ||= (async () => {
    const [engine, metadata, bytes] = await Promise.all([getCompute(), read(root, 'assets/ocr/english-lstm.json', ENGLISH_MANIFEST), read(root, 'assets/ocr/english-lstm.bin', ENGLISH_WEIGHTS)]);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata));
    return TesseractLineModel.create(manifest, bytes, null, { engine });
  })().catch(error => { english = null; throw error; });
  const recognizeLine = async source => {
    const model = await getEnglish();
    const [data] = await tesseractLineSession(model).recognizeLines([source]);
    return data;
  };
  const getPrimary = () => primary ||= (async () => createWasmOcrRuntime(runtimeRoot, {
    engine: await getCompute(),
    verifyLine: cancelled => boundedPdfOcrVerifier(recognizeLine, () => closed || cancelled(), unavailable),
  }))().catch(error => { primary = null; throw error; });
  async function run(operation) {
    if (closed || active) throw new Error('OCR worker runtime is closed or busy.');
    active = operation();
    try { const result = await active; if (closed) throw new Error('OCR worker runtime was closed.'); return result; }
    finally { active = null; }
  }
  return {
    recognize(canvas, options) { return run(async () => (await getPrimary()).recognize(canvas, options)); },
    recognizeLine(canvas) { return run(() => recognizeLine(canvas)); },
    dispose() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await active?.catch(() => null);
        try { await Promise.allSettled([(await primary?.catch(() => null))?.dispose(), (await english?.catch(() => null))?.dispose()]); }
        finally { await (await compute?.catch(() => null))?.dispose(); primary = english = compute = null; }
      })();
    },
  };
}
