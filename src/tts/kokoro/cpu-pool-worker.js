// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { assertKokoroParallelModule, CPU_POOL_CONTROL, KOKORO_PARALLEL_ABI, kokoroCpuPoolLayout } from './parallel-compute.js';

/** Dedicated helpers receive a known compiled module and offsets, never model files.
 * @param {any} scope */
export function installKokoroCpuPoolWorker(scope) {
  let started = false, lastEpoch = 0, generation = '';
  /** @type {Int32Array|undefined} */
  let control;
  const fatal = (/** @type {unknown} */ error) => {
    if (control) { Atomics.store(control, CPU_POOL_CONTROL.failed, 1); for (let slot = 1; slot < 4; slot++) Atomics.notify(control, CPU_POOL_CONTROL.status + slot); }
    scope.postMessage({ cpuPool: { type: 'failed', generation, message: String(error) } });
  };
  scope.onmessage = async (/** @type {MessageEvent} */ { data }) => {
    const message = data?.cpuPool;
    if (started) { fatal(new Error('Duplicate speech helper initialization.')); return; }
    generation = typeof message?.generation === 'string' ? message.generation : '';
    started = true;
    try {
      if (message?.type !== 'init') throw new Error('Invalid speech helper initialization.');
      const { module, memory, layout, scratch, slot, port } = message;
      const buffer = /** @type {ArrayBufferLike} */ (memory?.buffer);
      if (scope.crossOriginIsolated !== true || typeof SharedArrayBuffer !== 'function' || !(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof SharedArrayBuffer)
        || ![1, 2, 3].includes(slot) || typeof message.generation !== 'string' || !(port instanceof MessagePort)) throw new Error('Invalid speech helper startup.');
      assertKokoroParallelModule(module);
      const instance = await WebAssembly.instantiate(/** @type {WebAssembly.Module} */ (module), { env: { memory } }), exports = /** @type {any} */ (instance.exports);
      if (exports.memory !== memory || exports.pn_abi_version() !== 1 || exports.pn_parallel_abi_version() !== KOKORO_PARALLEL_ABI
        || JSON.stringify(layout) !== JSON.stringify(kokoroCpuPoolLayout(Number(exports.__heap_base.value)))
        || !Number.isSafeInteger(scratch.offset) || scratch.offset < layout.base || scratch.offset % 16 || scratch.size !== 3270 * 32 * 2
        || scratch.offset + scratch.size > buffer.byteLength) throw new Error('Invalid speech helper memory layout.');
      exports.__stack_pointer.value = layout.stacks[slot];
      control = new Int32Array(memory.buffer, layout.control, CPU_POOL_CONTROL.words);
      const fence = control;
      Atomics.wait(fence, CPU_POOL_CONTROL.status + slot, 0, 0);
      port.onmessage = (/** @type {MessageEvent} */ { data: job }) => {
        try {
          if (!job || !Number.isInteger(job.epoch) || job.epoch <= lastEpoch || job.epoch !== Atomics.load(fence, CPU_POOL_CONTROL.epoch)
            || job.epoch !== Atomics.load(fence, CPU_POOL_CONTROL.published + slot) || Atomics.load(fence, CPU_POOL_CONTROL.closed) || Atomics.load(fence, CPU_POOL_CONTROL.failed)
            || ![job.begin, job.end].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) || job.begin >= job.end
            || !Array.isArray(job.args) || job.args.length !== 6 || job.args.some((/** @type {number} */ value) => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) || job.args[5] !== scratch.offset) throw new Error('Stale or invalid speech helper job.');
          lastEpoch = job.epoch;
          const status = exports.pn_kokoro_conv_integer_rows(...job.args, layout.parameters[slot], job.begin, job.end, scratch.size);
          if (status) throw new Error('Speech helper row range was refused.');
          Atomics.store(fence, CPU_POOL_CONTROL.status + slot, job.epoch); Atomics.notify(fence, CPU_POOL_CONTROL.status + slot);
        } catch (error) { fatal(error); }
      };
      port.onmessageerror = () => fatal(new Error('Unreadable speech helper job.')); port.start();
      scope.postMessage({ cpuPool: { type: 'ready', generation: message.generation, slot, shared: true, isolated: true } });
    } catch (error) { fatal(error); }
  };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') installKokoroCpuPoolWorker(self);
