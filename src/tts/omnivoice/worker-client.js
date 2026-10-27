/** @param {any} [deps] */
export async function createOmniVoiceWorker({ onProgress = () => {}, runtime = globalThis.chrome?.runtime,
  createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) } = {}) {
  if (!runtime?.getURL) throw new Error('OmniVoice requires the PageNarrator extension runtime.');
  const worker = createWorker();
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  /** @param {Error|DOMException} [reason] */
  function close(reason = new DOMException('OmniVoice worker stopped.', 'AbortError')) {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const { reject, timer, abortTimer } of pending.values()) {
      clearTimeout(timer); clearTimeout(abortTimer);
      reject(reason);
    }
    pending.clear();
  }
  worker.onmessage = (/** @type {MessageEvent} */ { data }) => {
    if (data.progress) {
      for (const request of pending.values()) if (request.method === 'init') {
        clearTimeout(request.timer);
        request.timer = setTimeout(() => close(failure('OmniVoice init timed out.')), 180_000);
      }
      onProgress(data.progress); return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer); clearTimeout(request.abortTimer);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
    else request.resolve(data.result);
  };
  const failure = (/** @type {string} */ message) => Object.assign(new Error(message), { name: 'OmniVoiceWorkerError' });
  worker.onerror = (/** @type {ErrorEvent} */ event) => { event?.preventDefault?.(); close(failure(event?.message || 'OmniVoice worker crashed.')); };
  worker.onmessageerror = () => close(failure('OmniVoice worker returned an unreadable response.'));
  /** @param {string} method @param {Record<string, any>} [payload] */
  function call(method, payload = {}) {
    if (closed) return Promise.reject(failure('OmniVoice worker is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => close(failure(`OmniVoice ${method} timed out.`)), method === 'dispose' ? 5_000 : 180_000);
      pending.set(id, { resolve, reject, timer, method, abortTimer: null });
      try { worker.postMessage({ id, method, ...payload }); }
      catch { close(failure('Could not send a request to the OmniVoice worker.')); }
    });
  }
  return {
    init: (/** @type {string} */ baseUrl) => call('init', { baseUrl, runtimeRoot: runtime.getURL('') }),
    synthesize: (/** @type {any} */ request) => call('synthesize', { request }),
    abortGeneration() {
      if (closed) return;
      try { worker.postMessage({ method: 'abort' }); }
      catch { close(failure('Could not stop the OmniVoice worker.')); return; }
      for (const request of pending.values()) {
        if (request.method === 'synthesize' && !request.abortTimer) {
          request.abortTimer = setTimeout(() => close(failure('OmniVoice worker did not stop.')), 5_000);
        }
      }
    },
    terminate: close,
    async dispose() { if (!closed) { try { await call('dispose'); } finally { close(); } } },
  };
}
