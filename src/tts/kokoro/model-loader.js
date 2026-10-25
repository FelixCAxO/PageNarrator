// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import * as browserInference from '../../engines/browser-inference.js';
import { createKokoroTokenizer } from './tokenizer.js';
import { createEnglishPhonemizer } from './english-phonemizer.js';
import { createBrowserKokoroBackend } from './runtime.js';
import { KOKORO_DATA } from './model-data.js';
import { createPackagedKokoroCpuEngine } from './cpu-engine.js';
import { applyKokoroPhaseCorrection } from './phase-correction.js';
import { createKokoroDataLoader } from './data-loader.js';

export { createKokoroDataLoader } from './data-loader.js';

/** Low-level engine; the app loader applies its scheduler/warmup and worker wrapper.
 * @param {string} [modelId] @param {any} [options] */
export async function loadBrowserKokoroBackend(modelId = KOKORO_DATA.modelId, { device = 'webgpu', dtype = 'fp32',
  progress_callback = () => {}, runtime = globalThis.chrome?.runtime, inference = browserInference,
  loadData = null, phonemizerFactory = createEnglishPhonemizer, cpuEngineFactory = createPackagedKokoroCpuEngine, phaseCorrection = false, signal = null } = {}) {
  if (modelId !== KOKORO_DATA.modelId || !((device === 'webgpu' && dtype === 'fp32') || (device === 'wasm' && dtype === 'q8'))) throw new Error('Unsupported Kokoro model/backend combination.');
  signal?.throwIfAborted();
  const load = loadData ?? createKokoroDataLoader({ onProgress: progress_callback, signal });
  const decode = (/** @type {Uint8Array} */ bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const graphFile = dtype === 'q8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx';
  const work = await Promise.allSettled([load(graphFile), load('tokenizer.json'), load('tokenizer_config.json'),
    phonemizerFactory({ runtime })]);
  const failed = work.find(result => result.status === 'rejected');
  if (failed) {
    if (work[3].status === 'fulfilled') await work[3].value.dispose();
    throw failed.reason;
  }
  const [graph, tokenizerJson, tokenizerConfig, phonemizer] = work.map(result => {
    if (result.status !== 'fulfilled') throw new Error('Kokoro model preparation did not complete.');
    return result.value;
  });
  let session;
  /** @type {{dispose:()=>Promise<void>}|undefined} */
  let compute;
  try {
    const tokenizer = createKokoroTokenizer(decode(tokenizerJson), decode(tokenizerConfig));
    const corrected = phaseCorrection ? await applyKokoroPhaseCorrection(graph) : null;
    if (device === 'wasm') compute = await cpuEngineFactory({ runtime });
    const graphSession = await inference.InferenceSession.create(corrected?.bytes ?? graph, { executionProviders: [device], ...(compute ? { engine: compute } : {}) });
    session = graphSession;
    if (compute) {
      const ownedCompute = compute;
      let release;
      session = { run: graphSession.run.bind(graphSession), release() {
        release ??= (async () => {
          const errors = [];
          try { await graphSession.release(); } catch (error) { errors.push(error); }
          try { await ownedCompute.dispose(); } catch (error) { errors.push(error); }
          if (errors.length === 1) throw errors[0];
          if (errors.length) throw new AggregateError(errors, 'Kokoro CPU session and compute cleanup failed.');
        })();
        return release;
      } };
    }
    const backend = createBrowserKokoroBackend({ session, tokenizer, phonemizer, Tensor: inference.Tensor, loadStyle: async (/** @type {string} */ voice, { signal: styleSignal = signal } = {}) => {
      const bytes = await load(`voices/${voice}.bin`, ...(styleSignal ? [{ signal: styleSignal }] : []));
      if (bytes.byteLength !== 510 * 256 * 4) throw new Error(`Invalid Kokoro voice style: ${voice}.`);
      const style = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (!style.every(Number.isFinite)) throw new Error(`Non-finite Kokoro voice style: ${voice}.`);
      return style;
    } });
    if (corrected) {
      const { bytes: _bytes, ...metadata } = corrected;
      return Object.assign(backend, { modelInfo: metadata });
    }
    return backend;
  } catch (error) {
    const cleanup = await Promise.allSettled([session?.release(), !session ? compute?.dispose() : undefined, phonemizer.dispose()]);
    const failedCleanup = cleanup.filter(result => result.status === 'rejected');
    if (failedCleanup.length) throw new AggregateError([error, ...failedCleanup.map(result => result.reason)], 'Kokoro preparation and cleanup failed.');
    throw error;
  }
}
