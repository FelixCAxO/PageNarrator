// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmKokoroCompute } from '../../engines/kokoro-cpu-compute.js';
import { cpuPoolFailure } from './cpu-pool.js';

export const KOKORO_PARALLEL_ABI = 0x504e5201;
export const KOKORO_CPU_MEMORY_LIMIT = 512 * 1024 * 1024;
export const CPU_POOL_CONTROL = Object.freeze({ epoch: 0, failed: 1, closed: 2, status: 4, published: 8, words: 16 });
const PAGE_BYTES = 65536, PARAMETER_BYTES = 8192, MAX_PRODUCTS = 3270, PRIVATE_SCRATCH_BYTES = MAX_PRODUCTS * 32 * 2;

/** @param {WebAssembly.Module} module */
export function assertKokoroParallelModule(module) {
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory') throw cpuPoolFailure('Parallel speech permits exactly its packaged platform memory import.');
  const exports = new Map(WebAssembly.Module.exports(module).map(item => [item.name, item.kind]));
  for (const name of ['pn_abi_version', 'pn_parallel_abi_version', 'pn_kokoro_conv_integer', 'pn_kokoro_conv_integer_rows']) if (exports.get(name) !== 'function') throw cpuPoolFailure('Parallel speech kernel exports are incomplete.');
  if (exports.get('memory') !== 'memory' || exports.get('__heap_base') !== 'global' || exports.get('__stack_pointer') !== 'global') throw cpuPoolFailure('Parallel speech memory exports are incomplete.');
}

/** @param {number} heapBase */
export function kokoroCpuPoolLayout(heapBase) {
  if (!Number.isSafeInteger(heapBase) || heapBase < 0) throw cpuPoolFailure('Invalid parallel speech heap.');
  const first = Math.ceil(heapBase / 16) * 16, stacks = Array.from({ length: 4 }, (_, i) => first + (i + 1) * PAGE_BYTES);
  const control = Math.ceil(stacks[3] / 64) * 64, parameters = Array.from({ length: 4 }, (_, i) => control + 256 + i * PARAMETER_BYTES);
  const base = parameters[3] + PARAMETER_BYTES;
  if (base >= KOKORO_CPU_MEMORY_LIMIT) throw cpuPoolFailure('Parallel speech reservations exceed the arena limit.');
  return { first, stacks, control, parameters, base };
}

/** @param {Uint32Array} p @param {boolean} [force] @returns {number[][]|null} */
export function kokoroCpuRowRanges(p, force = false) {
  if (!(p instanceof Uint32Array) || p.length !== 16) throw cpuPoolFailure('Invalid parallel speech operation metadata.');
  const products = p[5] * p[7];
  if (p[0] !== 1 || p[1] !== p[5] || p[3] !== p[6] || p[3] < 8 || !p[2] || !p[4] || p[5] < 2 || !p[7] || !p[8] || !p[9]
    || !p[15] || p[15] > 32 || products < 8 || products > MAX_PRODUCTS || products * 65025 > 2147483647
    || (p[4] - 1) * p[8] + (p[7] - 1) * p[9] > 2147483647 || p[10] > 2147483647
    || p[11] > 1 || p[12] > 1 || p[13] > 1 || ![0, 1, p[3]].includes(p[14])) return null;
  if (!force && (p[4] < 32 || p[3] * p[4] * products < 1_000_000)) return null;
  const pairs = Math.floor(p[3] / 2);
  return Array.from({ length: 4 }, (_, i) => [Math.floor(pairs * i / 4) * 2, i === 3 ? p[3] : Math.floor(pairs * (i + 1) / 4) * 2]);
}

/** @param {Int32Array} control @param {number} slot @param {number} epoch @param {number} deadline */
function waitForRows(control, slot, epoch, deadline) {
  while (true) {
    if (Atomics.load(control, CPU_POOL_CONTROL.closed) || Atomics.load(control, CPU_POOL_CONTROL.failed)) throw cpuPoolFailure('Parallel speech arena was retired.');
    const state = Atomics.load(control, CPU_POOL_CONTROL.status + slot);
    if (state === epoch) return;
    if (state !== 0) throw cpuPoolFailure('Parallel speech completion epoch is invalid.');
    const remaining = deadline - performance.now();
    if (remaining <= 0 || Atomics.wait(control, CPU_POOL_CONTROL.status + slot, state, remaining) === 'timed-out') throw cpuPoolFailure('Parallel speech completion timed out.');
  }
}

// The existing engine's declarations expose its public factory, while this narrow subclass also reuses its owned arena implementation.
const BaseCompute = /** @type {any} */ (WasmKokoroCompute);
export class KokoroParallelCompute extends BaseCompute {
  /** @param {any} exports @param {ReturnType<typeof kokoroCpuPoolLayout>} layout @param {(error:unknown)=>void} fail @param {()=>void} release */
  constructor(exports, layout, fail, release) {
    super({ ...exports, __heap_base: { value: layout.parameters[0] } }, KOKORO_CPU_MEMORY_LIMIT);
    this.base = this.cursor = layout.base; this.ensure(layout.base);
    this.layout = layout; this.fail = fail; this.releasePool = release;
    this.control = new Int32Array(this.memory.buffer, layout.control, CPU_POOL_CONTROL.words);
    this.workspaces = Array.from({ length: 3 }, () => this.allocate(PRIVATE_SCRATCH_BYTES));
    /** @type {Map<number,MessagePort>} */
    this.peers = new Map();
    this.poolFailed = false;
  }
  /** @param {string} name @param {any[]} tensors @param {Uint32Array} parameters @param {number[]} [extra] */
  invoke(name, tensors, parameters, extra = []) {
    if (name !== 'pn_kokoro_conv_integer') return super.invoke(name, tensors, parameters, extra);
    const ranges = kokoroCpuRowRanges(parameters);
    if (!ranges) return super.invoke(name, tensors, parameters, extra);
    try {
      this.checkOpen();
      if (this.poolFailed || this.peers.size !== 3 || Atomics.load(this.control, CPU_POOL_CONTROL.closed) || Atomics.load(this.control, CPU_POOL_CONTROL.failed)) throw cpuPoolFailure('Parallel speech pool is unavailable.');
      const epoch = Atomics.load(this.control, CPU_POOL_CONTROL.epoch) + 1;
      if (epoch >= 2147483647) throw cpuPoolFailure('Parallel speech epoch is exhausted.');
      Atomics.store(this.control, CPU_POOL_CONTROL.epoch, epoch);
      const args = tensors.map(tensor => tensor.buffer.offset), deadline = performance.now() + 10000;
      for (let slot = 1; slot < 4; slot++) {
        Atomics.store(this.control, CPU_POOL_CONTROL.status + slot, 0);
        new Uint32Array(this.memory.buffer, this.layout.parameters[slot], 16).set(parameters);
        const offsets = [...args]; offsets[5] = this.workspaces[slot - 1].offset;
        Atomics.store(this.control, CPU_POOL_CONTROL.published + slot, epoch);
        this.peers.get(slot)?.postMessage({ epoch, args: offsets, begin: ranges[slot][0], end: ranges[slot][1] });
      }
      new Uint32Array(this.memory.buffer, this.layout.parameters[0], 16).set(parameters);
      const status = this.exports.pn_kokoro_conv_integer_rows(...args, this.layout.parameters[0], ...ranges[0], tensors[5].buffer.size);
      if (status) throw cpuPoolFailure('Parallel speech row range was refused.');
      for (let slot = 1; slot < 4; slot++) waitForRows(this.control, slot, epoch, deadline);
    } catch (cause) {
      const error = cpuPoolFailure('Parallel speech execution failed.', cause);
      this.poolFailed = true; Atomics.store(this.control, CPU_POOL_CONTROL.failed, 1);
      for (let slot = 1; slot < 4; slot++) Atomics.notify(this.control, CPU_POOL_CONTROL.status + slot);
      this.fail(error); throw error;
    }
  }
  async dispose() {
    if (this.closed) return;
    try {
      for (const buffer of this.workspaces) if (this.buffers.has(buffer)) this.freeBuffer(buffer);
      this.workspaces.length = 0;
      for (const port of this.peers.values()) port.close(); this.peers.clear();
      Atomics.store(this.control, CPU_POOL_CONTROL.closed, 1); this.releasePool();
    } finally { await super.dispose(); }
  }
}

/** The shared ABI is permitted only for this hash-verified packaged artifact.
 * @param {any} options */
export async function createPackagedKokoroParallelEngine({ runtime, connect, fail, release, fetcher = globalThis.fetch?.bind(globalThis) }) {
  /** @type {KokoroParallelCompute|undefined} */
  let engine;
  try {
    if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== 'function' || typeof Atomics.wait !== 'function' || !runtime?.getURL || !fetcher) throw cpuPoolFailure('Parallel speech capabilities are unavailable.');
    const [binaryResponse, metadataResponse] = await Promise.all([fetcher(runtime.getURL('native/kokoro-parallel.wasm')), fetcher(runtime.getURL('native/kokoro-parallel.json'))]);
    if (!binaryResponse.ok || !metadataResponse.ok) throw cpuPoolFailure('Packaged parallel speech engine is unavailable.');
    const [bytes, metadata] = await Promise.all([binaryResponse.arrayBuffer(), metadataResponse.json()]);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (metadata.abi !== 1 || metadata.parallelAbi !== KOKORO_PARALLEL_ABI || metadata.maximumMemoryBytes !== KOKORO_CPU_MEMORY_LIMIT
      || metadata.wasmSha256 !== digest || !/^[a-f0-9]{64}$/.test(metadata.originalWasmSha256)
      || JSON.stringify(metadata.imports) !== JSON.stringify([{ module: 'env', name: 'memory', kind: 'memory' }])) throw cpuPoolFailure('Packaged parallel speech identity is invalid.');
    const module = await WebAssembly.compile(bytes); assertKokoroParallelModule(module);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: KOKORO_CPU_MEMORY_LIMIT / PAGE_BYTES, shared: true });
    const instance = await WebAssembly.instantiate(module, { env: { memory } }), exports = /** @type {any} */ (instance.exports);
    if (exports.memory !== memory || exports.pn_abi_version() !== 1 || exports.pn_parallel_abi_version() !== KOKORO_PARALLEL_ABI || !(exports.__stack_pointer instanceof WebAssembly.Global)) throw cpuPoolFailure('Packaged parallel speech ABI is invalid.');
    const layout = kokoroCpuPoolLayout(Number(exports.__heap_base.value));
    if (memory.buffer.byteLength < layout.base) memory.grow(Math.ceil((layout.base - memory.buffer.byteLength) / PAGE_BYTES));
    exports.__stack_pointer.value = layout.stacks[0];
    engine = new KokoroParallelCompute(exports, layout, fail, release);
    engine.peers = await connect({ module, memory, layout, scratch: engine.workspaces, abi: KOKORO_PARALLEL_ABI });
    if (engine.peers.size !== 3) throw cpuPoolFailure('Parallel speech pool startup is incomplete.');
    return engine;
  } catch (cause) {
    const error = cpuPoolFailure('Parallel speech engine preparation failed.', cause);
    fail(error); await engine?.dispose(); throw error;
  }
}
