import { clearSpeechPreloadState, waitForBoundedPromise } from './reader-engine-read-lifecycle.js';

/** One incoming model may warm while the active model keeps reading. */
export function createSpeechEngineHandoff({ prepareModel, createPreload, readPreload, getCurrentIndex,
  getChunk, prepareChunks = async (_index, _options) => {}, onError = () => {}, record = () => {} }) {
  let pending = null;
  let retired = Promise.resolve();
  let closed = false;
  const discard = entry => {
    if (!entry?.preload) return;
    clearSpeechPreloadState({ speechPreloads: entry.preloads, queuedHighlightIndices: new Set() });
    entry.preload = null; entry.preloads = new Map(); entry.ready = false;
  };
  function cancel() {
    const entry = pending;
    pending = null;
    if (!entry) return retired;
    entry.controller.abort(); discard(entry);
    retired = Promise.allSettled([retired, entry.work]).then(async () => {
      discard(entry);
      await entry.model?.dispose();
      record({ kind: 'engine_incoming_released', engine: entry.voice.engine });
    }).catch(onError);
    return retired;
  }
  function prime(entry) {
    if (pending !== entry || entry.controller.signal.aborted || entry.loading || !entry.model) return;
    if (entry.preload && entry.index >= getCurrentIndex()) return;
    discard(entry);
    entry.loading = true;
    entry.work = (async () => {
      // Fetch the following text asynchronously; never stall active speech to warm its replacement.
      const text = await waitForBoundedPromise(prepareChunks(getCurrentIndex() + 3), { signal: entry.controller.signal, timeoutMs: 0 });
      if (!text.ok) {
        if (entry.controller.signal.aborted) return;
        throw new Error('Could not prepare incoming speech text.');
      }
      if (pending !== entry || entry.controller.signal.aborted) return;
      const current = getCurrentIndex();
      const index = getChunk(current + 2) ? current + 2 : current + 1;
      if (!getChunk(index)) return;
      entry.index = index; entry.preloads = new Map();
      for (const target of [index, index + 1]) {
        if (!getChunk(target)) break;
        entry.preloads.set(target, createPreload(entry.voice, getChunk(target), {
          signal: entry.controller.signal, sectionIndex: target, tts: entry.model.tts, forceComplete: true,
        }));
      }
      entry.preload = entry.preloads.get(index);
      // A short first chunk must not hand off into an unprepared following paragraph.
      await Promise.all([...entry.preloads.values()].map(preload => readPreload(preload, { signal: entry.controller.signal })));
      if (pending === entry && !entry.controller.signal.aborted) {
        entry.ready = true;
        record({ kind: 'engine_incoming_audio_ready', engine: entry.voice.engine, chunkIndex: index });
      }
    })().catch(error => {
      if (pending === entry && !entry.controller.signal.aborted) { onError(error, entry.voice); void cancel(); }
    }).finally(() => { entry.loading = false; });
  }
  function request(voice) {
    if (closed || pending?.voice.id === voice.id && pending.voice.engine === voice.engine) return;
    const previous = cancel();
    const entry = { voice, controller: new AbortController(), model: null, preload: null, preloads: new Map(), index: -1, ready: false, loading: false, work: null };
    pending = entry;
    record({ kind: 'engine_incoming_requested', engine: voice.engine });
    entry.work = previous.then(async () => {
      if (pending !== entry || entry.controller.signal.aborted) return;
      entry.model = await prepareModel(voice, { signal: entry.controller.signal });
      if (pending !== entry || entry.controller.signal.aborted) return;
      record({ kind: 'engine_incoming_model_ready', engine: voice.engine });
      // Prime after initialization settles so cancellation never waits on itself.
      queueMicrotask(() => prime(entry));
    }).catch(error => {
      if (pending === entry && !entry.controller.signal.aborted) { onError(error, voice); void cancel(); }
    });
  }
  return {
    request, cancel,
    take(index) {
      const entry = pending;
      if (!entry) return null;
      if (entry.index < index) prime(entry);
      if (!entry.ready || entry.index !== index) return null;
      pending = null;
      record({ kind: 'engine_handoff', engine: entry.voice.engine, chunkIndex: index });
      return entry;
    },
    retire(disposal) { retired = Promise.allSettled([retired, disposal]).then(() => {}); },
    dispose() { closed = true; return cancel(); },
  };
}
