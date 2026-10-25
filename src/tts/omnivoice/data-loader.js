// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { OMNIVOICE_DATA } from './model-data.js';
import { loadVerifiedFile } from '../verified-download.js';

/** Verified model data response without a second Response body copy of the large weights.
 * @param {any} [options] */
export function createOmniVoiceDataFetch({ manifest = OMNIVOICE_DATA, fetcher = globalThis.fetch?.bind(globalThis),
  cacheStorage = globalThis.caches, onProgress = () => {} } = {}) {
  const base = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/`;
  const files = new Map(manifest.files.map((/** @type {{path:string,bytes:number,sha256:string}} */ file) => [`${base}${file.path}`, file]));
  const pending = new Map();
  const reportCache = (/** @type {unknown} */ error) => onProgress({ message: `OmniVoice cache unavailable: ${String(error)}` });
  return function fetchData(/** @type {string} */ url) {
    const file = files.get(url);
    if (!file) return Promise.reject(new Error('Unexpected OmniVoice model URL.'));
    if (pending.has(url)) return pending.get(url);
    const task = (async () => {
      onProgress({ message: `Preparing OmniVoice ${file.path}…` });
      const cache = await cacheStorage?.open('pagenarrator-omnivoice-v1').catch(reportCache);
      const data = (await loadVerifiedFile(url, file, { label: 'OmniVoice', cache, fetcher, onCacheError: reportCache,
        onDownload: () => onProgress({ status: 'download', file: file.path, loaded: 0, total: file.bytes }),
        onProgress: (loaded, total) => onProgress({ status: 'progress', file: file.path, loaded, total }),
        onCacheInvalid: error => onProgress({ message: `Replacing corrupt OmniVoice data: ${file.path}.`, error: String(error) }) })).buffer;
      return { ok: true, arrayBuffer: async () => data,
        json: async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) };
    })();
    pending.set(url, task);
    void task.finally(() => pending.delete(url)).catch(() => undefined);
    return task;
  };
}
