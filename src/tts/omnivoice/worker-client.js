/** @param {any} [deps] */
export async function createOmniVoiceWorker({ onProgress = () => {}, runtime = globalThis.chrome?.runtime,
  createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) } = {}) {
  if (!runtime?.getURL) throw new Error('OmniVoice requires the PageNarrator extension runtime.');
  const worker = createWorker();
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const { reject } of pending.values()) reject(new DOMException('OmniVoice worker stopped.', 'AbortError'));
    pending.clear();
  }
  worker.onmessage = (/** @type {MessageEvent} */ { data }) => {
    if (data.progress) { onProgress(data.progress); return; }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
    else request.resolve(data.result);
  };
  worker.onerror = close;
  /** @param {string} method @param {Record<string, any>} [payload] */
  function call(method, payload = {}) {
    if (closed) return Promise.reject(new Error('OmniVoice worker is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, ...payload }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  return {
    init: (/** @type {string} */ baseUrl) => call('init', { baseUrl, runtimeRoot: runtime.getURL('') }),
    synthesize: (/** @type {any} */ request) => call('synthesize', { request }),
    abortGeneration() { if (!closed) worker.postMessage({ method: 'abort' }); },
    terminate: close,
    async dispose() { if (!closed) { try { await call('dispose'); } finally { close(); } } },
  };
}
