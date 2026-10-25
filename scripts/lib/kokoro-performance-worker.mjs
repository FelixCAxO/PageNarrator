// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development instrumentation only. The app worker host and model/math code are unchanged.
import { installKokoroWorker } from '../../src/tts/kokoro/worker-host.js';
import { loadBrowserKokoroBackend } from '../../src/tts/kokoro/model-loader.js';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';
import { createKokoroCpuPoolBridge } from '../../src/tts/kokoro/cpu-pool.js';
import { WebGpuCompute } from '../../src/engines/webgpu-compute.js';
import * as inference from '../../src/engines/browser-inference.js';

const engines = [], sessions = [], phonemizers = [], inputs = [];
export function observeKokoroEngine(engine) {
  if (engines.some(item => item.engine === engine)) return engine;
  const item = { engine, peakLiveBufferBytes: [...engine.buffers].reduce((sum, buffer) => sum + buffer.size, 0),
    peakArenaBytes: engine.memory?.buffer.byteLength ?? null, allocations: 0,
    cpuPoolWorkers: engine.peers ? engine.peers.size + 1 : 'memory' in engine ? 1 : null,
    sharedInferenceArena: typeof SharedArrayBuffer === 'function' && engine.memory?.buffer instanceof SharedArrayBuffer };
  const allocator = typeof engine.allocate === 'function' ? 'allocate' : 'buffer';
  if (typeof engine[allocator] !== 'function') throw new Error('Unknown original engine allocator.');
  const allocate = engine[allocator].bind(engine);
  engine[allocator] = (...args) => {
    const result = allocate(...args); item.allocations++;
    item.peakLiveBufferBytes = Math.max(item.peakLiveBufferBytes, [...engine.buffers].reduce((sum, buffer) => sum + buffer.size, 0));
    if (engine.memory) item.peakArenaBytes = Math.max(item.peakArenaBytes ?? 0, engine.memory.buffer.byteLength);
    return result;
  };
  engines.push(item); return engine;
}
export function kokoroPerformanceSnapshot() {
  return { scope: 'Original engine-owned GPU buffers or WASM arena only; excludes JS model bytes, browser/driver/process memory. Peaks include allocation instrumentation overhead.',
    engines: engines.map(({ engine, ...peak }) => ({ ...peak, backend: 'memory' in engine ? 'wasm' : 'webgpu', closed: engine.closed, remainingBuffers: engine.buffers.size,
      remainingTensors: engine.tensors.size, liveBufferBytes: [...engine.buffers].reduce((sum, buffer) => sum + buffer.size, 0),
      arenaBytes: engine.memory?.buffer.byteLength ?? null, nativeMemoryReleased: 'memory' in engine ? engine.memory === null : null,
      deviceLost: engine.lost ? { reason: engine.lost.reason, message: engine.lost.message } : null,
      unexpectedDeviceLoss: Boolean(engine.lost && !(engine.closed && engine.lost.reason === 'destroyed')),
      completionError: engine.completionError ? { name: engine.completionError.name, message: engine.completionError.message } : null })),
    modelReferencesReleased: sessions.every(session => session.session.model === null),
    phonemizerNativeBytes: phonemizers.reduce((sum, value) => sum + value.diagnostics().nativeMemoryBytes, 0), inputs };
}
const adapter = { Tensor: inference.Tensor, InferenceSession: { async create(source, options) {
  const session = await inference.InferenceSession.create(source, options); sessions.push(session);
  const run = session.run.bind(session);
  session.run = (feeds, outputs) => {
    const ids = feeds.input_ids.data, style = feeds.style.data;
    inputs.push({ ids: Array.from(ids, Number), styleBits: Array.from(new Uint32Array(style.buffer, style.byteOffset, style.length)),
      speedBits: Array.from(new Uint32Array(feeds.speed.data.buffer, feeds.speed.data.byteOffset, 1)) });
    return run(feeds, outputs);
  };
  return session;
} } };
if (typeof self !== 'undefined' && typeof document === 'undefined') {
const cpu = createKokoroCpuPoolBridge(self);
installKokoroWorker(self, { async loadBackend(modelId, options) {
  const createGpu = WebGpuCompute.create;
  WebGpuCompute.create = async (...args) => observeKokoroEngine(await createGpu.call(WebGpuCompute, ...args));
  try {
    const backend = await loadBrowserKokoroBackend(modelId, { ...options, inference: adapter,
      cpuEngineFactory: async options => observeKokoroEngine(await cpu.createEngine(options)),
      phonemizerFactory: async options => { const value = await createEnglishPhonemizer(options); phonemizers.push(value); return value; } });
    const dispose = backend.dispose.bind(backend);
    backend.dispose = async () => { await dispose(); self.postMessage({ performanceFinal: kokoroPerformanceSnapshot() }); };
    return backend;
  } finally { WebGpuCompute.create = createGpu; }
} });
const receive = self.onmessage;
self.onmessage = event => {
  if (event.data.probeSnapshot) self.postMessage({ probeSnapshot: event.data.probeSnapshot, snapshot: kokoroPerformanceSnapshot() });
  else if (!cpu.receive(event.data)) receive(event);
};
}
