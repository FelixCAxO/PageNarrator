// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export async function binaryResource(value, { signal = new AbortController().signal, maxBytes, fetchImpl = globalThis.fetch, credentials = 'omit', progress = null, validatePrefix = null } = {}) {
  signal.throwIfAborted(); const url = new URL(value, import.meta.url);
  // Local development extraction uses the identical parser/data without a browser fetch shim.
  if (url.protocol === 'file:' && globalThis.process?.versions?.node) {
    const { readFile, stat } = await import(/* @vite-ignore */ 'node:fs/promises');
    if ((await stat(url)).size > maxBytes) throw new PdfEngineError('PDF resource exceeds its byte limit.', 'pdf_limit');
    const bytes = new Uint8Array(await readFile(url, { signal }));
    if (bytes.length > maxBytes) throw new PdfEngineError('PDF resource exceeds its byte limit.', 'pdf_limit');
    validatePrefix?.(bytes.subarray(0, 1024));
    progress?.(bytes.length, bytes.length); return bytes;
  }
  if (!['http:', 'https:', 'file:', 'blob:', 'data:', 'chrome-extension:'].includes(url.protocol)) throw new PdfEngineError('Unsupported PDF source URL.', 'pdf_network');
  const response = await fetchImpl(url.href, { signal, credentials });
  if (!response.ok) {
    void Promise.resolve(response.body?.cancel?.()).catch(() => false);
    throw new PdfEngineError(`Could not download the PDF resource (${response.status}).`, 'pdf_network');
  }
  const encoding = response.headers?.get?.('content-encoding'), length = response.headers?.get?.('content-length');
  const total = (!encoding || encoding === 'identity') && /^\d+$/u.test(length || '') ? Number(length) : 0;
  if (!Number.isSafeInteger(total) || total > maxBytes) { void Promise.resolve(response.body?.cancel?.()).catch(() => false); throw new PdfEngineError('PDF resource exceeds its byte limit.', 'pdf_limit'); }
  if (!response.body?.getReader) throw new PdfEngineError('PDF resource has no readable response stream.', 'pdf_network');
  const reader = response.body.getReader(), chunks = total ? null : [], output = total ? new Uint8Array(total) : null; let loaded = 0, prefixChecked = !validatePrefix;
  const prefix = new Uint8Array(1024); let prefixLength = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => false); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value: chunk } = await reader.read(); signal.throwIfAborted();
      if (done) { if (!prefixChecked) validatePrefix(prefix.subarray(0, prefixLength)); break; }
      if (!prefixChecked) {
        const part = chunk.subarray(0, prefix.length - prefixLength); prefix.set(part, prefixLength); prefixLength += part.length;
        if (prefixLength === prefix.length) { validatePrefix(prefix); prefixChecked = true; }
      }
      if (loaded + chunk.length > maxBytes) throw new PdfEngineError('PDF resource exceeds its byte limit.', 'pdf_limit');
      if (total && loaded + chunk.length > total) throw new PdfEngineError('PDF resource body exceeds its declared length.', 'pdf_network');
      if (output) output.set(chunk, loaded); else chunks.push(chunk); loaded += chunk.length; progress?.(loaded, total);
    }
    signal.throwIfAborted();
    if (total && loaded !== total) throw new PdfEngineError('PDF resource body is shorter than its declared length.', 'pdf_network');
    if (output) return output;
    const result = new Uint8Array(loaded); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  } catch (error) { void reader.cancel().catch(() => false); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
