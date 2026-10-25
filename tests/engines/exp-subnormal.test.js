import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { NativeCompute } from '../../src/engines/native-compute.js';
import { WasmOcrCompute } from '../../src/engines/wasm-ocr-compute.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { WasmTesseractCompute } from '../../src/engines/tesseract-line-compute.js';

it.each([
  ['engine', NativeCompute], ['ocr-engine', WasmOcrCompute],
  ['kokoro-engine', WasmKokoroCompute], ['ocr-lstm-engine', WasmTesseractCompute],
])('%s preserves minimum float32 Exp values, including scalar tails', async (name, Compute) => {
  const engine = await Compute.create(readFileSync(`public/native/${name}.wasm`));
  try {
    // Cover both sides of the half-minimum threshold and every SIMD position.
    const input = Float32Array.of(-104, -103.9, -103.7, -103.5,
      -103.97209, -103.97208, -103.97207, -100,
      -103.9, -104, -103.7, -103.5, -103.7, -103.9, -103.97209, -103.97207, -103.7);
    let actual;
    if (name === 'engine') actual = engine.unary('Exp', input);
    else {
      const batch = engine.batch(), output = batch.unary('Exp', engine.upload(input, [input.length]));
      batch.submit(); actual = await engine.read(output);
    }
    const expected = Float32Array.from(input, Math.exp);
    // An absolute tolerance would hide the loss of the smallest subnormal.
    expect(new Uint32Array(actual.buffer, actual.byteOffset, actual.length))
      .toEqual(new Uint32Array(expected.buffer));
  } finally { await engine.dispose?.(); }
});
