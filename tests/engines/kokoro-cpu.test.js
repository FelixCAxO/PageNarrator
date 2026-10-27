import { beforeEach, afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { referenceLayerNormalization, referenceLstm, referenceStft } from '../../src/engines/kokoro-kernels-shape.js';
import { referenceCumulativeSum, referenceKokoroUnary, referenceScatterNd } from '../../src/engines/kokoro-kernels-duration.js';

let engine;
const engineBinary = () => readFileSync(process.env.PN_KOKORO_TEST_WASM || 'public/native/kokoro-engine.wasm');
beforeEach(async () => { engine = await WasmKokoroCompute.create(engineBinary()); });
afterEach(async () => { await engine?.dispose(); });
const size = shape => shape.reduce((a, b) => a * b, 1);
const values = (shape, seed = 1, magnitude = .2) => Float32Array.from({ length: size(shape) }, (_, i) => Math.sin(i * .71 + seed) * magnitude);
const upload = (data, shape) => engine.upload(Float32Array.from(data), shape);
const near = (actual, expected, tolerance = 2e-5) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i] - expected[i]), `element ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance);
};

it.each([3, 65, 128, 512])('matches independent centered layer normalization at width %i', async width => {
  const shape = [2, width], input = values(shape), scale = values([width], 3, 2), bias = values([width], 7);
  const batch = engine.batch(), output = engine.kokoro.layerNormalization(batch, upload(input, shape), upload(scale, [width]), upload(bias, [width]), { epsilon: 1e-12 });
  batch.submit(); near(await engine.read(output), referenceLayerNormalization(input, shape, scale, bias, { epsilon: 1e-12 }), 4e-6);
});

it.each([
  { steps: 3, batchSize: 2, features: 4, hiddenSize: 2, direction: 'bidirectional' },
  { steps: 7, batchSize: 1, features: 5, hiddenSize: 3, direction: 'forward' },
  { steps: 4, batchSize: 2, features: 3, hiddenSize: 4, direction: 'reverse' },
  { steps: 2, batchSize: 1, features: 640, hiddenSize: 256, direction: 'bidirectional' },
  { steps: 0, batchSize: 1, features: 4, hiddenSize: 2, direction: 'bidirectional' },
])('matches all three independent recurrent outputs: %j', async spec => {
  const { steps, batchSize, features, hiddenSize: h, direction } = spec, d = direction === 'bidirectional' ? 2 : 1;
  const shapes = [[steps, batchSize, features], [d, 4 * h, features], [d, 4 * h, h], [d, 8 * h], [d, batchSize, h], [d, batchSize, h]];
  const data = shapes.map((shape, i) => values(shape, i + 1)), batch = engine.batch();
  const result = engine.kokoro.lstm(batch, ...data.map((item, i) => upload(item, shapes[i])), { hiddenSize: h, direction });
  batch.submit(); const expected = referenceLstm(...data, shapes[0], { hiddenSize: h, direction });
  for (let i = 0; i < 3; i++) near(await engine.read(result[i]), expected[i], 2e-5);
});

it('matches frozen authored ORT quantized LSTM outputs and resets bidirectional state on repeated calls', async () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/kokoro-dynamic-lstm-small.json', 'utf8'));
  const hash = data => createHash('sha256').update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
  const operands = Object.fromEntries(fixture.operands.map(operand => {
    const data = operand.type === 'int8' ? Int8Array.from(operand.values) : Float32Array.from(operand.values);
    expect(hash(data)).toBe(operand.sha256);
    return [operand.name, { data, tensor: engine.upload(data, operand.dims, operand.type) }];
  }));
  const expected = fixture.expected.map(output => {
    const data = Float32Array.from(output.values); expect(hash(data)).toBe(output.sha256); return data;
  });
  const names = ['X', 'W', 'R', 'B', 'initial_h', 'initial_c', 'W_scale', 'W_zero_point', 'R_scale', 'R_zero_point'];
  let first;
  for (let repetition = 0; repetition < 2; repetition++) {
    const batch = engine.batch(), result = engine.kokoro.dynamicQuantizeLstm(batch, ...names.map(name => operands[name].tensor), fixture.options);
    batch.submit(); const actual = await Promise.all(result.map(tensor => engine.read(tensor)));
    for (let i = 0; i < result.length; i++) {
      expect(result[i].shape).toEqual(fixture.expected[i].dims); near(actual[i], expected[i], 2e-5);
      if (first) expect(new Uint32Array(actual[i].buffer)).toEqual(new Uint32Array(first[i].buffer));
    }
    first = actual;
  }
  for (const name of ['initial_h', 'initial_c']) expect(await engine.read(operands[name].tensor)).toEqual(operands[name].data);
});

it('matches Hann-window STFT and all original CPU transcendental activations', async () => {
  const input = values([2, 39], 3, 2), window = Float32Array.from({ length: 20 }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / 20));
  const batch = engine.batch(), stft = engine.kokoro.stft(batch, upload(input, [2, 39]), upload(window, [20]), { frameLength: 20, frameStep: 5 });
  const x = Float32Array.of(-10000, -Math.PI, -2.5, -1.5, -.5, -0, 0, .5, 1.5, 2.5, Math.PI, 10000);
  const source = upload(x, [x.length]), outputs = new Map();
  for (const op of ['Sin', 'Cos', 'Round', 'Floor', 'Atan', 'LeakyRelu', 'Clip']) outputs.set(op, batch.unary(op, source, { min: -.75, max: 1.75 }));
  batch.submit(); near(await engine.read(stft), referenceStft(input, [2, 39], window, { frameLength: 20, frameStep: 5 }), 3e-6);
  const spectrum = await engine.read(stft);
  // These bins are mathematically real; rounding residue changes downstream atan2 quadrants.
  for (let frame = 0; frame < 8; frame++) for (const bin of [0, 10]) expect(spectrum[(frame * 11 + bin) * 2 + 1]).toBe(0);
  for (const [op, output] of outputs) {
    const expected = op === 'Sin' ? Float32Array.from(x, Math.sin) : op === 'Cos' ? Float32Array.from(x, Math.cos) : referenceKokoroUnary(x, op, { min: -.75, max: 1.75 });
    near(await engine.read(output), expected, 2e-6);
  }
  expect(Object.is((await engine.read(outputs.get('Round')))[4], -0)).toBe(true);
});

it('preserves an independent multiplicative snake scale rather than treating it as a divisor', async () => {
  const input = Float32Array.of(-2, -.3, 0, .7, 2, 3), alpha = Float32Array.of(.7, 1.3), scale = Float32Array.of(.25, 2.5);
  const batch = engine.batch(), output = batch.snake(upload(input, [2, 3]), upload(alpha, [2, 1]), upload(scale, [2, 1]));
  batch.submit();
  near(await engine.read(output), Float32Array.from(input, (x, i) => x + scale[Math.floor(i / 3)] * Math.sin(Math.fround(x * alpha[Math.floor(i / 3)])) ** 2), 1e-6);
});

it('preserves small tanh activations and signed zero without exponential cancellation', async () => {
  const values = Float32Array.from([-0, 0, -(2 ** -149), 2 ** -149, -1e-9, 1e-9, -1e-7, 1e-7,
    ...Array.from({ length: 257 }, (_, i) => (i - 128) / 1024)]);
  const batch = engine.batch(), output = batch.unary('Tanh', upload(values, [values.length]));
  batch.submit();
  const actual = await engine.read(output), expected = Float32Array.from(values, Math.tanh);
  expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
});

it.each([1e-9, 1e-7, 2 ** -146])('retains a small %g recurrent candidate through both tanh stages', async value => {
  const batch = engine.batch(), input = upload([1], [1, 1, 1]);
  const output = engine.kokoro.lstm(batch, input, upload([0, 0, 0, value], [1, 4, 1]), upload([0, 0, 0, 0], [1, 4, 1]),
    upload(new Float32Array(8), [1, 8]), upload([0], [1, 1, 1]), upload([0], [1, 1, 1]), { hiddenSize: 1, direction: 'forward' });
  batch.submit();
  const cell = Math.fround(.5 * Math.fround(Math.tanh(Math.fround(value)))), hidden = Math.fround(.5 * Math.fround(Math.tanh(cell)));
  expect(Array.from(await engine.read(output[0]))).toEqual([hidden]);
  expect(Array.from(await engine.read(output[1]))).toEqual([hidden]);
  expect(Array.from(await engine.read(output[2]))).toEqual([cell]);
});

it.each([
  [[2, 3, 5], [2, 1, 1], [1, 3, 1]], [[1, 3], [2, 1], []], [[2, 3], [], [3]], [[], [], []],
])('fuses Snake storage while preserving every unfused float32 stage and broadcast axis: %j', async (inputShape, alphaShape, scaleShape) => {
  const x = Float32Array.from({ length: size(inputShape) }, (_, i) => [0, -0, -2.25, .125, 2.7, -100][i % 6]);
  const a = values(alphaShape, 3, 1.7), s = values(scaleShape, 2, .375), batch = engine.batch();
  const inputs = [upload(x, inputShape), upload(a, alphaShape), upload(s, scaleShape)], fused = batch.snake(...inputs);
  const product = batch.binary('Mul', inputs[0], inputs[1]), wave = batch.unary('Sin', product), squared = batch.binary('Mul', wave, wave);
  const scaled = batch.binary('Mul', squared, inputs[2]), unfused = batch.binary('Add', inputs[0], scaled); batch.submit();
  const actual = await engine.read(fused), expected = await engine.read(unfused);
  expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
});

it('runs a large fused Snake under an arena budget that cannot hold the five temporary arrays', async () => {
  const small = await WasmKokoroCompute.create(engineBinary(), { maxBytes: 1024 * 1024 });
  try {
    const shape = [2, 3, 8192], data = values(shape), input = small.upload(data, shape), alpha = small.upload(Float32Array.of(.7, 1.3), [2, 1, 1]), scale = small.upload(Float32Array.of(.25, .5, 1.25), [1, 3, 1]);
    const batch = small.batch(), output = batch.snake(input, alpha, scale);
    expect(batch.allocationCount).toBe(1); expect(batch.scratchBuffers()).toHaveLength(0); batch.submit();
    const actual = await small.read(output);
    for (const i of [0, 8191, 8192, 24575, 49151]) {
      const product = Math.fround(data[i] * (i < 24576 ? .7 : 1.3)), sine = Math.fround(Math.sin(product));
      const expected = Math.fround(data[i] + Math.fround(Math.fround(sine * sine) * [.25, .5, 1.25][Math.floor(i / 8192) % 3]));
      expect(actual[i]).toBeCloseTo(expected, 6);
    }
    await small.releaseMany([...small.tensors], batch.scratchBuffers()); expect(small.buffers.size).toBe(0);
  } finally { await small.dispose(); }
});

it.each([
  { shape: [2, 4, 35], weightShape: [4, 3, 5], options: { group: 2, strides: [2], dilations: [2], pads: [3, 2], outputPadding: [1] } },
  { shape: [1, 8, 7], weightShape: [8, 3, 20], options: { strides: [5] } },
])('matches independent overlap-add transposed convolution through tile boundaries: %j', async ({ shape, weightShape, options }) => {
  const input = values(shape, 1), weights = values(weightShape, 3), group = options.group ?? 1;
  const [n, channels, length] = shape, [, ocg, kernel] = weightShape, oc = ocg * group, icg = channels / group;
  const stride = options.strides?.[0] ?? 1, dilation = options.dilations?.[0] ?? 1, left = options.pads?.[0] ?? 0, right = options.pads?.[1] ?? 0;
  const width = (length - 1) * stride - left - right + dilation * (kernel - 1) + 1 + (options.outputPadding?.[0] ?? 0), bias = values([oc], 7);
  const expected = Float64Array.from({ length: n * oc * width }, (_, i) => bias[Math.floor(i / width) % oc]);
  for (let b = 0; b < n; b++) for (let ci = 0; ci < channels; ci++) for (let x = 0; x < length; x++) for (let c = 0; c < ocg; c++) for (let k = 0; k < kernel; k++) {
    const position = x * stride + k * dilation - left;
    if (position >= 0 && position < width) expected[(b * oc + Math.floor(ci / icg) * ocg + c) * width + position] += input[(b * channels + ci) * length + x] * weights[(ci * ocg + c) * kernel + k];
  }
  const batch = engine.batch(), output = batch.convolution(upload(input, shape), upload(weights, weightShape), upload(bias, [oc]), { ...options, transpose: true });
  batch.submit(); expect(output.shape).toEqual([n, oc, width]); near(await engine.read(output), expected, 3e-6);
});

it('scans and scatters in the same captured arena, including changed feeds and disposal', async () => {
  const shape = [2, 1025, 3], data = values(shape), input = upload(data, shape), batch = engine.batch({ capture: true });
  const scan = engine.kokoro.cumsum(batch, input, 1), updates = upload([100, 200, 300, 400, 500, 600], [2, 3]);
  const indices = [0, 1, -1, -1], result = engine.kokoro.scatterNd(batch, scan, indices, [2, 2], updates);
  batch.recycle(scan); batch.submit();
  near(await engine.read(result), referenceScatterNd(referenceCumulativeSum(data, shape, 1), shape, indices, [2, 2], Float32Array.of(100, 200, 300, 400, 500, 600), [2, 3]), 2e-5);
  const highWater = engine.memory.buffer.byteLength, count = engine.buffers.size;
  engine.write(input, new Float32Array(data.length)); batch.replay();
  expect((await engine.read(result))[0]).toBe(0); expect(engine.buffers.size).toBe(count); expect(engine.memory.buffer.byteLength).toBe(highWater);
  await engine.releaseMany([...engine.tensors], batch.scratchBuffers()); expect(engine.buffers.size).toBe(0); expect(engine.cursor).toBe(engine.base);
});

it('quantizes to exact bytes, uses ties-to-even and returns scalar scale and zero point', async () => {
  const batch = engine.batch(), input = upload([0, 2, -3, -2.5, 1.34, .5], [2, 3]);
  const [q, scale, zero] = engine.kokoro.dynamicQuantizeLinear(batch, input), back = engine.kokoro.dequantizeLinear(batch, q, scale, zero);
  const allZero = engine.kokoro.dynamicQuantizeLinear(batch, upload([0, 0], [2]));
  const ties = engine.kokoro.dynamicQuantizeLinear(batch, upload([0, .5, 1.5, 2.5, 254.5, 255], [6]));
  batch.submit();
  expect([...await engine.read(q)]).toEqual([153, 255, 0, 26, 221, 179]);
  near(await engine.read(scale), [5 / 255], 1e-9); expect([...await engine.read(zero)]).toEqual([153]);
  near(await engine.read(back), [0, 2, -3, -127 * 5 / 255, 68 * 5 / 255, 26 * 5 / 255]);
  expect([...await engine.read(allZero[0])]).toEqual([0, 0]); expect([...await engine.read(allZero[1])]).toEqual([1]); expect([...await engine.read(allZero[2])]).toEqual([0]);
  expect([...await engine.read(ties[0])]).toEqual([0, 0, 2, 2, 254, 255]);
});

it('rounds half ties, neighboring floats, subnormals and large values with exact signed zeros', async () => {
  const input = Float32Array.from([...Array.from({ length: 2049 }, (_, i) => (i - 1024) * .5), -.50000006, -.49999997, .49999997, .50000006,
    -0, 0, -(2 ** -149), 2 ** -149, -16777216, 16777216, -3.4028234663852886e38, 3.4028234663852886e38, -Infinity, Infinity]);
  const expected = Float32Array.from(input, x => {
    if (!Number.isFinite(x) || Math.abs(x) >= 16777216) return x;
    const floor = Math.floor(x), fraction = x - floor, rounded = fraction < .5 ? floor : fraction > .5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
    return rounded === 0 && (x < 0 || Object.is(x, -0)) ? -0 : rounded;
  });
  const batch = engine.batch(), output = batch.unary('Round', upload(input, [input.length])); batch.submit(); const actual = await engine.read(output);
  expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
});

it.each(['int8', 'uint8'])('accumulates batched integer matmul exactly with per-column %s zero points and SIMD tails', async type => {
  const aShape = [2, 3, 7], bShape = [1, 7, 5], a = Uint8Array.from({ length: size(aShape) }, (_, i) => i * 13 % 256);
  const ArrayType = type === 'int8' ? Int8Array : Uint8Array, b = ArrayType.from({ length: size(bShape) }, (_, i) => i * 23 % 256 - (type === 'int8' ? 128 : 0));
  const bz = ArrayType.from([1, 2, 3, 4, 5]), batch = engine.batch();
  const result = engine.kokoro.matmulInteger(batch, engine.upload(a, aShape, 'uint8'), engine.upload(b, bShape, type), engine.upload(Uint8Array.of(113), [], 'uint8'), engine.upload(bz, [5], type));
  batch.submit(); const expected = [];
  for (let n = 0; n < 2; n++) for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    let sum = 0; for (let k = 0; k < 7; k++) sum += (a[(n * 3 + row) * 7 + k] - 113) * (b[k * 5 + col] - bz[col]); expected.push(sum);
  }
  expect([...await engine.read(result)]).toEqual(expected);
});

it.each(['int8', 'uint8'].flatMap(a => ['int8', 'uint8'].flatMap(b => ['none', 'scalar', 'columns'].map(zero => ({ a, b, zero })))))('preserves quantized matrix row/column tails, signedness and zero points: %j', async ({ a: aType, b: bType, zero }) => {
  const A = aType === 'int8' ? Int8Array : Uint8Array, B = bType === 'int8' ? Int8Array : Uint8Array;
  const a = A.from({ length: 2 * 7 * 9 }, (_, i) => i * 53 % 256 - (aType === 'int8' ? 128 : 0));
  const b = B.from({ length: 9 * 17 }, (_, i) => i * 29 % 256 - (bType === 'int8' ? 128 : 0));
  const az = zero === 'none' ? null : A.of(aType === 'int8' ? -127 : 253), bz = zero === 'none' ? null : B.from({ length: zero === 'columns' ? 17 : 1 }, (_, i) => i * 31 % 256 - (bType === 'int8' ? 128 : 0));
  const batch = engine.batch(), output = engine.kokoro.matmulInteger(batch, engine.upload(a, [2, 7, 9], aType), engine.upload(b, [1, 9, 17], bType), az && engine.upload(az, [], aType), bz && engine.upload(bz, bz.length === 1 ? [] : [17], bType));
  batch.submit(); const expected = [];
  for (let n = 0; n < 2; n++) for (let row = 0; row < 7; row++) for (let col = 0; col < 17; col++) {
    let sum = 0; for (let j = 0; j < 9; j++) sum += (a[(n * 7 + row) * 9 + j] - (az?.[0] ?? 0)) * (b[j * 17 + col] - (bz?.[zero === 'columns' ? col : 0] ?? 0)); expected.push(sum);
  }
  expect(output.shape).toEqual([2, 7, 17]); expect(await engine.read(output)).toEqual(Int32Array.from(expected));
});

it.each([{ kernel: 3, dilation: 2 }, { kernel: 5, dilation: 1 }, { kernel: 7, dilation: 1 }])('handles quantized grouped/dilated padded convolution, dot-product tails and channel zero points: %j', async ({ kernel, dilation }) => {
  const input = Uint8Array.from({ length: 2 * 4 * 9 }, (_, i) => i * 17 % 256), weights = Int8Array.from({ length: 6 * 2 * kernel }, (_, i) => i * 7 % 256 - 128), zero = Int8Array.of(-4, -3, -2, -1, 0, 1);
  const width = Math.floor((9 + 3 - dilation * (kernel - 1) - 1) / 2) + 1;
  const batch = engine.batch(), output = engine.kokoro.convInteger(batch, engine.upload(input, [2, 4, 9], 'uint8'), engine.upload(weights, [6, 2, kernel], 'int8'), engine.upload(Uint8Array.of(107), [], 'uint8'), engine.upload(zero, [6], 'int8'), { group: 2, strides: [2], dilations: [dilation], pads: [2, 1] });
  batch.submit(); const expected = [];
  for (let n = 0; n < 2; n++) for (let c = 0; c < 6; c++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let ci = 0; ci < 2; ci++) for (let k = 0; k < kernel; k++) {
      const from = x * 2 + k * dilation - 2;
      if (from >= 0 && from < 9) sum += (input[(n * 4 + Math.floor(c / 3) * 2 + ci) * 9 + from] - 107) * (weights[(c * 2 + ci) * kernel + k] - zero[c]);
    }
    expected.push(sum);
  }
  expect(output.shape).toEqual([2, 6, width]); expect([...await engine.read(output)]).toEqual(expected);
});

it.each([['uint8', 'uint8'], ['uint8', 'int8'], ['int8', 'uint8'], ['int8', 'int8']])('shares convolution weights across spatial SIMD lanes without changing %s/%s arithmetic', async (inputType, weightType) => {
  const ArrayX = inputType === 'int8' ? Int8Array : Uint8Array, ArrayW = weightType === 'int8' ? Int8Array : Uint8Array;
  const input = ArrayX.from({ length: 2 * 6 * 37 }, (_, i) => i * 53 % 256 - (inputType === 'int8' ? 128 : 0));
  const weight = ArrayW.from({ length: 10 * 3 * 3 }, (_, i) => i * 29 % 256 - (weightType === 'int8' ? 128 : 0));
  const xz = ArrayX.of(inputType === 'int8' ? -107 : 107), wz = ArrayW.from({ length: 10 }, (_, i) => weightType === 'int8' ? -127 + i : 253 - i);
  const batch = engine.batch(), output = engine.kokoro.convInteger(batch, engine.upload(input, [2, 6, 37], inputType), engine.upload(weight, [10, 3, 3], weightType), engine.upload(xz, [], inputType), engine.upload(wz, [10], weightType), { group: 2, dilations: [2], pads: [2, 3] });
  batch.submit(); const expected = [];
  for (let n = 0; n < 2; n++) for (let c = 0; c < 10; c++) for (let x = 0; x < 38; x++) {
    let sum = 0; for (let ci = 0; ci < 3; ci++) for (let k = 0; k < 3; k++) {
      const source = x + k * 2 - 2;
      if (source >= 0 && source < 37) sum += (input[(n * 6 + Math.floor(c / 5) * 3 + ci) * 37 + source] - xz[0]) * (weight[(c * 3 + ci) * 3 + k] - wz[c]);
    }
    expected.push(sum);
  }
  expect(output.shape).toEqual([2, 10, 38]); expect([...await engine.read(output)]).toEqual(expected);
});

it('executes original fused activations, skip normalization and transposed batch matmul', async () => {
  const x = values([2, 3]), skip = values([2, 3], 4), scale = Float32Array.of(1, 2, 3), bias = Float32Array.of(.1, -.2, .3);
  const batch = engine.batch(), a = upload(x, [2, 3]), b = upload(skip, [2, 3]);
  const gelu = engine.kokoro.fastGelu(batch, a, upload(bias, [3]));
  const norm = engine.kokoro.skipLayerNormalization(batch, a, b, upload(scale, [3]), upload(bias, [3]), null, { epsilon: 1e-12 });
  const product = engine.kokoro.fusedMatmul(batch, a, b, { transA: 1 }); batch.submit();
  near(await engine.read(gelu), Float32Array.from(x, (v, i) => { v += bias[i % 3]; return .5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + .044715 * v ** 3))); }), 2e-7);
  near(await engine.read(norm), referenceLayerNormalization(Float32Array.from(x, (v, i) => v + skip[i]), [2, 3], scale, bias, { epsilon: 1e-12 }), 1e-6);
  const expected = []; for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) expected.push(x[row] * skip[col] + x[row + 3] * skip[col + 3]);
  near(await engine.read(product), expected, 2e-8);
});

it('preserves exact typed selection, cast, expansion, reflection and one-dimensional operations', async () => {
  const batch = engine.batch(), x = upload([-1.8, 0, 1.8, 16777217], [2, 2]), integer = batch.cast(x, 7), condition = batch.compare('Greater', integer, engine.uploadInt32(Int32Array.of(0), []));
  const selected = batch.where(condition, integer, engine.uploadInt32(Int32Array.of(-1), []));
  const expanded = batch.expand(engine.upload(Int8Array.of(-128, 127), [2, 1], 'int8'), [2, 3]);
  const input = upload([1, 2, 3], [1, 1, 3]), padded = batch.pad(input, [0, 0, 2, 0, 0, 2], 'reflect');
  const conv = batch.convolution(input, upload([1, 2], [1, 1, 2])), resized = batch.resize(input, { sizes: [1, 1, 5], mode: 'linear', coordinateMode: 'align_corners' });
  batch.submit(); expect([...await engine.read(selected)]).toEqual([-1, -1, 1, 16777216]); expect([...await engine.read(expanded)]).toEqual([-128, -128, -128, 127, 127, 127]);
  near(await engine.read(padded), [3, 2, 1, 2, 3, 2, 1]); near(await engine.read(conv), [5, 8]); near(await engine.read(resized), [1, 1.5, 2, 2.5, 3]);
});

it('uses live token indices for exact one-byte embedding Gather and checks out-of-range values at execution', async () => {
  const input = engine.upload(Int8Array.of(-128, -4, 7, 127, 34, -9), [3, 2], 'int8');
  const indices = engine.uploadInt32(Int32Array.of(2, -3), [1, 2]), batch = engine.batch({ capture: true });
  const output = batch.gatherTensor(input, indices); batch.submit();
  expect(output.shape).toEqual([1, 2, 2]); expect([...await engine.read(output)]).toEqual([34, -9, -128, -4]);
  engine.write(indices, Int32Array.of(1, 0)); batch.replay(); expect([...await engine.read(output)]).toEqual([7, 127, -128, -4]);
  engine.write(indices, Int32Array.of(3, 0)); expect(() => batch.replay()).toThrow(/invalid operation data/);
});

it('creates bounded integer and floating ranges and typed fills inside captured commands', async () => {
  const batch = engine.batch({ capture: true });
  const increasing = batch.range(16777217, 16777224, 2, 'int32'), decreasing = batch.range(3, -4, -2, 'int32');
  const floating = batch.range(-.5, 1, .25, 'float32'), empty = batch.range(3, 1, 2, 'int32');
  const filled = batch.fill([2, 3], -128, 'int8'), zero = batch.fill([2], -0, 'float32');
  batch.submit(); expect([...await engine.read(increasing)]).toEqual([16777217, 16777219, 16777221, 16777223]);
  expect([...await engine.read(decreasing)]).toEqual([3, 1, -1, -3]); expect([...await engine.read(floating)]).toEqual([-.5, -.25, 0, .25, .5, .75]);
  expect([...await engine.read(empty)]).toEqual([]); expect([...await engine.read(filled)]).toEqual([-128, -128, -128, -128, -128, -128]);
  expect(Object.is((await engine.read(zero))[0], -0)).toBe(true); batch.replay();
  expect(() => engine.batch().range(0, 1, 0)).toThrow(); expect(() => engine.batch().fill([1], 2, 'bool')).toThrow();
});

it('keeps exact integer arithmetic beyond float precision and rejects native division/scan overflow', async () => {
  const input = engine.uploadInt32(Int32Array.of(16777217, -7, 11), [3]), two = engine.uploadInt32(Int32Array.of(2), []), batch = engine.batch();
  const sum = batch.binary('Add', input, two), product = batch.binary('Mul', sum, two), divided = batch.binary('Div', input, two);
  const scan = engine.kokoro.cumsum(batch, input, 0); batch.submit();
  expect([...await engine.read(product)]).toEqual([33554438, -10, 26]); expect([...await engine.read(divided)]).toEqual([8388608, -3, 5]);
  expect([...await engine.read(scan)]).toEqual([16777217, 16777210, 16777221]);
  const overflow = engine.batch(); engine.kokoro.cumsum(overflow, engine.uploadInt32(Int32Array.of(2147483647, 1), [2]), 0);
  expect(() => overflow.submit()).toThrow(/overflowing/);
  const division = engine.batch(); division.binary('Div', input, engine.uploadInt32(Int32Array.of(0), [])); expect(() => division.submit()).toThrow(/invalid/);
});

it.each(['Add', 'Mul', 'Div', 'Sub'])('preserves two-sided noncommutative integer broadcasts above float precision: %s', async operation => {
  const a = Int32Array.of(-8, 3, 16777217, 5, -2, 11), b = Int32Array.of(2, -3, 4, 7), batch = engine.batch();
  const output = batch.binary(operation, engine.uploadInt32(a, [2, 1, 3]), engine.uploadInt32(b, [1, 4, 1])); batch.submit();
  const expected = [];
  for (let n = 0; n < 2; n++) for (let c = 0; c < 4; c++) for (let x = 0; x < 3; x++) {
    const lhs = a[n * 3 + x], rhs = b[c]; expected.push(operation === 'Add' ? lhs + rhs : operation === 'Mul' ? lhs * rhs : operation === 'Div' ? Math.trunc(lhs / rhs) : lhs - rhs);
  }
  expect(output.shape).toEqual([2, 4, 3]); expect(await engine.read(output)).toEqual(Int32Array.from(expected));
});

it.each([['Add', 2147483647, 1], ['Sub', -2147483648, 1], ['Mul', 2147483647, 2], ['Div', -2147483648, -1]])('rejects overflowing integer %s inside a later broadcast run', (operation, lhs, rhs) => {
  const batch = engine.batch(); batch.binary(operation, engine.uploadInt32(Int32Array.of(0, lhs), [2, 1]), engine.uploadInt32(Int32Array.of(rhs, rhs, rhs), [1, 3]));
  expect(() => batch.submit()).toThrow(/overflowing/);
});

it('keeps negative-base ALBERT cubic powers exact instead of using a logarithmic approximation', async () => {
  const data = Float32Array.of(-3, -1.25, -.5, -0, 0, .5, 1.25, 3), batch = engine.batch();
  const output = batch.binary('Pow', upload(data, [data.length]), upload([3], [])); batch.submit();
  expect([...await engine.read(output)]).toEqual(Array.from(data, x => Math.fround(Math.fround(x * x) * x)));
  const invalid = engine.batch(); invalid.binary('Pow', upload([2], []), upload([.5], [])); expect(() => invalid.submit()).toThrow(/invalid operation/);
});

it('refuses invalid quantization storage, unsafe accumulators and unsupported operator variants', () => {
  const batch = engine.batch(), input = upload([1], [1]);
  expect(() => engine.kokoro.matmulInteger(batch, input, input)).toThrow();
  expect(() => engine.kokoro.dequantizeLinear(batch, engine.upload(Int8Array.of(1), [1], 'int8'), input, engine.upload(Uint8Array.of(0), [], 'uint8'))).toThrow();
  expect(() => engine.kokoro.fusedMatmul(batch, upload([1], [1, 1]), upload([1], [1, 1]), { alpha: 2 })).toThrow();
  const invalid = engine.kokoro.dynamicQuantizeLinear(batch, upload([Infinity], [1]));
  expect(() => batch.submit()).toThrow(/nonfinite/); expect(invalid[0].dataType).toBe('uint8');
});
