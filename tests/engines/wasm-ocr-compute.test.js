import { beforeEach, afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WasmOcrCompute } from '../../src/engines/wasm-ocr-compute.js';
import { slicePlan, transposePlan } from '../../src/engines/index-shape.js';
import { NativeCompute, UNARY_OPERATIONS } from '../../src/engines/native-compute.js';

let engine;
beforeEach(async () => { engine = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm')); });
afterEach(async () => { await engine?.dispose(); });
const upload = (data, shape) => engine.upload(Float32Array.from(data), shape);
const near = (actual, expected, tolerance = 2e-5) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i] - expected[i]), `element ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance);
};

it('broadcasts, replays changed feeds and keeps intermediates inside a reused arena', async () => {
  const input = upload([1, 2, 3, 4, 5, 6], [2, 3]), row = upload([2, 3, 4], [3]);
  const batch = engine.batch({ capture: true });
  const sum = batch.binary('Add', input, row), squared = batch.binary('Pow', sum, upload([2], []));
  batch.recycle(sum);
  const result = batch.unary('Relu', squared);
  batch.recycle(squared); batch.submit();
  near(await engine.read(result), [9, 25, 49, 36, 64, 100]);
  expect(batch.reuseCount).toBe(1);
  const highWater = engine.memory.buffer.byteLength, buffers = engine.buffers.size;
  engine.write(input, Float32Array.of(-1, -2, -3, -4, -5, -6)); batch.replay();
  near(await engine.read(result), [1, 1, 1, 4, 4, 4]);
  expect(engine.memory.buffer.byteLength).toBe(highWater); expect(engine.buffers.size).toBe(buffers);
  await engine.releaseMany([...engine.tensors], batch.scratchBuffers());
  expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); expect(engine.cursor).toBe(engine.base);
});

it('preserves view ownership and exact integer copies through transpose and negative slices', async () => {
  const input = engine.uploadInt32(Int32Array.of(16777217, -3, 8, 4, 9, 2), [2, 3]);
  const batch = engine.batch(), view = batch.view(input, [3, 2]);
  const transposed = batch.index(view, transposePlan(view.shape));
  const reversed = batch.index(transposed, slicePlan(transposed.shape, [2], [-4], [1], [-1]));
  batch.submit();
  expect([...await engine.read(reversed)]).toEqual([9, 8, 16777217, 2, 4, -3]);
  await engine.release(input); expect(engine.buffers.size).toBe(3);
  await engine.releaseMany([...batch.outputs], batch.scratchBuffers()); expect(engine.buffers.size).toBe(0);
});

it('performs broadcast batch matrix multiplication', async () => {
  const batch = engine.batch();
  const result = batch.matmul(upload([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2]), upload([1, 0, 0, 2], [2, 2]));
  batch.submit(); near(await engine.read(result), [1, 4, 3, 8, 5, 12, 7, 16]);
});

it('preserves scalar activation semantics at SIMD boundaries, signed zero, subnormal ranges and nonfinite values', async () => {
  const reference = await NativeCompute.create(readFileSync('public/native/engine.wasm'));
  const data = Float32Array.of(-Infinity, -100, -6, -2, -1, -0, 0, .2, .9, 1, 6, 80, 100, Infinity, NaN, 2.3, 9.9);
  const input = upload(data, [data.length]), batch = engine.batch(), outputs = [];
  for (const operation of Object.keys(UNARY_OPERATIONS)) outputs.push([operation, batch.unary(operation, input)]);
  batch.submit();
  for (const [operation, tensor] of outputs) {
    const actual = await engine.read(tensor), expected = reference.unary(operation, data);
    for (let i = 0; i < data.length; i++) {
      if (Number.isNaN(expected[i])) expect(Number.isNaN(actual[i])).toBe(true);
      else if (!Number.isFinite(expected[i]) || expected[i] === 0) expect(Object.is(actual[i], expected[i]), `${operation} ${i}`).toBe(true);
      else expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(Math.abs(expected[i]) * 2e-6 + 1e-7);
    }
  }
});

it.each(['int8', 'uint8', 'bool'])('retains exact one-byte %s storage through copy, view, index, gather and concat', async type => {
  const values = type === 'int8' ? Int8Array.of(-128, -3, 0, 7, 127, -1)
    : type === 'bool' ? Uint8Array.of(1, 0, 0, 1, 0, 1) : Uint8Array.of(0, 3, 128, 255, 7, 129);
  const input = engine.upload(values, [2, 3], type), batch = engine.batch({ capture: true });
  expect(input.elementBytes).toBe(1);
  const copy = batch.copy(input), transposed = batch.index(copy, transposePlan([2, 3]));
  const gathered = batch.gather(transposed, [2, 0], [2], 0), joined = batch.concat([gathered, gathered], 1);
  batch.submit();
  expect([...await engine.read(joined)]).toEqual([values[2], values[5], values[2], values[5], values[0], values[3], values[0], values[3]]);
  engine.write(input, values.slice().reverse()); batch.replay();
  expect([...await engine.read(copy)]).toEqual([...values].reverse());
  expect(() => batch.binary('Add', input, input)).toThrow();
  await engine.releaseMany([...engine.tensors], batch.scratchBuffers()); expect(engine.buffers.size).toBe(0);
});

it('validates boolean bytes and constructs derived compute classes in the same arena', async () => {
  class DerivedCompute extends WasmOcrCompute {}
  const derived = await DerivedCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  try { expect(derived).toBeInstanceOf(DerivedCompute); }
  finally { await derived.dispose(); }
  expect(() => engine.upload(Uint8Array.of(2), [1], 'bool')).toThrow();
  expect(() => engine.uploadBytes(Uint8Array.of(2), [1], 'bool')).toThrow();
  expect(() => engine.tensor([1], null, null, 'float64')).toThrow();
});

function convolutionReference(data, shape, weights, weightShape, options = {}) {
  const [n, channels, h, w] = shape, [oc, inputs, kh, kw] = weightShape;
  const { group = 1, strides = [1, 1], dilations = [1, 1], pads = [0, 0, 0, 0] } = options;
  const oh = Math.floor((h + pads[0] + pads[2] - dilations[0] * (kh - 1) - 1) / strides[0]) + 1;
  const ow = Math.floor((w + pads[1] + pads[3] - dilations[1] * (kw - 1) - 1) / strides[1]) + 1;
  const out = [];
  for (let b = 0; b < n; b++) for (let c = 0; c < oc; c++) for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let sum = 0;
    for (let ci = 0; ci < inputs; ci++) for (let ky = 0; ky < kh; ky++) for (let kx = 0; kx < kw; kx++) {
      const sy = y * strides[0] + ky * dilations[0] - pads[0], sx = x * strides[1] + kx * dilations[1] - pads[1];
      if (sy >= 0 && sy < h && sx >= 0 && sx < w) sum += data[((b * channels + Math.floor(c / (oc / group)) * inputs + ci) * h + sy) * w + sx]
        * weights[((c * inputs + ci) * kh + ky) * kw + kx];
    }
    out.push(sum);
  }
  return out;
}

it.each([
  { shape: [1, 2, 5, 9], weights: [3, 2, 3, 2], options: { pads: [1, 1, 1, 0] } },
  { shape: [2, 4, 7, 12], weights: [4, 2, 2, 3], options: { group: 2, strides: [2, 2], dilations: [2, 1], pads: [1, 2, 0, 1] } },
  { shape: [1, 3, 4, 11], weights: [3, 1, 3, 3], options: { group: 3, pads: [1, 1, 1, 1] } },
  { shape: [2, 4, 3, 11], weights: [6, 2, 1, 1], options: { group: 2 } },
])('matches scalar convolution with groups, dilation, padding and SIMD tails: %j', async ({ shape, weights: weightShape, options }) => {
  const data = Float32Array.from({ length: shape.reduce((a, b) => a * b) }, (_, i) => ((i * 13) % 23 - 11) / 8);
  const weights = Float32Array.from({ length: weightShape.reduce((a, b) => a * b) }, (_, i) => ((i * 7) % 11 - 5) / 8);
  const batch = engine.batch(), result = batch.convolution(upload(data, shape), upload(weights, weightShape), null, options);
  batch.submit(); near(await engine.read(result), convolutionReference(data, shape, weights, weightShape, options));
});

it.each([[false, false], [true, false], [false, true], [true, true]])(
  'preserves pointwise groups, batches and row/column tails with bias=%s and relu=%s', async (hasBias, relu) => {
    const shape = [2, 6, 1, 17], weightShape = [10, 3, 1, 1];
    const data = Float32Array.from({ length: 204 }, (_, i) => ((i * 13) % 23 - 11) / 8);
    const weights = Float32Array.from({ length: 30 }, (_, i) => ((i * 7) % 11 - 5) / 8);
    const bias = Float32Array.from({ length: 10 }, (_, i) => (i - 5) / 8);
    const batch = engine.batch();
    const output = batch.convolution(upload(data, shape), upload(weights, weightShape), hasBias ? upload(bias, [10]) : null,
      { group: 2, relu });
    batch.submit();
    const expected = convolutionReference(data, shape, weights, weightShape, { group: 2 }).map((value, i) => {
      const sum = value + (hasBias ? bias[Math.floor(i / 17) % 10] : 0);
      return relu && sum < 0 ? 0 : sum;
    });
    expect([...await engine.read(output)]).toEqual(expected);
  },
);

it('keeps ascending reduction order across blocked matrix rows and tails', async () => {
  const batch = engine.batch();
  const input = upload(Float32Array.from({ length: 15 }, () => 1), [5, 3]);
  const weights = upload(Float32Array.from({ length: 51 }, (_, i) => [2 ** 24, 1, -(2 ** 24)][Math.floor(i / 17)]), [3, 17]);
  const output = batch.matmul(input, weights);
  batch.submit();
  expect([...await engine.read(output)]).toEqual(Array(85).fill(0));
});

it('handles transposed convolution, bias and output padding', async () => {
  const batch = engine.batch(), input = upload([1, 2, 3, 4], [1, 1, 2, 2]);
  const output = batch.convolution(input, upload([1, 2, 3, 4], [1, 1, 2, 2]), upload([0.5], [1]),
    { transpose: true, strides: [2, 2], outputPadding: [1, 0] });
  batch.submit(); near(await engine.read(output), [1.5, 2.5, 2.5, 4.5, 3.5, 4.5, 6.5, 8.5, 3.5, 6.5, 4.5, 8.5, 9.5, 12.5, 12.5, 16.5, 0.5, 0.5, 0.5, 0.5]);
});

it('reduces arbitrary axes and computes padded max/average pooling', async () => {
  const input = upload([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2]), batch = engine.batch();
  const mean = batch.reduce(input, [0, 2], false), max = batch.reduce(input, [-1], true, 'max');
  const image = batch.view(input, [1, 2, 2, 2]);
  const pooled = batch.pool(image, { kernel: [2, 2], strides: [1, 1], pads: [1, 1, 0, 0], average: true, countIncludePad: true });
  const maxPool = batch.pool(image, { kernel: [2, 2] });
  batch.submit(); near(await engine.read(mean), [3.5, 5.5]); near(await engine.read(max), [2, 4, 6, 8]);
  near(await engine.read(pooled), [0.25, 0.75, 1, 2.5, 1.25, 2.75, 3, 6.5]); near(await engine.read(maxPool), [4, 8]);
});

it('resizes with original coordinate semantics and joins/gathers tensor data', async () => {
  const input = upload([1, 2, 3, 4], [1, 1, 2, 2]), batch = engine.batch();
  const resized = batch.resize(input, { sizes: [1, 1, 3, 3], mode: 'linear', coordinateMode: 'align_corners' });
  const first = batch.gather(input, [0], [], 2), last = batch.gather(input, [-1], [], 2), joined = batch.concat([first, last], -1);
  batch.submit(); near(await engine.read(resized), [1, 1.5, 2, 2, 2.5, 3, 3, 3.5, 4]); near(await engine.read(joined), [1, 2, 3, 4]);
});

it('preserves clamped linear-resize endpoints exactly before phase accumulation', async () => {
  const first = Math.fround(0.062292364), last = Math.fround(0.1), batch = engine.batch();
  const resized = batch.resize(upload([first, last], [1, 1, 1, 2]),
    { sizes: [1, 1, 1, 600], mode: 'linear', coordinateMode: 'half_pixel' });
  batch.submit();
  const values = await engine.read(resized);
  expect(values[0]).toBe(first);
  expect(values.at(-1)).toBe(last);
});

it('normalizes channels, preserves softmax stability and selects first/last ties', async () => {
  const input = upload([1, 2, 3, 4], [1, 2, 2]), batch = engine.batch();
  const normalized = batch.batchNorm(input, upload([2, 3], [2]), upload([1, -1], [2]), upload([1, 2], [2]), upload([4, 9], [2]), 0);
  const probabilities = batch.softmax(upload([1000, 1000, 999, -1000, -1000, -1000], [2, 3]));
  const first = batch.argmax(probabilities, 1, false), last = batch.argmax(probabilities, 1, false, true);
  batch.submit(); near(await engine.read(normalized), [1, 2, 0, 1]);
  const a = 1 / (2 + Math.exp(-1)); near(await engine.read(probabilities), [a, a, a * Math.exp(-1), 1 / 3, 1 / 3, 1 / 3]);
  expect([...await engine.read(first)]).toEqual([0, 0]); expect([...await engine.read(last)]).toEqual([1, 2]);
});

it('bounds memory, refuses foreign/released tensors and fails unsupported square variants', async () => {
  const small = await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'), { maxBytes: 131072 });
  try {
    expect(() => small.tensor([100000])).toThrow(/memory limit|arena limit/);
    const own = upload([1], [1]); expect(() => small.checkTensor(own)).toThrow(/another/);
    const batch = engine.batch(), result = batch.binary('Pow', own, upload([3], []));
    expect(() => batch.submit()).toThrow(/square/);
    await engine.release(result); await engine.release(own);
    expect(() => engine.write(own, Float32Array.of(2))).toThrow(/released/);
  } finally { await small.dispose(); }
  await engine.dispose(); await engine.dispose(); expect(engine.buffers.size).toBe(0);
  expect(() => engine.batch()).toThrow(/disposed/);
});
