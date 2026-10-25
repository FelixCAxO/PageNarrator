// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { loadBrowserKokoroBackend } from './model-loader.js';

/** One queue owns the native session, including cleanup after a caller aborts.
 * GPU aborts drain this queue. The client terminates the whole CPU worker to
 * preempt synchronous WASM, then reopens it lazily from verified model data.
 * @param {any} scope @param {any} [dependencies] */
export function installKokoroWorker(scope, { loadBackend = loadBrowserKokoroBackend } = {}) {
  /** @type {any} */
  let backend;
  let queue = Promise.resolve(), retired = false;
  /** @type {Map<number, AbortController>} */
  const controllers = new Map();
  /** @type {Map<number, {controller:AbortController,iterator:any}>} */
  const streams = new Map();
  /** @param {any} error @returns {any} */
  function failure(error) {
    return { name: error?.name || 'Error', message: error?.message || String(error),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}) };
  }
  scope.onmessage = (/** @type {MessageEvent} */ { data }) => {
    if (data.method === 'abort') { controllers.get(data.requestId)?.abort(); return; }
    let controller = new AbortController();
    if (data.method === 'streamNext') {
      if (!streams.has(data.streamId)) streams.set(data.streamId, { controller, iterator: null });
      controller = /** @type {{controller:AbortController,iterator:any}} */ (streams.get(data.streamId)).controller;
    }
    controllers.set(data.id, controller);
    const task = queue.then(async () => {
      try {
        if (retired) throw new Error('Kokoro worker has been disposed.');
        if (controller.signal.aborted) throw new DOMException('Kokoro synthesis was aborted.', 'AbortError');
        let result;
        if (data.method === 'init') {
          if (backend) throw new Error('Kokoro worker is already initialized.');
          backend = await loadBackend(data.modelId, { device: data.device, dtype: data.dtype, phaseCorrection: data.phaseCorrection,
            signal: controller.signal, runtime: { getURL: (/** @type {string} */ path) => new URL(path, data.runtimeRoot).href },
            progress_callback: (/** @type {any} */ progress) => scope.postMessage({ progress }) });
          result = { voices: backend.voices, modelInfo: backend.modelInfo };
        } else {
          if (!backend) throw new Error('Kokoro worker is not initialized.');
          const options = { ...data.options, signal: controller.signal };
          if (data.method === 'prepareVoice') result = await backend.prepareVoice(data.voice, { signal: controller.signal });
          else if (data.method === 'generate') result = await backend.generate(data.text, options);
          else if (data.method === 'generate_from_ids') result = await backend.generate_from_ids(data.ids, options);
          else if (data.method === 'generateWarmup') {
            const { voice = 'af_heart', speed = 1 } = data.options || {};
            const { text = 'a', speechText } = data;
            result = speechText ? await backend.generate(speechText, { voice, speed, signal: controller.signal })
              : await backend.generate_from_ids(backend.tokenizer(text, { truncation: true }).input_ids, { voice, speed, signal: controller.signal });
          } else if (data.method === 'streamNext') {
            const state = streams.get(data.streamId);
            if (!state) throw new Error('Unknown Kokoro stream.');
            state.iterator ??= backend.stream(data.text, options)[Symbol.asyncIterator]();
            result = await state.iterator.next();
            if (result.done) streams.delete(data.streamId);
          } else if (data.method === 'streamReturn') {
            const state = streams.get(data.streamId); streams.delete(data.streamId);
            await state?.iterator?.return?.();
          } else if (data.method === 'dispose') {
            retired = true;
            const cleanup = await Promise.allSettled([...streams.values()].map(state => state.iterator?.return?.()));
            streams.clear();
            const release = await Promise.allSettled([backend.dispose()]);
            const errors = [...cleanup, ...release].filter(value => value.status === 'rejected');
            if (errors.length) throw new AggregateError(errors.map(value => value.reason), 'Kokoro worker cleanup failed.');
          } else throw new Error('Unknown Kokoro worker method.');
        }
        if (controller.signal.aborted) throw new DOMException('Kokoro synthesis was aborted.', 'AbortError');
        const audio = result?.audio instanceof Float32Array ? result.audio : result?.value?.audio?.audio;
        scope.postMessage({ id: data.id, result }, audio ? [audio.buffer] : []);
      } catch (error) { scope.postMessage({ id: data.id, error: failure(error) }); }
      finally { controllers.delete(data.id); }
    });
    queue = task.catch(() => undefined);
  };
}
