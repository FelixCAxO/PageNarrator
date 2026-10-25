// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmKokoroCompute } from '../../engines/kokoro-cpu-compute.js';

/** Packaged first-party executable; retained model hosts only supply data.
 * @param {any} [options] */
export async function createPackagedKokoroCpuEngine({ runtime = globalThis.chrome?.runtime,
  fetcher = globalThis.fetch?.bind(globalThis), wasmBinary = null } = {}) {
  if (!wasmBinary) {
    if (!runtime?.getURL || !fetcher) throw new Error('Kokoro CPU inference needs its packaged local engine.');
    const response = await fetcher(runtime.getURL('native/kokoro-engine.wasm'));
    if (!response.ok) throw new Error(`Could not load Kokoro CPU engine (${response.status}).`);
    wasmBinary = new Uint8Array(await response.arrayBuffer());
  }
  return WasmKokoroCompute.create(wasmBinary);
}
