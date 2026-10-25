// Development-only browser instrumentation. The packaged PDF bytes stay unchanged.
export function observePdfPhases() {
  const trace = window.__pnPdfPhases = { origin: performance.now(), visibility: document.visibilityState, visibilityChanges: [], workers: [], fonts: [], canvases: [], textLayers: [], timers: [], instrumentationMs: 0 };
  const now = () => performance.now() - trace.origin;
  document.addEventListener('visibilitychange', () => trace.visibilityChanges.push({ timeMs: now(), state: document.visibilityState }));
  const nativeTimeout = window.setTimeout;
  window.setTimeout = function (callback, delay, ...args) {
    if (typeof callback !== 'function' || Number(delay || 0) > 10 || trace.timers.length >= 10000) return nativeTimeout.call(this, callback, delay, ...args);
    const record = { requestedMs: now(), delay: Number(delay || 0), firedMs: null }; trace.timers.push(record);
    return nativeTimeout.call(this, function (...values) { record.firedMs = now(); return callback.apply(this, values); }, delay, ...args);
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options); this.phaseRecord = { url: String(url), openedMs: now(), closedMs: null, requests: [] };
      this.phasePending = new Map(); trace.workers.push(this.phaseRecord);
      this.addEventListener('message', ({ data }) => {
        const overhead = performance.now(), record = this.phasePending.get(data?.id); if (!record) return;
        record.endMs = now(); record.elapsedMs = record.endMs - record.startMs; this.phasePending.delete(data.id);
        if (data.error) record.error = data.error;
        if (record.method === 'pagePayload' && data.result) {
          const operations = {};
          const visit = commands => { for (const command of commands) { operations[command.op] = (operations[command.op] || 0) + 1; if (command.commands) visit(command.commands); } };
          visit(data.result.commands || []);
          Object.assign(record, { items: data.result.items?.length, commands: data.result.commands?.length, fonts: data.result.fonts?.length, operations });
        }
        trace.instrumentationMs += performance.now() - overhead;
      });
    }
    postMessage(message, ...rest) {
      if (message?.method) {
        const record = { id: message.id, method: message.method, page: ['pageInfo', 'pagePayload', 'cleanup'].includes(message.method) ? message.args?.[0] : null, startMs: now(), endMs: null };
        this.phaseRecord.requests.push(record); this.phasePending.set(message.id, record);
      }
      return super.postMessage(message, ...rest);
    }
    terminate() { this.phaseRecord.closedMs = now(); return super.terminate(); }
  };
  const nativeFontLoad = FontFace.prototype.load;
  FontFace.prototype.load = function (...args) {
    const record = { family: this.family, startMs: now(), endMs: null }; trace.fonts.push(record);
    return nativeFontLoad.apply(this, args).then(face => { record.endMs = now(); record.elapsedMs = record.endMs - record.startMs; return face; }, error => { record.endMs = now(); record.error = error.message; throw error; });
  };
  const canvases = new WeakMap();
  for (const prototype of [CanvasRenderingContext2D.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
  for (const name of ['save', 'restore', 'setTransform', 'transform', 'fillRect', 'fillText', 'measureText', 'fill', 'stroke', 'drawImage', 'putImageData', 'getImageData', 'clip', 'beginPath', 'lineTo', 'bezierCurveTo']) {
    const original = prototype[name]; if (typeof original !== 'function') continue;
    prototype[name] = function (...args) {
      const overhead = performance.now(), page = this.canvas.closest?.('.pdf-page'); let record;
      record = canvases.get(this.canvas);
      if (!record) { record = { page: page ? Number(page.dataset.pageNumber) : null, kind: page ? 'page' : typeof OffscreenCanvas === 'function' && this.canvas instanceof OffscreenCanvas ? 'offscreen' : 'detached', width: this.canvas.width, height: this.canvas.height,
        firstMs: now(), lastMs: null, calls: {}, nativeCallMs: 0 }; canvases.set(this.canvas, record); trace.canvases.push(record); }
      record.calls[name] = (record.calls[name] || 0) + 1;
      trace.instrumentationMs += performance.now() - overhead;
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { if (record) { record.nativeCallMs += performance.now() - start; record.lastMs = now(); } }
    };
  }
  }
  const layers = new WeakMap();
  new MutationObserver(mutations => {
    const overhead = performance.now();
    for (const mutation of mutations) {
      const layer = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target.closest?.('.textLayer') : mutation.target.parentElement?.closest('.textLayer');
      if (!layer) continue;
      let record = layers.get(layer);
      if (!record) { record = { page: Number(layer.closest('.pdf-page')?.dataset.pageNumber), firstMutationMs: now(), firstSpanMs: null, annotationCompleteMs: null }; layers.set(layer, record); trace.textLayers.push(record); }
      if (record.firstSpanMs === null && layer.querySelector('span')) record.firstSpanMs = now();
      if (record.annotationCompleteMs === null && layer.hasAttribute('data-pagenarrator-pdf-text')) record.annotationCompleteMs = now();
    }
    trace.instrumentationMs += performance.now() - overhead;
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pagenarrator-pdf-text'] });
}
