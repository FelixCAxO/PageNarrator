import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

const options = { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' };

it('preserves the distinct quantization results on either side of the captured attention rounding boundary', async () => {
  const scale = 0.028707697987556458;
  const input = Float32Array.of(-92 * scale, 163 * scale, 0.818169116973877, 0.818170964717865);
  const model = kokoroOperatorFixture('DynamicQuantizeLinear', [{ name: 'x', type: 1, shape: [4] }],
    [{ name: 'q', type: 2, shape: [4] }, { name: 'scale', type: 1, shape: [] }, { name: 'zero', type: 2, shape: [] }]);
  const reference = await oracle.InferenceSession.create(model, options);
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  try {
    const expected = await reference.run({ x: new oracle.Tensor('float32', input, [4]) });
    const batch = engine.batch(), result = engine.kokoro.dynamicQuantizeLinear(batch, engine.upload(input, [4]));
    batch.submit();
    expect(Array.from(expected.q.data)).toEqual([0, 255, 120, 121]);
    expect(expected.scale.data[0]).toBe(scale);
    expect(expected.zero.data[0]).toBe(92);
    for (const [index, key] of ['q', 'scale', 'zero'].entries()) expect(await engine.read(result[index])).toEqual(expected[key].data);
  } finally { await reference.release(); await engine.dispose(); }
});

it.each([112, 1024])('matches the independent float32 harmonic phase sum for %i frames', async frames => {
  const shape = [1, frames, 9];
  const input = Float32Array.from({ length: frames * 9 }, (_, i) => Math.sin(i * .17) * .003 + (i % 9 + 1) * .007);
  const model = kokoroOperatorFixture('CumSum', [{ name: 'x', type: 1, shape }, { name: 'axis', type: 7, shape: [] }],
    [{ name: 'sum', type: 1, shape }]);
  const reference = await oracle.InferenceSession.create(model, options);
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  try {
    const expected = (await reference.run({ x: new oracle.Tensor('float32', input, shape),
      axis: new oracle.Tensor('int64', BigInt64Array.of(1n), []) })).sum.data;
    const batch = engine.batch(), result = engine.kokoro.cumsum(batch, engine.upload(input, shape), 1, {});
    batch.submit();
    expect(await engine.read(result)).toEqual(expected);
  } finally { await reference.release(); await engine.dispose(); }
});
