// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { kokoroOperatorFixture } from './lib/kokoro-operator-fixture.mjs';
import { referenceStft } from '../src/engines/kokoro-kernels-shape.js';

const engine = await WasmKokoroCompute.create(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url)));
const report = { status: 'incomplete', scope: 'Independent ONNX Runtime Node CPU operator oracle, no browser/GPU; no full speech/quality/performance claim', cases: [] };
const sizes = shape => shape.reduce((a, b) => a * b, 1);
const values = (shape, seed = 1, magnitude = .2) => Float32Array.from({ length: sizes(shape) }, (_, i) => Math.sin(i * .71 + seed) * magnitude);
const typeName = type => ({ 1: 'float32', 2: 'uint8', 3: 'int8', 6: 'int32', 7: 'int64', 9: 'bool' })[type];
async function probe(name, op, specs, outputs, run, attrs = {}, domain = '', tolerance = { absolute: 3e-6, relative: 3e-5 }) {
  const inputs = specs.map((spec, i) => spec ? { name: `x${i}`, type: spec.type ?? 1, shape: spec.shape } : null);
  const infos = outputs.map((spec, i) => ({ name: `y${i}`, ...spec }));
  const baseline = await oracle.InferenceSession.create(kokoroOperatorFixture(op, inputs, infos, attrs, domain), {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled',
  });
  const batch = engine.batch({ capture: true });
  try {
    const tensors = specs.map(spec => spec ? engine.upload(spec.engineData ?? spec.data, spec.shape, spec.engineType ?? typeName(spec.type ?? 1)) : null);
    const result = run(batch, tensors); batch.submit();
    const feed = Object.fromEntries(specs.flatMap((spec, i) => spec ? [[`x${i}`, new oracle.Tensor(typeName(spec.type ?? 1), spec.data, spec.shape)]] : []));
    const expected = await baseline.run(feed), records = [];
    for (let i = 0; i < result.length; i++) {
      const actual = await engine.read(result[i]), other = expected[`y${i}`];
      if (result[i].shape.join(',') !== other.dims.join(',') || actual.length !== other.data.length) throw new Error(`${name}: shape differs.`);
      let maximumAbsolute = 0, mismatches = 0, squareError = 0, squareReference = 0;
      for (let j = 0; j < actual.length; j++) {
        const delta = Math.abs(actual[j] - other.data[j]);
        if (!Number.isFinite(actual[j]) || !Number.isFinite(other.data[j])) throw new Error(`${name}: nonfinite output.`);
        maximumAbsolute = Math.max(maximumAbsolute, delta); squareError += delta ** 2; squareReference += other.data[j] ** 2;
        if (delta > ((outputs[i].type === 1) ? tolerance.absolute + tolerance.relative * Math.abs(other.data[j]) : 0)) mismatches++;
      }
      const record = { shape: other.dims, maximumAbsolute, relativeRmse: Math.sqrt(squareError / Math.max(1e-30, squareReference)), mismatches };
      if (op === 'STFT') {
        const ideal = referenceStft(specs[0].data, specs[0].shape, specs[2].data, { frameLength: 20, frameStep: 5 });
        const maximumError = data => data.reduce((maximum, value, j) => Math.max(maximum, Math.abs(value - ideal[j])), 0);
        record.independentFloat64Dft = { candidateMaximumAbsolute: maximumError(actual), oracleMaximumAbsolute: maximumError(other.data),
          note: 'Both algorithms are checked against scalar double DFT; independent FFT and direct DFT round differently. Full-model PCM thresholds remain unchanged.' };
        if (record.independentFloat64Dft.candidateMaximumAbsolute > 2e-6 || record.independentFloat64Dft.oracleMaximumAbsolute > 2e-5) throw new Error('STFT exceeds its independent mathematical accuracy bound.');
        for (let frame = 0; frame < 8; frame++) for (const bin of [0, 10]) if (actual[(frame * 11 + bin) * 2 + 1] !== 0) throw new Error('Real STFT bin has imaginary residue.');
      }
      records.push(record);
    }
    report.cases.push({ name, op, tolerance, outputs: records }); console.log(`${name}: ${JSON.stringify(records)}`);
    if (records.some(record => record.mismatches)) throw new Error(`${name}: independent operator parity failed.`);
    batch.replay();
    for (let i = 0; i < result.length; i++) {
      const replay = await engine.read(result[i]);
      if (replay.some((value, j) => value !== expected[`y${i}`].data[j] && Math.abs(value - expected[`y${i}`].data[j]) > tolerance.absolute + tolerance.relative * Math.abs(expected[`y${i}`].data[j]))) throw new Error(`${name}: captured replay differs.`);
    }
  } finally {
    if (!batch.submitted) batch.cancel();
    await baseline.release(); await engine.releaseMany([...engine.tensors], batch.scratchBuffers());
    if (engine.buffers.size || engine.tensors.size) throw new Error('Speech operator leaked arena storage.');
  }
}
try {
  for (const data of [Float32Array.of(0, 2, -3, -2.5, 1.34, .5), new Float32Array(6), Float32Array.of(0, .5, 1.5, 2.5, 254.5, 255)]) {
    await probe(`dynamic-quantization-${report.cases.length}`, 'DynamicQuantizeLinear', [{ shape: [2, 3], data }], [{ type: 2, shape: [2, 3] }, { type: 1, shape: [] }, { type: 2, shape: [] }],
      (batch, [input]) => engine.kokoro.dynamicQuantizeLinear(batch, input));
  }
  const a = Uint8Array.from({ length: 42 }, (_, i) => i * 13 % 256), b = Int8Array.from({ length: 35 }, (_, i) => i * 23 % 256 - 128);
  await probe('integer-batched-matmul', 'MatMulInteger', [{ shape: [2, 3, 7], data: a, type: 2 }, { shape: [7, 5], data: b, type: 3 }, { shape: [], data: Uint8Array.of(113), type: 2 }, { shape: [5], data: Int8Array.of(1, 2, 3, 4, 5), type: 3 }],
    [{ type: 6, shape: [2, 3, 5] }], (batch, inputs) => [engine.kokoro.matmulInteger(batch, ...inputs)]);
  await probe('integer-padded-dilated-convolution', 'ConvInteger', [
    { shape: [1, 3, 19], type: 2, data: Uint8Array.from({ length: 57 }, (_, i) => i * 17 % 256) },
    { shape: [5, 3, 7], type: 2, data: Uint8Array.from({ length: 105 }, (_, i) => i * 7 % 256) },
    { shape: [], type: 2, data: Uint8Array.of(107) }, { shape: [], type: 2, data: Uint8Array.of(123) },
  ], [{ type: 6, shape: [1, 5, 10] }], (batch, x) => [engine.kokoro.convInteger(batch, ...x, { dilations: [3], strides: [2], pads: [9, 9] })], { dilations: [3], strides: [2], pads: [9, 9] });
  await probe('per-axis-dequantization', 'DequantizeLinear', [
    { shape: [2, 3, 4], type: 3, data: Int8Array.from({ length: 24 }, (_, i) => i * 7 - 64) },
    { shape: [3], data: Float32Array.of(.002, .004, .006) }, { shape: [3], type: 3, data: Int8Array.of(-1, 2, 3) },
  ], [{ type: 1, shape: [2, 3, 4] }], (batch, x) => [engine.kokoro.dequantizeLinear(batch, ...x, { axis: 1 })], { axis: 1 });
  await probe('fast-gelu-bias', 'FastGelu', [{ shape: [2, 5], data: values([2, 5], 7, 4) }, { shape: [5], data: values([5], 3) }],
    [{ type: 1, shape: [2, 5] }], (batch, x) => [engine.kokoro.fastGelu(batch, ...x)], {}, 'com.microsoft');
  await probe('skip-layer-normalization-eps12', 'SkipLayerNormalization', [
    { shape: [1, 3, 128], data: values([1, 3, 128]) }, { shape: [1, 3, 128], data: values([1, 3, 128], 7) },
    { shape: [128], data: values([128], 11, 2) }, { shape: [128], data: values([128], 17) },
  ], [{ type: 1, shape: [1, 3, 128] }], (batch, x) => [engine.kokoro.skipLayerNormalization(batch, ...x, null, { epsilon: 1e-12 })], { epsilon: 1e-12 }, 'com.microsoft');
  await probe('dense-transposed-convolution-512x256-hann20', 'ConvTranspose', [
    { shape: [1, 512, 3], data: values([1, 512, 3]) }, { shape: [512, 256, 20], data: values([512, 256, 20], 7, .02) },
    { shape: [256], data: values([256], 11) },
  ], [{ type: 1, shape: [1, 256, 30] }], (batch, x) => [batch.convolution(...x, { transpose: true, strides: [5] })], { strides: [5] });
  await probe('real-speech-stft-hann20-hop5', 'STFT', [
    { shape: [2, 39], data: values([2, 39], 3, 2) },
    { shape: [], type: 7, data: BigInt64Array.of(5n), engineType: 'int32', engineData: Int32Array.of(5) },
    { shape: [20], data: Float32Array.from({ length: 20 }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / 20)) },
    { shape: [], type: 7, data: BigInt64Array.of(20n), engineType: 'int32', engineData: Int32Array.of(20) },
  ], [{ type: 1, shape: [2, 4, 11, 2] }], (batch, x) => [engine.kokoro.stft(batch, x[0], x[2], { frameStep: 5, frameLength: 20 })], { onesided: 1 }, '', { absolute: 2e-5, relative: 3e-5 });
  await probe('final-istft-transposed-convolution22x1-hann20', 'ConvTranspose', [
    { shape: [1, 22, 6721], data: values([1, 22, 6721], 3) }, { shape: [22, 1, 20], data: values([22, 1, 20], 7, .02) },
  ], [{ type: 1, shape: [1, 1, 33620] }], (batch, x) => [batch.convolution(...x, null, { transpose: true, strides: [5] })], { strides: [5] });
  for (const batchSize of [1, 2]) for (const directions of [1, 2]) for (const perChannel of [false, true]) {
    const h = 3, features = 4, steps = 5, shape = [steps, batchSize, features], d = directions;
    const qshape = perChannel ? [d, 4 * h] : [d];
    const specs = [
      { shape, data: values(shape, 3, 2) },
      { shape: [d, features, 4 * h], type: 3, data: Int8Array.from({ length: d * features * 4 * h }, (_, i) => i * 17 % 255 - 127) },
      { shape: [d, h, 4 * h], type: 3, data: Int8Array.from({ length: d * h * 4 * h }, (_, i) => i * 13 % 255 - 127) },
      { shape: [d, 8 * h], data: values([d, 8 * h], 7) }, null,
      { shape: [d, batchSize, h], data: values([d, batchSize, h], 13) },
      { shape: [d, batchSize, h], data: values([d, batchSize, h], 17) }, null,
      { shape: qshape, data: Float32Array.from({ length: sizes(qshape) }, (_, i) => .003 + i * .00001) },
      { shape: qshape, type: 3, data: Int8Array.from({ length: sizes(qshape) }, (_, i) => perChannel ? 0 : i % 3 - 1) },
      { shape: qshape, data: Float32Array.from({ length: sizes(qshape) }, (_, i) => .002 + i * .00001) },
      { shape: qshape, type: 3, data: Int8Array.from({ length: sizes(qshape) }, (_, i) => perChannel ? 0 : i % 5 - 2) },
    ];
    await probe(`dynamic-lstm-batch${batchSize}-directions${d}-channel${perChannel}`, 'DynamicQuantizeLSTM', specs,
      [{ type: 1, shape: [steps, d, batchSize, h] }, { type: 1, shape: [d, batchSize, h] }, { type: 1, shape: [d, batchSize, h] }],
      (batch, x) => engine.kokoro.dynamicQuantizeLstm(batch, x[0], x[1], x[2], x[3], x[5], x[6], x[8], x[9], x[10], x[11], { hiddenSize: h, direction: d === 2 ? 'bidirectional' : 'forward' }),
      { hidden_size: h, direction: d === 2 ? 'bidirectional' : 'forward', input_forget: 0 }, 'com.microsoft', { absolute: 3e-6, relative: 1e-4 });
  }
  {
    const h = 256, d = 2, features = 640, steps = 3, shape = [steps, 1, features], state = [d, 1, h];
    const specs = [{ shape, data: values(shape, 3, 2) },
      { shape: [d, features, 4 * h], type: 3, data: Int8Array.from({ length: d * features * 4 * h }, (_, i) => i * 17 % 255 - 127) },
      { shape: [d, h, 4 * h], type: 3, data: Int8Array.from({ length: d * h * 4 * h }, (_, i) => i * 13 % 255 - 127) },
      { shape: [d, 8 * h], data: values([d, 8 * h], 7) }, null,
      { shape: state, data: values(state, 13) }, { shape: state, data: values(state, 17) }, null,
      { shape: [d], data: Float32Array.of(.0003, .00031) }, { shape: [d], type: 3, data: Int8Array.of(0, 0) },
      { shape: [d], data: Float32Array.of(.0002, .00021) }, { shape: [d], type: 3, data: Int8Array.of(0, 0) }];
    await probe('dynamic-lstm-actual640x256-bidirectional', 'DynamicQuantizeLSTM', specs,
      [{ type: 1, shape: [steps, d, 1, h] }, { type: 1, shape: state }, { type: 1, shape: state }],
      (batch, x) => engine.kokoro.dynamicQuantizeLstm(batch, x[0], x[1], x[2], x[3], x[5], x[6], x[8], x[9], x[10], x[11], { hiddenSize: h, direction: 'bidirectional' }),
      { hidden_size: h, direction: 'bidirectional', input_forget: 0 }, 'com.microsoft', { absolute: 3e-6, relative: 1e-4 });
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.message; throw error; }
finally {
  await engine.dispose(); report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size;
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/engines/kokoro-cpu-operators.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
