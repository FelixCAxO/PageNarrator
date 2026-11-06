import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

describe.each(['serial', 'shared'])('%s integer convolution', mode => {
  async function createEngine() {
    if (mode === 'serial') return WasmKokoroCompute.create(readFileSync('extension/public/native/kokoro-engine.wasm'));
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
    const { instance } = await WebAssembly.instantiate(readFileSync('extension/public/native/kokoro-parallel.wasm'), { env: { memory } });
    return new WasmKokoroCompute(instance.exports, 536870912);
  }

  it.each([false, true].flatMap(x => [false, true].flatMap(w => ['none', 'scalar', 'channel'].flatMap(z => [35, 41].map(length => [x, w, z, length])))))
  ('matches independent grouped/batched integer sums across tile, output and product tails (%s/%s/%s/%i)', async (xSigned, wSigned, zeroMode, length) => {
    const engine = await createEngine();
    try {
      const X = xSigned ? Int8Array : Uint8Array, W = wSigned ? Int8Array : Uint8Array;
      const batches = 2, channels = 6, groups = 2, filters = 10, kernel = 3, width = length;
      const x = X.from({ length: batches * channels * length }, (_, i) => i * 53 % 256 - (xSigned ? 128 : 0));
      const w = W.from({ length: filters * 3 * kernel }, (_, i) => i * 29 % 256 - (wSigned ? 128 : 0));
      const xz = X.of(xSigned ? 127 : 253), wz = W.from({ length: zeroMode === 'channel' ? filters : 1 }, (_, i) => wSigned ? -128 + i : 255 - i);
      const expected = new Int32Array(batches * filters * width);
      for (let b = 0; b < batches; b++) for (let c = 0; c < filters; c++) for (let j = 0; j < width; j++) {
        let sum = 0;
        for (let ci = 0; ci < 3; ci++) for (let k = 0; k < kernel; k++) {
          const from = j + 2 * k - 2;
          if (from >= 0 && from < length) sum += (x[(b * channels + Math.floor(c / 5) * 3 + ci) * length + from] - (zeroMode === 'none' ? 0 : xz[0]))
            * (w[(c * 3 + ci) * kernel + k] - (zeroMode === 'none' ? 0 : wz[wz.length === 1 ? 0 : c]));
        }
        expected[(b * filters + c) * width + j] = sum;
      }
      const batch = engine.batch({ capture: true });
      const out = engine.kokoro.convInteger(batch, engine.upload(x, [batches, channels, length], xSigned ? 'int8' : 'uint8'),
        engine.upload(w, [filters, 3, kernel], wSigned ? 'int8' : 'uint8'),
        zeroMode === 'none' ? null : engine.upload(xz, [], xSigned ? 'int8' : 'uint8'),
        zeroMode === 'none' ? null : engine.upload(wz, wz.length === 1 ? [] : [filters], wSigned ? 'int8' : 'uint8'),
        { group: groups, dilations: [2], pads: [2, 2] });
      batch.submit(); expect(await engine.read(out)).toEqual(expected);
      batch.replay(); expect(await engine.read(out)).toEqual(expected);
    } finally { await engine.dispose(); expect(engine.buffers.size).toBe(0); }
  });

  it.each([false, true])('cancels extreme weight zero points at the int32 product bound (signed=%s)', async signed => {
    const engine = await createEngine();
    try {
      const channels = 33025, W = signed ? Int8Array : Uint8Array, v = signed ? -128 : 255;
      const x = engine.upload(new Uint8Array(channels).fill(255), [1, channels, 1], 'uint8');
      const w = engine.upload(new W(3 * channels).fill(v), [3, channels, 1], signed ? 'int8' : 'uint8');
      const zero = engine.upload(W.of(v), [], signed ? 'int8' : 'uint8');
      const batch = engine.batch(), out = engine.kokoro.convInteger(batch, x, w, null, zero);
      batch.submit(); expect(await engine.read(out)).toEqual(Int32Array.of(0, 0, 0));
    } finally { await engine.dispose(); }
  });
});
