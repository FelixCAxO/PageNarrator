// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { tensorSize } from './tensor-shape.js';
import { WebGpuOnnxSession } from './webgpu-onnx-session.js';
import { WebGpuCompute } from './webgpu-compute.js';
import { tensorArray } from './tensor-format.js';

/** Small browser-facing tensor API for OCR and neural audio decoding. */
export class Tensor {
  constructor(type, data, dims) {
    if (!(data instanceof tensorArray(type)) || tensorSize(dims) !== data.length
      || (type === 'bool' && data.some(value => value !== 0 && value !== 1))) throw new RangeError('Tensor data, type, and dimensions do not match.');
    this.type = type;
    this.data = data;
    this.dims = Object.freeze([...dims]);
    this.size = data.length;
  }

  async getData() {
    if (!this.data) throw new Error('The tensor has been disposed.');
    return this.data;
  }

  dispose() { this.data = null; }
}

export class InferenceSession {
  static async create(source, { executionProviders = ['webgpu'], ...options } = {}) {
    if (executionProviders.length !== 1 || !['webgpu', 'wasm'].includes(executionProviders[0])
      || (executionProviders[0] === 'wasm' && !options.engine)) throw new Error('The requested inference provider needs a supported compute engine.');
    if (typeof source === 'string' || source instanceof URL) {
      const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
      source = await response.arrayBuffer();
    }
    const session = await WebGpuOnnxSession.create(source, options);
    return new InferenceSession(session);
  }

  constructor(session) {
    this.session = session;
    this.inputNames = Object.freeze([...session.inputNames]);
    this.outputNames = Object.freeze([...session.outputNames]);
  }

  async run(feeds, outputNames) {
    for (const feed of Object.values(feeds)) if (!(feed instanceof Tensor) || !feed.data) throw new Error('Inference requires live input tensors.');
    const result = await this.session.run(Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, { data: tensor.data, shape: tensor.dims, type: tensor.type }])), outputNames);
    return Object.fromEntries(Object.entries(result).map(([name, tensor]) => [name,
      new Tensor(tensor.type ?? (tensor.data instanceof BigInt64Array ? 'int64' : tensor.data instanceof Int32Array ? 'int32' : 'float32'), tensor.data, tensor.shape)]));
  }

  release() {
    return this.disposal ??= this.session.dispose().finally(() => { this.onRelease?.(); this.onRelease = null; });
  }

  getDiagnostics() {
    const session = this.session;
    const buffers = new Set([...session.weights.values()].flatMap(weight => weight.shards ? weight.shards.map(shard => shard.tensor.buffer) : [weight.buffer]));
    return { hostWeightBytes: [...session.initializers.values()].reduce((sum, tensor) => sum + (tensor.rawData?.byteLength || 0), 0),
      gpuWeightBytes: [...buffers].reduce((sum, buffer) => sum + buffer.size, 0),
      retainedPlanBytes: [...session.cachedPlans.values()].reduce((sum, plan) => sum + plan.stats.planBytes, 0),
      lastRun: session.lastRun };
  }
}

/** One lazily created GPU device for a document's detector, reader and dewarper. */
export function createBrowserInferenceEngine({ float16 = false } = {}) {
  if (typeof float16 !== 'boolean') throw new TypeError('Shared inference float16 must be a boolean.');
  let compute, loading, closed = false, disposal;
  const sessions = new Set(), pending = new Set();
  const create = (source, options = {}) => {
    if (closed) return Promise.reject(new Error('The browser inference engine has been disposed.'));
    const task = (async () => {
      loading ??= WebGpuCompute.create({ float16 }).then(value => { compute = value; return value; });
      const engine = await loading;
      if (closed) throw new Error('The browser inference engine has been disposed.');
      const session = await InferenceSession.create(source, { ...options, engine });
      if (closed) { await session.release(); throw new Error('The browser inference engine has been disposed.'); }
      sessions.add(session);
      session.onRelease = () => sessions.delete(session);
      return session;
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  return {
    Tensor, InferenceSession: Object.freeze({ create }),
    dispose() {
      if (disposal) return disposal;
      closed = true;
      return disposal = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([...sessions].map(session => session.release()));
        sessions.clear();
        await compute?.dispose();
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    },
  };
}
