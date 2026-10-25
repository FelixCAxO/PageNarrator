// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Development-only backend selection. Importing this module opens no PDF. */
export async function loadPdfAcceptanceBackend(backend = 'original', {
  loadModule = specifier => import(specifier), read = readFile,
} = {}) {
  if (!['original', 'original-browser', 'pdfjs-oracle'].includes(backend)) throw new Error('Unknown PDF acceptance backend. Use original, original-browser or pdfjs-oracle.');
  if (backend === 'original-browser') {
    const browser = await loadModule('./pdf-acceptance-browser.mjs');
    if (typeof browser.createPdfAcceptanceBrowser !== 'function') throw new Error('Invalid browser PDF acceptance backend.');
    return browser.createPdfAcceptanceBrowser();
  }
  const original = backend === 'original';
  const specifier = original ? '../../src/pdf/pdf-engine.js' : 'pdfjs-dist/legacy/build/pdf.mjs';
  const pdf = await loadModule(specifier);
  if (typeof pdf.getDocument !== 'function' || (original ? pdf.isPageNarratorPdfEngine !== true : typeof pdf.version !== 'string')) {
    throw new Error('PDF acceptance backend identity does not match the selected implementation.');
  }
  const paths = original
    ? ['../../src/pdf/pdf-engine.js', '../../native/pdf.wasm']
    : ['../../node_modules/pdfjs-dist/legacy/build/pdf.mjs', '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'];
  const sourcePins = [];
  let wasm;
  for (const relative of paths) {
    const url = new URL(relative, import.meta.url), bytes = await read(url);
    sourcePins.push({ path: fileURLToPath(url), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (relative.endsWith('/pdf.wasm')) wasm = bytes;
  }
  const engine = original ? { ...pdf, getDocument(input) {
    // Same Node asset wiring as the existing original-corpus adapter. The
    // caller retains the facade's original task/promise/destroy contract.
    const params = typeof input === 'string' ? { url: input }
      : input instanceof Uint8Array || input instanceof ArrayBuffer ? { data: input } : input;
    return pdf.getDocument({ ...params, wasm, disableWorker: true,
      loadAsset: async name => new Uint8Array(await read(new URL(`../../vendor/pdf-data/${name}`, import.meta.url))) });
  } } : pdf;
  return { engine, identity: { backend, version: pdf.version ?? null,
    scope: original ? 'Original parser and facade, Node CPU core mode.' : 'Isolated PDF.js development oracle.', sourcePins } };
}
