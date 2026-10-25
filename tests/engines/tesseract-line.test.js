import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WasmTesseractCompute } from '../../src/engines/tesseract-line-compute.js';
import { TesseractLineModel } from '../../src/engines/tesseract-line-model.js';
import { normalizeTesseractLine, decodeTesseractLine, tesseractLineSession } from '../../src/engines/tesseract-line-recognizer.js';
import { recognizePdfOcrNeuralLines } from '../../src/lib/pdf-ocr-neural-batch.js';

const wasm = readFileSync('public/native/ocr-lstm-engine.wasm');
let engine, model;
afterEach(async () => { await model?.dispose(); await engine?.dispose(); model = engine = null; });

function syntheticModel() {
  const chunks = []; let size = 0;
  const append = (array, type) => {
    const padding = (16 - size % 16) % 16; chunks.push(Buffer.alloc(padding)); size += padding;
    const descriptor = { type, offset: size, bytes: array.byteLength }; size += array.byteLength;
    chunks.push(Buffer.from(array.buffer)); return descriptor;
  };
  const matrix = (rows, columns) => ({ rows, columns, weights: append(new Int8Array(rows * columns), 'int8'), scales: append(new Float32Array(rows).fill(1 / 127), 'float32') });
  const recurrent = (hidden, channels) => ({ type: 'LSTM', gates: Array.from({ length: 4 }, () => matrix(hidden, channels + hidden + 1)) });
  const network = { type: 'Series', children: [{ type: 'Input' }, { type: 'Series', children: [{ type: 'Convolve' }, { type: 'Tanh', matrix: matrix(16, 10) }] },
    { type: 'Maxpool' }, { type: 'XYTranspose', children: [recurrent(64, 16)] }, recurrent(96, 64), { type: 'RTLReversed', children: [recurrent(96, 96)] },
    recurrent(512, 96), { type: 'Softmax', matrix: matrix(111, 513) }] };
  const bytes = Buffer.concat(chunks), alphabet = [' ', ...Array.from({ length: 109 }, (_, i) => String.fromCharCode(33 + i)), ''];
  return { bytes, manifest: { schema: 'pagenarrator-english-lstm-v1', source: { sha256: 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047' },
    spec: '[1,36,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx512O1c1]', blank: 110, sampleIteration: 0, alphabet, network,
    weights: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } };
}

it('uses original int8 recurrent state with separate forward, reverse and vertical summary boundaries', async () => {
  engine = await WasmTesseractCompute.create(wasm);
  const input = engine.upload(Int8Array.of(1, 2, 3, 4, 5, 6), [2, 3, 1], 'int8');
  const weights = new Int8Array(12); weights[2] = 1;
  const w = engine.upload(weights, [4, 1, 3], 'int8'), scales = engine.upload(new Float32Array(4).fill(1 / 127), [4, 1]);
  const batch = engine.batch(), forward = batch.recurrent(input, w, scales, 1), reverse = batch.recurrent(input, w, scales, 1, { reverse: true });
  const vertical = batch.recurrent(input, w, scales, 1, { vertical: true, summary: true }); batch.submit();
  let cell = 0;
  const expected = Array.from({ length: 3 }, () => { cell = cell * .5 + Math.tanh(1) * .5; return Math.round(127 * Math.tanh(cell) * .5); });
  expect([...await engine.read(forward)]).toEqual([...expected, ...expected]);
  expect([...await engine.read(reverse)]).toEqual([...expected].reverse().concat([...expected].reverse()));
  expect(vertical.shape).toEqual([1, 3, 1]); expect([...await engine.read(vertical)]).toEqual([expected[1], expected[1], expected[1]]);
});

it('keeps learned convolution ordering, quantization and floor-sized max pooling', async () => {
  engine = await WasmTesseractCompute.create(wasm);
  const values = Int8Array.from({ length: 4 * 7 }, (_, i) => i * 9 - 120), weights = new Int8Array(160);
  weights[4] = 1; weights[10 + 1] = 1; weights[20 + 9] = 1; weights[30 + 3] = 1;
  const batch = engine.batch(), input = engine.upload(values, [4, 7, 1], 'int8');
  const output = batch.convTanh(input, engine.upload(weights, [16, 10], 'int8'), engine.upload(new Float32Array(16).fill(1 / 127), [16]));
  const pooled = batch.bytePool(output); batch.submit();
  const actual = await engine.read(output), expected = value => Math.round(127 * Math.tanh(value / 127));
  for (let y = 0; y < 4; y++) for (let x = 0; x < 7; x++) {
    const offset = (y * 7 + x) * 16;
    expect(actual[offset]).toBe(expected(values[y * 7 + x])); expect(actual[offset + 2]).toBe(expected(127));
    if (x) expect(actual[offset + 1]).toBe(expected(values[y * 7 + x - 1]));
    if (y) expect(actual[offset + 3]).toBe(expected(values[(y - 1) * 7 + x]));
  }
  expect(pooled.shape).toEqual([1, 2, 16]);
  const pool = await engine.read(pooled);
  for (let x = 0; x < 2; x++) for (let c = 0; c < 16; c++) {
    const region = []; for (let y = 0; y < 3; y++) for (let dx = 0; dx < 3; dx++) region.push(actual[(y * 7 + x * 3 + dx) * 16 + c]);
    expect(pool[x * 16 + c]).toBe(Math.max(...region));
  }
});

it('preserves exact signed int8 SIMD dot products and scalar tails before output scaling', async () => {
  engine = await WasmTesseractCompute.create(wasm);
  const channels = 33, classes = 3, values = Int8Array.from({ length: channels * 2 }, (_, i) => (i * 67) % 255 - 127);
  const weights = Int8Array.from({ length: classes * (channels + 1) }, (_, i) => (i * 73 + 19) % 255 - 127), scales = Float32Array.of(.00031, .0037, .00001);
  const batch = engine.batch(), output = batch.affine(engine.upload(values, [1, 2, channels], 'int8'), engine.upload(weights, [classes, channels + 1], 'int8'), engine.upload(scales, [classes]), classes);
  batch.submit();
  const expected = [];
  for (let step = 0; step < 2; step++) for (let c = 0; c < classes; c++) {
    let sum = weights[c * (channels + 1) + channels] * 127;
    for (let k = 0; k < channels; k++) sum += values[step * channels + k] * weights[c * (channels + 1) + k];
    expected.push(Math.fround(sum * scales[c]));
  }
  expect([...await engine.read(output)]).toEqual(expected);
});

it('matches an independent scalar recurrence with distinct gates, signed inputs and changing recurrent state', async () => {
  engine = await WasmTesseractCompute.create(wasm);
  const channels = 17, hidden = 3, height = 2, width = 5, columns = channels + hidden + 1;
  const values = Int8Array.from({ length: height * width * channels }, (_, i) => (i * 53 + 7) % 255 - 127);
  const weights = Int8Array.from({ length: 4 * hidden * columns }, (_, i) => (i * 11 + 3) % 7 - 3), scales = new Float32Array(hidden * 4).fill(1 / (127 * 20));
  const batch = engine.batch(), input = engine.upload(values, [height, width, channels], 'int8');
  const w = engine.upload(weights, [4, hidden, columns], 'int8'), s = engine.upload(scales, [4, hidden]);
  const forwards = batch.recurrent(input, w, s, hidden), backwards = batch.recurrent(input, w, s, hidden, { reverse: true }); batch.submit();
  const quantize = value => Math.max(-127, Math.min(127, value < 0 ? -Math.floor(-value * 127 + .5) : Math.floor(value * 127 + .5)));
  const reference = reverse => {
    const result = new Int8Array(height * width * hidden);
    for (let y = 0; y < height; y++) {
      const state = new Float32Array(hidden), output = new Float32Array(hidden);
      for (let t = 0; t < width; t++) {
        const x = reverse ? width - t - 1 : t, source = [...values.slice((y * width + x) * channels, (y * width + x + 1) * channels), ...Array.from(output, quantize)];
        const gates = Array.from({ length: 4 }, (_, gate) => Array.from({ length: hidden }, (_, c) => {
          const row = (gate * hidden + c) * columns;
          let sum = weights[row + columns - 1] * 127;
          for (let i = 0; i < source.length; i++) sum += source[i] * weights[row + i];
          const value = Math.fround(sum * scales[gate * hidden + c]);
          return Math.fround(gate ? 1 / (1 + Math.exp(-value)) : Math.tanh(value));
        }));
        for (let c = 0; c < hidden; c++) {
          state[c] = Math.max(-100, Math.min(100, Math.fround(Math.fround(state[c] * gates[2][c]) + Math.fround(gates[0][c] * gates[1][c]))));
          output[c] = Math.fround(Math.fround(Math.tanh(state[c])) * gates[3][c]); result[(y * width + x) * hidden + c] = quantize(output[c]);
        }
      }
    }
    return result;
  };
  for (const [tensor, reverse] of [[forwards, false], [backwards, true]]) {
    const actual = await engine.read(tensor), expected = reference(reverse);
    actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(1));
  }
});

it('runs the fixed graph with bounded captured replay, clears changed shapes and disposes every allocation', async () => {
  const fixture = syntheticModel(); model = await TesseractLineModel.create(fixture.manifest, fixture.bytes, wasm);
  const first = await model.runPixels(new Int8Array(36 * 35), 35), memory = model.engine.memory.buffer.byteLength, buffers = model.engine.buffers.size;
  expect(first.dims).toEqual([11, 111]); expect([...first.data].every(value => Math.abs(value - 1 / 111) < 1e-7)).toBe(true);
  const replay = await model.runPixels(new Int8Array(36 * 35).fill(127), 35);
  expect(replay.data).toEqual(first.data); expect(model.engine.buffers.size).toBe(buffers); expect(model.engine.memory.buffer.byteLength).toBe(memory);
  await model.runPixels(new Int8Array(36 * 128).fill(-127), 128); await model.clearPlan();
  expect(model.engine.buffers.size).toBe(14);
  await expect(model.runPixels(new Int8Array(36 * 128).fill(-128), 128)).rejects.toThrow('normalized');
  await model.dispose(); expect(model.engine.buffers.size).toBe(0); expect(model.engine.tensors.size).toBe(0);
  await expect(model.runPixels(new Int8Array(36 * 3), 3)).rejects.toThrow('closed');
});

it('cleans a partially built plan after native command planning fails and permits recovery', async () => {
  const fixture = syntheticModel(); model = await TesseractLineModel.create(fixture.manifest, fixture.bytes, wasm);
  const original = model.engine.batch.bind(model.engine);
  model.engine.batch = options => { const batch = original(options); batch.recurrent = () => { throw new Error('injected planning failure'); }; return batch; };
  await expect(model.runPixels(new Int8Array(36 * 33), 33)).rejects.toThrow('injected');
  expect(model.engine.buffers.size).toBe(14); expect(model.plan).toBe(null);
  model.engine.batch = original; expect((await model.runPixels(new Int8Array(36 * 33), 33)).dims).toEqual([11, 111]);
});

it('rejects changed weight data before creating a native model', async () => {
  const fixture = syntheticModel(); fixture.bytes[0] = 1;
  await expect(TesseractLineModel.create(fixture.manifest, fixture.bytes, wasm)).rejects.toThrow('corrupt');
});

it('borrows the worker arena without disposing it and cleans a partially rejected model alone', async () => {
  engine = await WasmTesseractCompute.create(wasm); const fixture = syntheticModel();
  const sentinel = engine.upload(Int8Array.of(5), [1], 'int8');
  model = await TesseractLineModel.create(fixture.manifest, fixture.bytes, null, { engine });
  await model.runPixels(new Int8Array(36 * 33), 33); await model.dispose();
  expect(engine.closed).toBe(false); expect(engine.buffers.size).toBe(3); expect([...await engine.read(sentinel)]).toEqual([5]);
  fixture.manifest.network.children[7].matrix.columns = 514;
  await expect(TesseractLineModel.create(fixture.manifest, fixture.bytes, null, { engine })).rejects.toThrow('dimensions');
  expect(engine.buffers.size).toBe(3); expect([...await engine.read(sentinel)]).toEqual([5]);
});

it('normalizes grayscale ranges, transparent pixels, cropped regions and image bounds deterministically', () => {
  const rgba = new Uint8Array(6 * 36 * 4).fill(255);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 6; x++) {
    const i = (y * 6 + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = x % 2 ? 240 : 20;
  }
  const input = normalizeTesseractLine({ data: rgba, width: 6, height: 36 });
  expect(input.width).toBe(6); expect(input.height).toBe(36); expect([...input.data.slice(0, 6)]).toEqual([-127, 127, -127, 127, -127, 127]);
  const transparent = new Uint8Array(4 * 36 * 4), white = normalizeTesseractLine({ data: transparent, width: 4, height: 36 });
  expect([...white.data].every(value => value === 127)).toBe(true);
  expect(normalizeTesseractLine({ data: rgba, width: 6, height: 36 }, { left: 2, cropWidth: 3 }).data.length).toBe(108);
  expect(() => normalizeTesseractLine({ data: rgba, width: 6, height: 36 }, { left: -1 })).toThrow();
  expect(() => normalizeTesseractLine({ data: new Uint8Array(9000 * 4), width: 9000, height: 1 })).toThrow('width');
});

it('maps the last-class blank and space correctly without dictionaries or lexical rewriting', () => {
  const alphabet = [' ', 'a', ...Array.from({ length: 108 }, () => '?'), ''], labels = [1, 1, 110, 1, 0, 1], data = new Float32Array(labels.length * 111);
  labels.forEach((label, i) => { data[i * 111 + label] = 1; });
  const geometry = { left: 10, top: 10, height: 36, width: 60, inputWidth: 60 };
  const words = decodeTesseractLine({ data, dims: [6, 111] }, alphabet, geometry);
  expect(words.map(word => word.text)).toEqual(['aa', 'a']); expect(words[1].bbox).toEqual({ x0: 60, y0: 10, x1: 70, y1: 46 });
  expect(decodeTesseractLine({ data, dims: [6, 111] }, alphabet, geometry, { beam: true })).toEqual(words);
  data[0] = NaN; expect(() => decodeTesseractLine({ data, dims: [6, 111] }, alphabet, geometry)).toThrow('probability');
});

it('scores each complete emitted character run without changing text, repeats or timestamp geometry', () => {
  const alphabet = [' ', 'a', 'b', ...Array.from({ length: 107 }, () => '?'), ''];
  const labels = [1, 1, 110, 1, 1, 0, 2, 2], probabilities = [.55, .95, 1, .65, .99, .98, .6, .97];
  const data = new Float32Array(labels.length * 111);
  labels.forEach((label, i) => { data[i * 111 + label] = probabilities[i]; if (label !== 110) data[i * 111 + 110] = 1 - probabilities[i]; });
  const result = decodeTesseractLine({ data, dims: [8, 111] }, alphabet, { left: 10, top: 10, height: 36, width: 80, inputWidth: 80 });
  expect(result.map(word => word.text)).toEqual(['aa', 'b']);
  expect(result[0].confidence).toBeCloseTo(97, 4); expect(result[1].confidence).toBeCloseTo(97, 4);
  expect(result.map(word => word.bbox)).toEqual([{ x0: 10, y0: 10, x1: 60, y1: 46 }, { x0: 70, y0: 10, x1: 90, y1: 46 }]);
});

it('adapts only explicit candidate sessions to the existing line and word geometry contract', async () => {
  const data = new Uint8ClampedArray(80 * 56 * 4).fill(255), posterior = new Float32Array(20 * 111);
  for (let i = 0; i < 20; i++) posterior[i * 111 + (i === 4 ? 1 : 110)] = 1;
  const alphabet = [' ', 'a', ...Array.from({ length: 108 }, () => '?'), ''];
  const candidate = tesseractLineSession({ manifest: { alphabet }, runPixels: async () => ({ data: posterior, dims: [20, 111] }) });
  const [result] = await recognizePdfOcrNeuralLines([{ width: 80, height: 56, getContext: () => ({ getImageData: () => ({ data, width: 80, height: 56 }) }) }], {}, candidate, []);
  const line = result.blocks[0].paragraphs[0].lines[0]; expect(line.words[0].text).toBe('a'); expect(line.bbox).toEqual({ x0: 10, y0: 10, x1: 70, y1: 46 });
});
