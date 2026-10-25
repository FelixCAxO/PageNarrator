// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// App-used loading/text-layer contract over the original C++/WASM browser engine.
import { openPdfDocument, renderPdfTextLayer } from './browser-pdf.js';
import { PdfEngineError } from './native-reader.js';
import { PDF_WASM_ASSET_PATH, PDF_DATA_ASSET_PATH, pdfExtensionAssetUrl } from './assets.js';

export const isPageNarratorPdfEngine = true;
import { binaryResource, MAX_SOURCE_BYTES } from './binary-resource.js';

function closedError() { return new PdfEngineError('PDF document loading has been cancelled.', 'pdf_closed'); }
export function getDocument(input) {
  const params = typeof input === 'string' ? { url: input } : input instanceof ArrayBuffer || input instanceof Uint8Array ? { data: input } : input || {};
  const controller = new AbortController(), { signal } = controller; let document = null, closed = false, rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { closed = true; controller.abort(); document?.destroy(); rejectAbort(closedError()); };
  params.signal?.addEventListener('abort', onAbort, { once: true });
  const task = { onProgress: null, promise: null, destroy() { onAbort(); params.signal?.removeEventListener('abort', onAbort); return Promise.resolve(); } };
  const load = async () => {
    if (params.signal?.aborted) onAbort(); if (closed) throw closedError();
    const fetchImpl = params.fetch || globalThis.fetch;
    const read = (url, maxBytes, progress = null) => binaryResource(url, { signal, fetchImpl, maxBytes, progress });
    // Initial version downloads bounded source bytes before parsing; range-first opening remains a measured performance gate.
    let data = params.data;
    if (!data) data = await binaryResource(params.url, { signal, fetchImpl, maxBytes: MAX_SOURCE_BYTES,
      credentials: params.withCredentials ? 'include' : 'omit', progress: (loaded, total) => task.onProgress?.({ loaded, total }) });
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (!(data instanceof Uint8Array) || data.length > MAX_SOURCE_BYTES) throw new PdfEngineError('PDF input must contain at most 128 MiB of bytes.', 'pdf_limit');
    const wasmUrl = params.wasmUrl || pdfExtensionAssetUrl(PDF_WASM_ASSET_PATH);
    if (!params.wasm && !wasmUrl) throw new PdfEngineError('Supply PDF parser bytes or wasmUrl outside the extension.', 'pdf_configuration');
    const wasm = params.wasm || await read(wasmUrl, 16 * 1024 * 1024);
    const assetBaseUrl = params.assetBaseUrl || (params.standardFontDataUrl ? new URL('../', params.standardFontDataUrl).href : pdfExtensionAssetUrl(PDF_DATA_ASSET_PATH));
    const loadAsset = params.loadAsset || (relative => {
      if (!assetBaseUrl) throw new PdfEngineError('Supply PDF font data through loadAsset or assetBaseUrl outside the extension.', 'pdf_configuration');
      return read(new URL(relative, assetBaseUrl), 2 * 1024 * 1024);
    });
    if (closed) throw closedError();
    const useWorker = params.disableWorker ? false : params.useWorker ?? (typeof Worker === 'function' && !params.loadAsset && !globalThis.process?.versions?.node);
    document = await openPdfDocument(data, { wasm, loadAsset: useWorker ? undefined : loadAsset,
      useWorker, assetBaseUrl, password: params.password, useSystemFonts: params.useSystemFonts, signal });
    if (closed) { document.destroy(); throw closedError(); } return document;
  };
  task.promise = Promise.race([Promise.resolve().then(load), aborted]); return task;
}
export class TextLayer {
  constructor(settings) { this.settings = settings; this.cancelled = false; }
  render() { return renderPdfTextLayer({ ...this.settings, shouldCancel: () => this.cancelled }); }
  cancel() { this.cancelled = true; }
}
