import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { phaseCorrectionFixture, debugKokoroPhaseCorrection, matmulFixture } from '../../scripts/lib/onnx-debug-outputs.mjs';
import { decodeOnnxModel } from '../../src/engines/onnx-model.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

const exportedPhase = (real, imag) => Math.fround(real < 0 ? Math.atan(imag / real) + (imag > 0 ? Math.PI : -Math.PI) : Math.atan(imag / real));
const canonicalPhase = (real, imag) => real === 0 && imag === 0 ? 0 : Math.fround(imag === 0 && real < 0 ? Math.PI : Math.atan2(imag, real));

it('keeps the correction explicit, bounded and restricted to immutable actual model bytes', async () => {
  await expect(debugKokoroPhaseCorrection(matmulFixture(1, [1, 1], [1, 1]))).rejects.toThrow(/exact pinned/);
  expect(() => phaseCorrectionFixture(0)).toThrow(); expect(() => phaseCorrectionFixture(4097)).toThrow();
  const graph = decodeOnnxModel(phaseCorrectionFixture(12)).graph;
  expect(graph.nodes.map(node => node.opType)).toEqual(['Less', 'Equal', 'And', 'Where', 'Equal', 'And', 'Where']);
  expect(new Set(graph.nodes.map(node => node.name)).size).toBe(graph.nodes.length);
  expect(graph.inputs.map(value => value.name)).toEqual(['real', 'imaginary', 'raw']);
  expect(graph.outputs).toEqual([{ name: 'corrected', dataType: 1, dims: [12] }]);
});

it('runs exact-zero phase correction in the real C++ session without epsilon or reference intermediates', async () => {
  const real = Float32Array.of(-1, -1, 1, 1, -1, -1, -1, -1, 1, 1, 0, 0, 0, 0, -0, -0);
  const imaginary = Float32Array.of(0, -0, 0, -0, 1e-7, -1e-7, 1, -1, 1, -1, 1, -1, 0, -0, 0, -0);
  const raw = Float32Array.from(real, (x, i) => exportedPhase(x, imaginary[i]));
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const session = await WebGpuOnnxSession.create(phaseCorrectionFixture(real.length), { engine });
  try {
    const feeds = { real: { shape: [real.length], data: real }, imaginary: { shape: [imaginary.length], data: imaginary }, raw: { shape: [raw.length], data: raw } };
    for (let run = 0; run < 2; run++) {
      const output = (await session.run(feeds)).corrected.data;
      for (let i = 0; i < real.length; i++) expect(output[i]).toBe(canonicalPhase(real[i], imaginary[i]));
      expect(Object.is(output[3], -0)).toBe(true);
      expect(output[0]).toBe(Math.fround(Math.PI)); expect(output[1]).toBe(Math.fround(Math.PI));
      // PageNarrator defines +0 at the origin for all zero signs; this is not full IEEE atan2 parity.
      expect(Array.from(real.subarray(12), (x, i) => Math.atan2(imaginary[12 + i], x))).toEqual([0, -0, Math.PI, -Math.PI]);
      for (let i = 12; i < real.length; i++) { expect(Number.isNaN(raw[i])).toBe(true); expect(Object.is(output[i], 0)).toBe(true); }
      // Nonzero quadrants are byte-identical to the unmodified exported phase.
      for (let i = 4; i < real.length; i++) if (imaginary[i] !== 0) expect(output[i]).toBe(raw[i]);
      if (!run) { imaginary[4] = 0; raw[4] = exportedPhase(real[4], 0); }
    }
  } finally { await session.dispose(); expect(engine.tensors.size).toBe(0); expect(engine.buffers.size).toBe(0); await engine.dispose(); }
});

it('uses canonical positive-zero DC from a real negative signal, with independent analytic STFT phase', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  try {
    const batch = engine.batch(), input = engine.upload(new Float32Array(40).fill(-1), [1, 40]);
    const window = engine.upload(Float32Array.from({ length: 20 }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / 20)), [20]);
    const output = engine.kokoro.stft(batch, input, window, { frameLength: 20, frameStep: 5 }); batch.submit();
    const data = await engine.read(output);
    for (let frame = 0; frame < 5; frame++) {
      const real = data[frame * 22], imaginary = data[frame * 22 + 1];
      expect(real).toBeCloseTo(-10, 6); expect(Object.is(imaginary, 0)).toBe(true);
      expect(exportedPhase(real, imaginary)).toBe(Math.fround(-Math.PI));
      expect(canonicalPhase(real, imaginary)).toBe(Math.fround(Math.PI));
    }
    await engine.releaseMany([...engine.tensors], batch.scratchBuffers()); expect(engine.buffers.size).toBe(0);
  } finally { await engine.dispose(); }
});
