import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

describe.each(['serial', 'shared'])('%s Snake engine', mode => {
  it.each([1, 3, 4, 5, 7, 8, 16, 17, 129])('retains unfused float32 bits across packet/tail boundaries at width %i', async width => {
    let engine;
    if (mode === 'serial') engine = await WasmKokoroCompute.create(readFileSync('extension/public/native/kokoro-engine.wasm'));
    else {
      const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
      const { instance } = await WebAssembly.instantiate(readFileSync('extension/public/native/kokoro-parallel.wasm'), { env: { memory } });
      engine = new WasmKokoroCompute(instance.exports, 536870912);
    }
    try {
      const edges = [0, -0, 1e-40, -1e-40, 25965.998046875, 25966, -25966, 1e6, -1e6, .125, -2.25];
      const x = Float32Array.from({ length: 2 * width }, (_, i) => i < edges.length ? edges[i] : (i % 2 ? -1 : 1) * ((i * 997) % 25966 + .125));
      const input = engine.upload(x, [2, width]);
      const alpha = engine.upload(Float32Array.of(1, 1.7), [2, 1]);
      const scale = engine.upload(Float32Array.of(.25, 2.5), [2, 1]);
      const batch = engine.batch({ capture: true }), fused = batch.snake(input, alpha, scale);
      // Unary Sin retains the original scalar range reduction and packet/tail policy.
      const wave = batch.unary('Sin', batch.binary('Mul', input, alpha));
      const unfused = batch.binary('Add', input, batch.binary('Mul', batch.binary('Mul', wave, wave), scale));
      batch.submit();
      for (let repeat = 0; repeat < 2; repeat++) {
        if (repeat) batch.replay();
        const actual = await engine.read(fused), expected = await engine.read(unfused);
        expect(new Uint32Array(actual.buffer, actual.byteOffset, actual.length))
          .toEqual(new Uint32Array(expected.buffer, expected.byteOffset, expected.length));
      }
    } finally {
      await engine.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0);
    }
  });
});
