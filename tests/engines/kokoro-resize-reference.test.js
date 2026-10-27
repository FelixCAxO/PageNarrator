import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

const cases = [[1, 1, 2], [2, 3, 4]].flatMap(shape => [
  { shape, scale: 300, coordinateMode: 'half_pixel' },
  { shape, scale: 2, coordinateMode: 'align_corners' },
  { shape, scale: .5, coordinateMode: 'asymmetric' },
  { shape, scale: .5, coordinateMode: 'pytorch_half_pixel' },
]);

it.each(cases)('retains float32 rank-three interpolation arithmetic for $shape / $coordinateMode / $scale', async ({ shape, scale, coordinateMode }) => {
  const outputShape = [shape[0], shape[1], shape[2] * scale];
  const data = Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, i) => Math.sin(i + .17) * 35000);
  const model = kokoroOperatorFixture('Resize', [{ name: 'x', type: 1, shape }, null,
    { name: 'scales', type: 1, shape: [3] }], [{ name: 'y', type: 1, shape: outputShape }],
  { mode: 'linear', coordinate_transformation_mode: coordinateMode });
  const reference = await oracle.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  try {
    const expected = (await reference.run({ x: new oracle.Tensor('float32', data, shape),
      scales: new oracle.Tensor('float32', Float32Array.of(1, 1, scale), [3]) })).y;
    const batch = engine.batch(), output = batch.resize(engine.upload(data, shape),
      { scales: [1, 1, scale], mode: 'linear', coordinateMode });
    batch.submit();
    const actual = await engine.read(output);
    expect(actual.length).toBe(expected.data.length);
    const mismatches = [];
    for (let i = 0; i < actual.length; i++) if (!Object.is(actual[i], expected.data[i]) && mismatches.length < 10) {
      mismatches.push({ index: i, actual: actual[i], expected: expected.data[i] });
    }
    expect(mismatches).toEqual([]);
  } finally {
    await reference.release();
    await engine.dispose();
  }
});
