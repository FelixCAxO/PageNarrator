// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

/** @typedef {{ path: string, bytes: number, sha256: string }} PinnedFile */
/** @typedef {PinnedFile & { chunkBytes: number, hashes: readonly string[] }} VerificationChunks */

/** Return a hash-pinned model file from the cache, or download, verify and cache it.
 * Slow links remain usable while bytes arrive; callers can cancel at any time.
 * @param {string} url @param {PinnedFile} file
 * @param {{ label: string, cache?: Cache | null, fetcher?: typeof fetch | null, stallMs?: number,
 *   onCacheError?: (error: unknown) => void, onCachePutError?: (error: unknown) => void,
 *   onCacheInvalid?: (error: unknown) => void, onDownload?: () => void,
 *   onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal|null,
 *   verificationChunks?: VerificationChunks|null }} options
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function loadVerifiedFile(url, file, { label, cache = null, fetcher = null, stallMs = 30_000,
  onCacheError = () => {}, onCachePutError = onCacheError, onCacheInvalid = () => {}, onDownload = () => {}, onProgress = () => {}, signal = null, verificationChunks = null }) {
  signal?.throwIfAborted();
  if (verificationChunks && (verificationChunks.path !== file.path || verificationChunks.bytes !== file.bytes || verificationChunks.sha256 !== file.sha256
    || !Number.isSafeInteger(verificationChunks.chunkBytes) || verificationChunks.chunkBytes <= 0
    || !Array.isArray(verificationChunks.hashes) || verificationChunks.hashes.length !== Math.max(1, Math.ceil(file.bytes / verificationChunks.chunkBytes))
    || verificationChunks.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new Error(`Invalid ${label} verification chunks: ${file.path}.`);
  }
  const cached = await cache?.match(url).catch(onCacheError);
  signal?.throwIfAborted();
  if (cached?.ok) {
    try {
      // Cache arrayBuffer() also stages whole files; reuse the bounded stream reader.
      const bytes = await verify(await download(url, file, { label, fetcher: async () => cached, stallMs,
        onProgress: () => {}, signal }), file, label, verificationChunks, signal);
      signal?.throwIfAborted();
      return bytes;
    }
    catch (error) {
      signal?.throwIfAborted();
      await cache?.delete(url).catch(onCacheError);
      onCacheInvalid(error);
    }
  }
  if (!fetcher) throw new Error(`${label} data is unavailable offline: ${file.path}.`);
  onDownload();
  const bytes = await verify(await download(url, file, { label, fetcher, stallMs, onProgress, signal }), file, label, verificationChunks, signal);
  signal?.throwIfAborted();
  // Response(typedArray) clones all weights; stream verified views to bound cache-write staging.
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 1024 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  await cache?.put(url, new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(onCachePutError);
  return bytes;
}

/** @param {string} url @param {PinnedFile} file @param {{ label: string, fetcher: typeof fetch, stallMs: number, onProgress: (loaded: number, total: number) => void, signal: AbortSignal|null }} options */
async function download(url, file, { label, fetcher, stallMs, onProgress, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  /** @type {ReadableStreamDefaultReader<Uint8Array>|undefined} */
  let reader;
  const cancelReader = () => { void reader?.cancel(controller.signal.reason).catch(() => false); };
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const restartStallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException(`${label} download stalled: ${file.path}.`, 'TimeoutError')), stallMs);
  };
  restartStallTimer();
  try {
    const response = await fetcher(url, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`${label} data download failed (${response.status}): ${file.path}.`);
    // The pinned size is known: fill one buffer instead of collecting chunks and copying them.
    const bytes = new Uint8Array(file.bytes);
    controller.signal.throwIfAborted();
    reader = response.body?.getReader();
    let length = 0;
    let lastProgressAt = 0;
    while (reader) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      restartStallTimer();
      if (length + value.length > bytes.length) {
        controller.abort();
        throw new Error(`Invalid ${label} data size: ${file.path}.`);
      }
      bytes.set(value, length);
      length += value.length;
      const now = Date.now();
      // Bound worker messages while still reporting the first and final bytes.
      if (now - lastProgressAt >= 100 || length === bytes.length) {
        onProgress(length, bytes.length);
        lastProgressAt = now;
      }
    }
    if (length !== bytes.length) throw new Error(`Invalid ${label} data size: ${file.path}.`);
    return bytes;
  } catch (error) {
    void reader?.cancel(error).catch(() => false);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelReader);
    reader?.releaseLock();
  }
}

/** @param {Uint8Array<ArrayBuffer>} bytes @param {PinnedFile} file @param {string} label
 * @param {VerificationChunks|null} chunks @param {AbortSignal|null} signal */
async function verify(bytes, file, label, chunks, signal) {
  if (bytes.byteLength !== file.bytes) throw new Error(`Invalid ${label} data size: ${file.path}.`);
  const hashes = chunks?.hashes ?? [file.sha256];
  for (let index = 0; index < hashes.length; index++) {
    signal?.throwIfAborted();
    // WebCrypto copies its input; bundled chunk pins bound staging for large weights.
    const part = chunks ? bytes.subarray(index * chunks.chunkBytes, (index + 1) * chunks.chunkBytes) : bytes;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', part));
    signal?.throwIfAborted();
    if (Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== hashes[index]) throw new Error(`${label} data hash mismatch: ${file.path}.`);
  }
  return bytes;
}
