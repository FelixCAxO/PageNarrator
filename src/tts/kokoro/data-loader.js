// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { KOKORO_DATA } from './model-data.js';
import { loadVerifiedFile } from '../verified-download.js';

/** Hash-pinned data only. Old compatible cache keys remain usable; executable files are never requested.
 * @param {any} [options] */
export function createKokoroDataLoader({ fetcher = globalThis.fetch?.bind(globalThis), cacheStorage = globalThis.caches,
  onProgress = () => {}, manifest = KOKORO_DATA, requireCache = false, signal = null } = {}) {
  const base = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/`;
  const files = new Map(manifest.files.map((/** @type {{path:string, bytes:number, sha256:string}} */ file) => [file.path, file]));
  const pending = new Map();
  return function load(/** @type {string} */ fileName, { signal: callerSignal = signal } = {}) {
    const file = files.get(fileName);
    if (!file) return Promise.reject(new Error(`Unexpected Kokoro model data: ${fileName}.`));
    if (pending.has(fileName)) return pending.get(fileName);
    const task = (async () => {
      const reportCache = (/** @type {unknown} */ error) => onProgress({ status: 'cache-unavailable', file: fileName, message: String(error) });
      const cacheFailure = (/** @type {unknown} */ error) => {
        if (requireCache) throw error;
        reportCache(error); return null;
      };
      const cache = await cacheStorage?.open(fileName.startsWith('voices/') ? 'kokoro-voices' : 'transformers-cache').catch(cacheFailure);
      if (requireCache && !cache) throw new Error('Kokoro voice storage is unavailable.');
      let downloaded = false;
      const bytes = await loadVerifiedFile(`${base}${fileName}`, file, { label: 'Kokoro', cache, fetcher, signal: callerSignal,
        onCacheError: reportCache, onCachePutError: cacheFailure,
        onCacheInvalid: error => onProgress({ status: 'cache-invalid', file: fileName, message: String(error) }),
        onProgress: (loaded, total) => onProgress({ status: 'progress', file: fileName, loaded, total }),
        onDownload: () => {
          downloaded = true;
          onProgress({ status: 'download', file: fileName, loaded: 0, total: file.bytes });
        } });
      if (downloaded) onProgress({ status: 'done', file: fileName, loaded: bytes.byteLength, total: file.bytes });
      return bytes;
    })();
    pending.set(fileName, task);
    void task.finally(() => pending.delete(fileName)).catch(() => undefined);
    return task;
  };
}
