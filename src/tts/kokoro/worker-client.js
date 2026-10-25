// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { cpuPoolFailure, createKokoroCpuPoolOwner, supportsKokoroCpuPool } from './cpu-pool.js';

/** Keep model execution off the reader's audio/highlighting thread.
 * @param {string} modelId @param {any} [options] */
export async function createKokoroWorkerBackend(modelId, { device = 'webgpu', dtype = 'fp32',
  phaseCorrection = true, progress_callback = () => {}, runtime = globalThis.chrome?.runtime,
  createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
  createHelper = (/** @type {number} */ slot, /** @type {string} */ generation) => new Worker(new URL('./cpu-pool-worker.js', import.meta.url), { type: 'module', name: `pn-kokoro-cpu-${generation}-${slot}` }),
  capabilities = globalThis, signal = null, shutdownMs = 2_000 } = {}) {
  signal?.throwIfAborted();
  if (!runtime?.getURL) throw new Error('Kokoro requires the PageNarrator extension runtime.');
  /** @type {Worker|null} */
  let worker = null;
  /** @type {Promise<any>|null} */
  let ready = null;
  /** @type {ReturnType<typeof createKokoroCpuPoolOwner>|null} */
  let cpuOwner = null;
  /** @type {Map<number, {resolve:Function,reject:Function}>} */
  const pending = new Map();
  let nextId = 0, nextStream = 0, nextGeneration = 0, closed = false, initialized = false, forceSerial = false, selectedParallel = false;
  /** @type {Promise<void>|null} */
  let disposal = null;
  const retirementTimers = new Map();
  const aborted = () => new DOMException('Kokoro synthesis was aborted.', 'AbortError');
  function stopWorker(/** @type {unknown} */ error = aborted()) {
    const current = worker; worker = null; ready = null; initialized = false;
    cpuOwner?.dispose(); cpuOwner = null; selectedParallel = false;
    current?.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const timer of retirementTimers.values()) clearTimeout(timer);
    retirementTimers.clear();
  }
  function retireAfterGrace(/** @type {number} */ id) {
    if (!retirementTimers.has(id)) retirementTimers.set(id, setTimeout(() => stopWorker(
      new DOMException('Kokoro worker did not stop within its shutdown deadline.', 'TimeoutError')), shutdownMs));
  }
  function stopPool(/** @type {unknown} */ cause) {
    forceSerial = true;
    stopWorker(cpuPoolFailure('Kokoro CPU worker group was retired.', cause));
  }
  /** @param {string} method @param {any} payload @param {Transferable[]} transfer */
  function post(method, payload, transfer) {
    const id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { if (!worker) throw new Error('Kokoro worker is unavailable.'); worker.postMessage({ ...payload, id, method }, transfer); }
      catch (error) { if (selectedParallel) stopPool(error); else { pending.delete(id); reject(error); } }
    });
    return { id, promise };
  }
  /** @param {boolean} parallel */
  async function startWorker(parallel) {
    let current;
    try { current = createWorker(); }
    catch (error) { throw parallel ? cpuPoolFailure('Kokoro CPU coordinator could not start.', error) : error; }
    worker = current; selectedParallel = parallel;
    const generation = String(++nextGeneration);
    if (parallel) cpuOwner = createKokoroCpuPoolOwner({ generation, coordinator: current, createHelper, fail: error => { if (worker === current) stopPool(error); } });
    current.onmessage = (/** @type {MessageEvent} */ { data }) => {
      if (worker !== current) return;
      if (data.cpuPool) {
        if (cpuOwner) cpuOwner.receive(data.cpuPool);
        else stopPool('Unexpected CPU worker group message.');
        return;
      }
      if (data.progress) { progress_callback(data.progress); return; }
      clearTimeout(retirementTimers.get(data.id)); retirementTimers.delete(data.id);
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
      else request.resolve(data.result);
    };
    const crash = (/** @type {unknown} */ error) => { if (worker === current) { if (parallel) stopPool(error); else stopWorker(error); } };
    current.onerror = (/** @type {ErrorEvent} */ event) => crash(new Error(event?.message || 'Kokoro worker stopped.'));
    current.onmessageerror = () => crash(new Error('Kokoro worker returned an unreadable message.'));
    try {
      const info = await post('init', { modelId, device, dtype, phaseCorrection, cpuGeneration: generation, cpuParallel: parallel, runtimeRoot: runtime.getURL('') }, []).promise;
      if (worker !== current || closed) throw aborted();
      initialized = true; return { info, worker: current };
    } catch (error) { if (worker === current) stopWorker(error); throw error; }
  }
  function ensureWorker() {
    if (closed) return Promise.reject(new Error('Kokoro worker is closed.'));
    if (ready) return ready;
    const parallel = device === 'wasm' && !forceSerial && supportsKokoroCpuPool(capabilities);
    const startup = startWorker(parallel).catch(error => {
      // Only startup of the optional group may retry. Active speech is never replayed.
      if (!parallel || closed || error?.code !== 'kokoro_cpu_pool_failed') throw error;
      forceSerial = true;
      const serial = startWorker(false); ready = serial; return serial;
    });
    ready = startup; return startup;
  }
  /** @param {string} method @param {any} [payload] @param {AbortSignal|null} [signal] @param {Transferable[]} [transfer] */
  function call(method, payload = {}, signal = null, transfer = []) {
    if (closed) return Promise.reject(new Error('Kokoro worker is closed.'));
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      let requestId = 0, cancelled = false;
      const cancel = () => {
        cancelled = true;
        const error = aborted();
        if (device === 'wasm' || !initialized) stopWorker(error);
        else if (requestId && worker) {
          try { worker.postMessage({ method: 'abort', requestId }); } catch { /* A crashed worker is already retired. */ }
          pending.get(requestId)?.reject(error); pending.delete(requestId);
          retireAfterGrace(requestId);
        }
        reject(error);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const task = (async () => {
        if (!initialized) {
          const result = await ensureWorker();
          if (worker !== result.worker) throw aborted();
        }
        if (cancelled || signal?.aborted) throw aborted();
        if (closed) throw new Error('Kokoro worker is closed.');
        const request = post(method, payload, transfer); requestId = request.id;
        return request.promise;
      })();
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      void task.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  /** AbortSignal is local; the worker owns its corresponding controller.
   * @param {any} [options] */
  const synthesisOptions = ({ voice = 'af_heart', speed = 1, split_pattern = null } = {}) => ({ voice, speed, split_pattern });
  const abortStartup = () => stopWorker(signal?.reason ?? aborted());
  signal?.addEventListener('abort', abortStartup, { once: true });
  try {
    const { info } = await ensureWorker();
    signal?.throwIfAborted();
    return {
      voices: Object.freeze(info.voices), modelInfo: info.modelInfo,
      list_voices: () => info.voices,
      abortGeneration() { if (device === 'wasm') stopWorker(); else for (const id of pending.keys()) retireAfterGrace(id); },
      prepareVoice: (/** @type {string} */ voice, /** @type {any} */ options = {}) => call('prepareVoice', { voice }, options.signal),
      generate: (/** @type {string} */ text, /** @type {any} */ options = {}) => call('generate', { text, options: synthesisOptions(options) }, options.signal),
      generate_from_ids(/** @type {BigInt64Array|{data:BigInt64Array}} */ ids, /** @type {any} */ options = {}) {
        const data = ids instanceof BigInt64Array ? ids : ids?.data;
        if (!(data instanceof BigInt64Array)) return Promise.reject(new Error('Invalid Kokoro phoneme ID sequence.'));
        // Never detach the caller's reusable token buffer.
        const copy = new BigInt64Array(data);
        return call('generate_from_ids', { ids: copy, options: synthesisOptions(options) }, options.signal, [copy.buffer]);
      },
      generateWarmup: (/** @type {any} */ options) => call('generateWarmup', { options: synthesisOptions(options), text: options.text, speechText: options.speechText }, options.signal),
      async *stream(/** @type {string} */ text, /** @type {any} */ options = {}) {
        const streamId = ++nextStream;
        try {
          while (true) {
            const result = await call('streamNext', { streamId, text, options: synthesisOptions(options) }, options.signal);
            if (result.done) return;
            yield result.value;
          }
        } finally {
          if (!closed && worker) {
            const cleanup = call('streamReturn', { streamId });
            // Let Stop return immediately. The worker queue still closes the
            // iterator before accepting the next native call or disposal.
            const current = worker;
            if (options.signal?.aborted) void cleanup.catch(error => { if (worker === current) stopWorker(error); });
            else await cleanup;
          }
        }
      },
      dispose() {
        disposal ??= (async () => {
          if (closed) return;
          closed = true;
          // Termination is the only preemptive cancellation for synchronous WASM.
          // Give GPU work a bounded chance to release its session before termination.
          const timer = setTimeout(() => stopWorker(), shutdownMs);
          try { if (device !== 'wasm' && worker) { await ready; await post('dispose', {}, []).promise; } }
          catch (error) { if (worker) throw error; }
          finally { clearTimeout(timer); stopWorker(); }
        })();
        return disposal;
      },
    };
  } catch (error) { closed = true; stopWorker(error); throw error; }
  finally { signal?.removeEventListener('abort', abortStartup); }
}
