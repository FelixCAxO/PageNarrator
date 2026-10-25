// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

/** @param {string} message @param {unknown} [cause] */
export function cpuPoolFailure(message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: 'kokoro_cpu_pool_failed' });
}

/** Only the measured four-worker configuration is selected; all other hosts retain the existing engine.
 * @param {any} [scope] */
export function supportsKokoroCpuPool(scope = globalThis) {
  return scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === 'function' && typeof scope.Atomics?.wait === 'function'
    && Number.isInteger(scope.navigator?.hardwareConcurrency) && scope.navigator.hardwareConcurrency >= 4;
}

/** The extension document, outside synchronous WASM, owns every sibling handle.
 * @param {{generation:string,coordinator:Worker,createHelper:(slot:number,generation:string)=>Worker,fail:(error:unknown)=>void}} options */
export function createKokoroCpuPoolOwner({ generation, coordinator, createHelper, fail }) {
  /** @type {Worker[]} */
  const helpers = [];
  /** @type {MessagePort[]} */
  const ports = [];
  /** @type {Int32Array|null} */
  let control = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  let started = false, closed = false;
  const ready = new Set();
  function dispose() {
    if (closed) return; closed = true; clearTimeout(timer);
    if (control) { Atomics.store(control, 2, 1); for (let slot = 1; slot < 4; slot++) Atomics.notify(control, 4 + slot); }
    for (const helper of helpers) helper.terminate(); helpers.length = 0;
    for (const port of ports) port.close(); ports.length = 0; control = null;
  }
  const failure = (/** @type {unknown} */ cause) => { if (!closed) { dispose(); fail(cpuPoolFailure('Speech helper pool failed.', cause)); } };
  return {
    dispose,
    /** @param {any} message */
    receive(message) {
      if (message?.generation !== generation || closed) return;
      if (message.type === 'failed') { failure(message.message); return; }
      if (message.type === 'release') { dispose(); return; }
      if (message.type !== 'start') { failure('Unknown speech helper pool message.'); return; }
      try {
        if (started || message.abi !== 0x504e5201 || !(message.module instanceof WebAssembly.Module) || !(message.memory instanceof WebAssembly.Memory)
          || typeof SharedArrayBuffer !== 'function' || !(message.memory.buffer instanceof SharedArrayBuffer) || message.memory.buffer.byteLength > 536870912
          || !Array.isArray(message.scratch) || message.scratch.length !== 3 || !Number.isSafeInteger(message.layout?.control)) throw new Error('Invalid speech helper pool startup.');
        const imports = WebAssembly.Module.imports(message.module);
        if (imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory') throw new Error('Unexpected speech helper module imports.');
        started = true; control = new Int32Array(message.memory.buffer, message.layout.control, 16);
        timer = setTimeout(() => failure('Speech helper startup timed out.'), 15000);
        for (let slot = 1; slot < 4; slot++) {
          const helper = createHelper(slot, generation), channel = new MessageChannel(); helpers.push(helper); ports.push(channel.port1, channel.port2);
          helper.onerror = event => failure(event.message || 'Speech helper stopped.'); helper.onmessageerror = () => failure('Unreadable speech helper message.');
          helper.onmessage = ({ data }) => {
            const reply = data.cpuPool;
            if (closed || reply?.generation !== generation) return;
            if (reply.type !== 'ready' || reply.slot !== slot || !reply.shared || !reply.isolated || ready.has(slot)) { failure(reply.message || 'Invalid speech helper readiness.'); return; }
            ready.add(slot);
            if (ready.size === 3) { clearTimeout(timer); coordinator.postMessage({ cpuPool: { type: 'ready', generation } }); }
          };
          coordinator.postMessage({ cpuPool: { type: 'peer', generation, slot, port: channel.port1 } }, [channel.port1]);
          helper.postMessage({ cpuPool: { type: 'init', generation, slot, module: message.module, memory: message.memory, layout: message.layout, scratch: message.scratch[slot - 1], port: channel.port2 } }, [channel.port2]);
        }
      } catch (error) { failure(error); }
    },
  };
}

/** Pool bootstrap messages bypass the existing inference queue while its CPU factory awaits readiness.
 * @param {any} scope */
export function createKokoroCpuPoolBridge(scope) {
  let generation = '', parallel = false;
  /** @type {Map<number,MessagePort>} */
  const peers = new Map();
  /** @type {{resolve:Function,reject:Function,timer:ReturnType<typeof setTimeout>}|null} */
  let waiting = null;
  const fail = (/** @type {unknown} */ error) => scope.postMessage({ cpuPool: { type: 'failed', generation, message: String(error) } });
  return {
    /** @param {any} data @returns {boolean} */
    receive(data) {
      if (data.method === 'init') { generation = data.cpuGeneration; parallel = data.cpuParallel === true; return false; }
      if (!data.cpuPool) return false;
      const message = data.cpuPool;
      if (!waiting || message.generation !== generation) return true;
      if (message.type === 'peer' && [1, 2, 3].includes(message.slot) && message.port instanceof MessagePort && !peers.has(message.slot)) peers.set(message.slot, message.port);
      else if (message.type === 'ready' && peers.size === 3) { const current = waiting; waiting = null; clearTimeout(current.timer); current.resolve(peers); }
      else { const current = waiting; waiting = null; clearTimeout(current.timer); current.reject(cpuPoolFailure('Invalid speech helper bootstrap message.')); }
      return true;
    },
    /** @param {any} options */
    async createEngine(options) {
      if (!parallel) { const { createPackagedKokoroCpuEngine } = await import('./cpu-engine.js'); return createPackagedKokoroCpuEngine(options); }
      const { createPackagedKokoroParallelEngine } = await import('./parallel-compute.js');
      return createPackagedKokoroParallelEngine({ ...options, fail,
        release() { for (const port of peers.values()) port.close(); peers.clear(); scope.postMessage({ cpuPool: { type: 'release', generation } }); },
        connect(/** @type {any} */ payload) {
          if (waiting || peers.size) return Promise.reject(cpuPoolFailure('Duplicate speech helper bootstrap.'));
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiting = null; reject(cpuPoolFailure('Speech helper bootstrap timed out.')); }, 15000);
            waiting = { resolve, reject, timer };
            try { scope.postMessage({ cpuPool: { ...payload, type: 'start', generation } }); }
            catch (error) { clearTimeout(timer); waiting = null; reject(error); }
          });
        } });
    },
  };
}
