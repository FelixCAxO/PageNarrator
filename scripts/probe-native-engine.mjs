// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';
import { engineSourcePins } from './lib/engine-source-pins.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const precision = process.argv.includes('--precision');
if (process.argv.slice(2).some(arg => arg !== '--precision')) throw new Error('Usage: node scripts/probe-native-engine.mjs [--precision]');
const adapterConfiguration = browserAdapterConfiguration();
const output = resolve(root, `artifacts/engines/native-gpu${precision ? '-precision' : ''}${adapterConfiguration.suffix}-parity.json`);
const pins = () => engineSourcePins(root, ['scripts/probe-native-engine.mjs', 'scripts/lib/browser-adapter.mjs', 'scripts/lib/engine-source-pins.mjs', 'scripts/lib/onnx-debug-outputs.mjs']);
const implementationPins = await pins();
try { await copyFile(output, output.replace(/\.json$/, `-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator engine verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(`${root}${sep}`) || !['.js', '.mjs', '.wasm'].includes(extname(path))) { response.writeHead(404); response.end(); return; }
    const data = await readFile(path);
    response.writeHead(200, { 'Content-Type': extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: adapterConfiguration.args });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async precision => {
    const gpuModule = '/src/engines/webgpu-compute.js';
    const cpuModule = '/src/engines/native-compute.js';
    const { WebGpuCompute } = await import(gpuModule);
    const { NativeCompute, UNARY_OPERATIONS, BINARY_OPERATIONS } = await import(cpuModule);
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('Native WebGPU adapter unavailable.');
    const device = await adapter.requestDevice({ requiredFeatures: precision ? ['shader-f16'] : [] });
    const validationErrors = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    const engine = await WebGpuCompute.create({ device });
    await engine.prepareCnn();
    const cpu = await NativeCompute.create(await (await fetch('/public/native/engine.wasm')).arrayBuffer());
    const cases = [], precisionDiagnostics = [], inferenceContracts = [];
    function compare(name, actual, expected, { absolute = 1e-5, relative = 3e-6 } = {}) {
      if (actual.length !== expected.length) throw new Error(`${name}: wrong output length`);
      let maxAbsoluteError = 0;
      for (let i = 0; i < actual.length; i += 1) {
        const error = Math.abs(actual[i] - expected[i]);
        if (!Number.isFinite(error) || error > absolute + relative * Math.abs(expected[i])) {
          throw new Error(`${name}[${i}]: GPU ${actual[i]}, C++/WASM ${expected[i]}`);
        }
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
      }
      cases.push({ name, elements: actual.length, maxAbsoluteError });
    }
    try {
      if (precision) {
        const formatModule = '/src/engines/tensor-format.js', { floatToHalf, halfToFloat } = await import(formatModule);
        const contractFixtureModule = '/scripts/lib/onnx-debug-outputs.mjs', inferenceModule = '/src/engines/browser-inference.js';
        const { halfIntermediateFixture } = await import(contractFixtureModule);
        const { Tensor, InferenceSession, createBrowserInferenceEngine } = await import(inferenceModule);
        const contractInput = new Tensor('float32', Float32Array.of(0, -0, 1, -2, 1 + 2 ** -11, 1 + 3 * 2 ** -11,
          65504, 2 ** -24, 2 ** -25, -(2 ** -24), 123.125), [11]);
        const contractModel = halfIntermediateFixture(contractInput.size);
        const expectedHalf = Float32Array.from(contractInput.data, value => halfToFloat(floatToHalf(value)));
        const automatic = await InferenceSession.create(contractModel), automaticCompute = automatic.session.engine;
        try {
          if (!automaticCompute.device.features.has('shader-f16')) throw new Error('Intermediate-only fp16 was not negotiated.');
          const result = (await automatic.run({ x: contractInput })).y;
          try { compare('automatic intermediate-only fp16 model', result.data, expectedHalf, { absolute: 0, relative: 0 }); }
          finally { result.dispose(); }
        } finally { await automatic.release(); }
        if (automaticCompute.buffers.size || automaticCompute.tensors.size) throw new Error('Automatic fp16 session retained resources.');
        inferenceContracts.push({ name: 'automatic intermediate-only fp16', shaderF16: true, remainingBuffers: 0, remainingTensors: 0 });
        const shared = createBrowserInferenceEngine({ float16: true });
        let sharedCompute;
        try {
          const models = await Promise.all([1, 2].map(() => shared.InferenceSession.create(contractModel)));
          sharedCompute = models[0].session.engine;
          if (sharedCompute !== models[1].session.engine || !sharedCompute.device.features.has('shader-f16')) throw new Error('Half models did not share one capable device.');
          for (let i = 0; i < models.length; i++) {
            const result = (await models[i].run({ x: contractInput })).y;
            try { compare(`shared fp16 session ${i + 1}`, result.data, expectedHalf, { absolute: 0, relative: 0 }); }
            finally { result.dispose(); }
          }
        } finally { await shared.dispose(); contractInput.dispose(); }
        if (sharedCompute.buffers.size || sharedCompute.tensors.size) throw new Error('Shared fp16 sessions retained resources.');
        inferenceContracts.push({ name: 'two shared fp16 sessions', oneDevice: true, remainingBuffers: 0, remainingTensors: 0 });
        const incapable = await WebGpuCompute.create();
        try {
          let refused = false;
          try { await InferenceSession.create(contractModel, { engine: incapable }); }
          catch (error) { refused = /fp16|shader-f16/.test(error.message); }
          incapable.checkOpen();
          if (!refused || incapable.cnn || incapable.buffers.size || incapable.tensors.size) throw new Error('Incapable caller-owned device was used or destroyed.');
          inferenceContracts.push({ name: 'incapable shared device', refusedBeforePreparation: true, callerDeviceRemainsOpen: true });
        } finally { await incapable.dispose(); }
        const uploadHalf = (data, shape) => engine.upload(Uint16Array.from(data, floatToHalf), shape, 'float16');
        const readHalf = async tensor => Float32Array.from(await engine.read(tensor), halfToFloat);
        const a = uploadHalf([1, -2, 3, 4, 5, -6], [2, 3]), b = uploadHalf([1, 2, 3, 4, 5, 6], [3, 2]);
        const scalar = uploadHalf([0.5], []), condition = engine.upload(Uint32Array.of(1, 0), [2, 1], 'bool');
        const batch = engine.batch(), product = batch.matmul(a, b), scaled = batch.binary('Mul', product, scalar);
        const selected = batch.where(condition, scaled, batch.unary('Neg', scaled));
        const mean = batch.reduce(selected, [-1], false), transposed = batch.index(a, { shape: [3, 2], strides: [1, 3], offset: 0 });
        const cast = batch.cast(mean, 1), expanded = batch.expand(scalar, [3, 5]), equal = batch.equal(product, product);
        const probabilities = batch.softmax(product), concat = batch.concat([a, a], 0);
        batch.submit({ retainParameters: true });
        compare('fp16 MatMul/broadcast/Where/reduce (odd half read/write)', await readHalf(mean), Float32Array.of(5.5, 4.75), { absolute: 0, relative: 0 });
        compare('fp16 transpose', await readHalf(transposed), Float32Array.of(1, 4, -2, 5, 3, -6), { absolute: 0, relative: 0 });
        compare('fp16 to fp32 Cast', await engine.read(cast), Float32Array.of(5.5, 4.75), { absolute: 0, relative: 0 });
        compare('fp16 scalar Expand', await readHalf(expanded), new Float32Array(15).fill(0.5), { absolute: 0, relative: 0 });
        compare('bool Equal', await engine.read(equal), Uint32Array.of(1, 1, 1, 1), { absolute: 0, relative: 0 });
        compare('fp16 Concat', await readHalf(concat), Float32Array.of(1, -2, 3, 4, 5, -6, 1, -2, 3, 4, 5, -6), { absolute: 0, relative: 0 });
        const softmaxInput = [10, 12, -11, -8];
        const expectedSoftmax = Float32Array.from(softmaxInput, (value, i) => {
          const row = softmaxInput.slice(Math.floor(i / 2) * 2, Math.floor(i / 2) * 2 + 2), maximum = Math.max(...row);
          return Math.exp(value - maximum) / row.reduce((sum, x) => sum + Math.exp(x - maximum), 0);
        });
        compare('fp16 Softmax', await readHalf(probabilities), expectedSoftmax, { absolute: .0005, relative: .001 });
        await engine.releaseMany([a, b, scalar, condition, ...batch.outputs], [...batch.scratchBuffers(), ...batch.parameters]);
        const generated = engine.batch(), filled = generated.fill([1027], -.375, 'float16'),
          integers = generated.range(7, -2, -2, 'int32'), fractional = generated.range(-.5, 1, .25, 'float32'),
          empty = generated.range(0, 1, -1, 'int32'), bits = generated.fill([2, 3], 1, 'bool'),
          largeInteger = generated.fill([3], 16777217, 'int32'), negative = generated.fill([3], -2147483648, 'int32');
        const greater = generated.compare('Greater', integers, generated.fill([], 2, 'int32')),
          greaterEqual = generated.compare('GreaterOrEqual', integers, generated.fill([], 3, 'int32')),
          less = generated.compare('Less', fractional, generated.fill([], 0, 'float32')),
          both = generated.compare('And', bits, generated.fill([1, 3], 0, 'bool'));
        const resizeInput = engine.upload(Float32Array.of(1, 3, 5), [1, 1, 3]);
        const resized = generated.resize(resizeInput, { scales: [1, 1, 2], mode: 'linear', coordinateMode: 'half_pixel' });
        const powers = engine.upload(Float32Array.of(-3, -.5, 0, .5, 3), [5]), exponent = engine.upload(Float32Array.of(3), []),
          cubed = generated.binary('Pow', powers, exponent);
        generated.submit({ retainParameters: true });
        compare('fp16 large ConstantOfShape', await readHalf(filled), new Float32Array(1027).fill(-.375), { absolute: 0, relative: 0 });
        compare('descending int32 Range', await engine.read(integers), Int32Array.of(7, 5, 3, 1, -1), { absolute: 0, relative: 0 });
        compare('fractional fp32 Range', await engine.read(fractional), Float32Array.of(-.5, -.25, 0, .25, .5, .75), { absolute: 0, relative: 0 });
        compare('empty Range', await engine.read(empty), new Int32Array(), { absolute: 0, relative: 0 });
        compare('large int32 fill preserves low bit', await engine.read(largeInteger), Int32Array.of(16777217, 16777217, 16777217), { absolute: 0, relative: 0 });
        compare('negative int32 fill preserves sign bit', await engine.read(negative), new Int32Array(3).fill(-2147483648), { absolute: 0, relative: 0 });
        compare('integer Greater', await engine.read(greater), Uint32Array.of(1, 1, 1, 0, 0), { absolute: 0, relative: 0 });
        compare('integer GreaterOrEqual', await engine.read(greaterEqual), Uint32Array.of(1, 1, 1, 0, 0), { absolute: 0, relative: 0 });
        compare('float Less', await engine.read(less), Uint32Array.of(1, 1, 0, 0, 0, 0), { absolute: 0, relative: 0 });
        compare('broadcast bool And', await engine.read(both), new Uint32Array(6), { absolute: 0, relative: 0 });
        compare('rank-three linear Resize', await engine.read(resized), Float32Array.of(1, 1.5, 2.5, 3.5, 4.5, 5), { absolute: 0, relative: 0 });
        compare('negative and positive exact cubic Pow', await engine.read(cubed), Float32Array.of(-27, -.125, 0, .125, 27), { absolute: 0, relative: 0 });
        await engine.releaseMany([resizeInput, powers, exponent, ...generated.outputs], [...generated.scratchBuffers(), ...generated.parameters]);
        const rowCount = Math.floor(device.limits.maxStorageBufferBindingSize / 8) + 1;
        const table = new Uint16Array(rowCount * 4);
        for (const row of [0, rowCount - 2, rowCount - 1]) for (let i = 0; i < 4; i++) table[row * 4 + i] = floatToHalf(row === 0 ? i : (row === rowCount - 2 ? 10 : 20) + i);
        const sharded = engine.uploadSharded(new Uint8Array(table.buffer), [rowCount, 4], 'float16');
        const indices = engine.uploadInt32(Int32Array.of(rowCount - 1, 0, -2), [3]);
        const gatherBatch = engine.batch(), gathered = gatherBatch.gatherTensor(sharded, indices); gatherBatch.submit({ retainParameters: true });
        compare('fp16 sharded embedding crosses default binding limit', await readHalf(gathered), Float32Array.of(20, 21, 22, 23, 0, 1, 2, 3, 10, 11, 12, 13), { absolute: 0, relative: 0 });
        await engine.releaseMany([indices, ...sharded.shards.map(shard => shard.tensor), ...gatherBatch.outputs], [...gatherBatch.scratchBuffers(), ...gatherBatch.parameters]);
        const indexData = engine.uploadInt32(Int32Array.of(0, 9), [2]), maskData = engine.uploadInt32(Int32Array.of(1, 0), [2]), tableData = uploadHalf([1, 2, 3], [3, 1]);
        const guarded = engine.batch({ capture: true });
        // Conservative bounds can include invalid values although this run is valid.
        const uncertain = guarded.binary('Mul', indexData, maskData);
        const checked = guarded.gatherTensor(tableData, uncertain); guarded.submit({ retainParameters: true });
        compare('checked Gather accepts valid dynamic indices', await readHalf(checked), Float32Array.of(1, 1), { absolute: 0, relative: 0 });
        engine.write(maskData, Int32Array.of(1, 1)); guarded.replay();
        let failed = false; try { await engine.read(checked); } catch (error) { failed = /Gather index/.test(error.message); }
        if (!failed) throw new Error('Out-of-range dynamic Gather was not rejected.');
        engine.write(indexData, Int32Array.of(2, 0)); guarded.replay();
        compare('checked Gather clears prior failure on replay', await readHalf(checked), Float32Array.of(3, 1), { absolute: 0, relative: 0 });
        await engine.releaseMany([indexData, maskData, tableData, ...guarded.outputs], [...guarded.scratchBuffers(), ...guarded.parameters]);
        const referenceModule = '/node_modules/onnxruntime-web-omnivoice/dist/ort.webgpu.bundle.min.mjs', fixtureModule = '/scripts/lib/onnx-debug-outputs.mjs';
        const [ort, { matmulFixture }] = await Promise.all([import(referenceModule), import(fixtureModule)]);
        ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/node_modules/onnxruntime-web-omnivoice/dist/`;
        const m = 4, k = 1024, n = 96, ab = Uint16Array.from({ length: m * k }, (_, i) => floatToHalf(Math.sin(i * .137))),
          bb = Uint16Array.from({ length: k * n }, (_, i) => floatToHalf(Math.cos(i * .173) * .1));
        const ad = Float32Array.from(ab, halfToFloat), bd = Float32Array.from(bb, halfToFloat), expected = new Float32Array(m * n);
        for (let row = 0; row < m; row++) for (let column = 0; column < n; column++) {
          let sum = 0; for (let inner = 0; inner < k; inner++) sum += ad[row * k + inner] * bd[inner * n + column];
          expected[row * n + column] = halfToFloat(floatToHalf(sum));
        }
        const ga = engine.upload(ab, [m, k], 'float16'), gb = engine.upload(bb, [k, n], 'float16'), own = engine.matmul(ga, gb);
        const ownData = await readHalf(own);
        compare('long fp16 MatMul against double-precision scalar then binary16 rounding', ownData, expected, { absolute: .0001, relative: .001 });
        const reference = await ort.InferenceSession.create(matmulFixture(10, [m, k], [k, n]), { executionProviders: ['webgpu'], graphOptimizationLevel: 'disabled' });
        try {
          const inputs = { a: new ort.Tensor('float16', ab, [m, k]), b: new ort.Tensor('float16', bb, [k, n]) };
          try {
            const result = (await reference.run(inputs)).y, raw = await result.getData(), ref = Float32Array.from(new Uint16Array(raw.buffer, raw.byteOffset, result.size), halfToFloat);
            const error = values => {
              let max = 0, square = 0; for (let i = 0; i < values.length; i++) { const diff = values[i] - expected[i]; max = Math.max(max, Math.abs(diff)); square += diff * diff; }
              return { maxAbsoluteError: max, rmse: Math.sqrt(square / values.length) };
            };
            precisionDiagnostics.push({ name: 'long fp16 MatMul, independent scalar reference', own: error(ownData), ort: error(ref) }); result.dispose();
          } finally { inputs.a.dispose(); inputs.b.dispose(); }
        } finally { await reference.release(); }
        await engine.releaseMany([ga, gb, own]);
      }
      for (const [m, n, k] of [[1, 1, 1], [3, 7, 5], [17, 19, 33], [32, 64, 16], [2, 5, 0], [0, 3, 8], [96, 128, 256]]) {
        const a = Float32Array.from({ length: m * k }, (_, i) => Math.sin(i * 0.37));
        const b = Float32Array.from({ length: k * n }, (_, i) => Math.cos(i * 0.19));
        const ga = engine.upload(a, [m, k]); const gb = engine.upload(b, [k, n]);
        const out = engine.matmul(ga, gb);
        compare(`MatMul ${m}x${n}x${k}`, await engine.read(out), cpu.matmul(a, [m, k], b, [k, n]).data,
          { absolute: 1e-4, relative: 1e-5 });
        await Promise.all([ga, gb, out].map(tensor => engine.release(tensor)));
      }
      for (const operation of Object.keys(UNARY_OPERATIONS)) {
        const data = Float32Array.from({ length: 257 }, (_, i) => operation === 'Sqrt' ? i / 32 : operation === 'Reciprocal' ? i / 32 + 0.25 : (i - 128) / 16);
        const input = engine.upload(data, [257]); const out = engine.unary(operation, input);
        compare(operation, await engine.read(out), cpu.unary(operation, data));
        await engine.release(input); await engine.release(out);
      }
      for (const operation of Object.keys(BINARY_OPERATIONS)) {
        const a = Float32Array.from({ length: 8 }, (_, i) => i / 4 - 1);
        const b = Float32Array.from({ length: 12 }, (_, i) => i / 8 + 0.25);
        const expected = new Float32Array(24);
        for (let batch = 0; batch < 2; batch += 1) for (let channel = 0; channel < 3; channel += 1) for (let x = 0; x < 4; x += 1) {
          const av = a[batch * 4 + x], bv = b[channel * 4 + x];
          expected[(batch * 3 + channel) * 4 + x] = operation === 'Add' ? av + bv : operation === 'Mul' ? av * bv : operation === 'Div' ? av / bv : av - bv;
        }
        const ga = engine.upload(a, [2, 1, 4]), gb = engine.upload(b, [3, 4]);
        const out = engine.binary(operation, ga, gb);
        compare(`${operation} broadcast`, await engine.read(out), expected);
        await Promise.all([ga, gb, out].map(tensor => engine.release(tensor)));
      }
      for (const spec of [
        { channels: 3, outputs: 5, width: 19, kernel: 7, stride: 2, dilation: 3, pads: [5, 2], group: 1 },
        { channels: 4, outputs: 6, width: 11, kernel: 3, stride: 1, dilation: 2, pads: [1, 3], group: 2 },
        { channels: 33, outputs: 35, width: 37, kernel: 1, stride: 1, dilation: 1, pads: [0, 0], group: 1 },
        { channels: 3, outputs: 5, width: 7, kernel: 5, stride: 3, dilation: 1, pads: [2, 1], group: 1, transpose: true, extra: 1 },
        { channels: 4, outputs: 6, width: 9, kernel: 2, stride: 4, dilation: 1, pads: [1, 0], group: 2, transpose: true },
        { channels: 3, outputs: 5, width: 9, kernel: 3, stride: 2, dilation: 2, pads: [0, 2], group: 1, transpose: true },
      ]) {
        const { channels: c, outputs: o, width: w, kernel: k, stride: s, dilation: d, pads: p, group: g, transpose: t, extra = 0 } = spec;
        const width = t ? (w - 1) * s - p[0] - p[1] + d * (k - 1) + 1 + extra : Math.floor((w + p[0] + p[1] - d * (k - 1) - 1) / s) + 1;
        const input = Float32Array.from({ length: 2 * c * w }, (_, i) => Math.sin(i * .17));
        const weights = Float32Array.from({ length: o * c / g * k }, (_, i) => Math.cos(i * .09) * .1), bias = Float32Array.from({ length: o }, (_, i) => i * .02);
        const expected = new Float32Array(2 * o * width);
        for (let n = 0; n < 2; n++) for (let oc = 0; oc < o; oc++) for (let pixel = 0; pixel < width; pixel++) {
          let sum = bias[oc]; const group = Math.floor(oc / (o / g));
          for (let ci = 0; ci < c / g; ci++) for (let tap = 0; tap < k; tap++) {
            const source = t ? (pixel + p[0] - tap * d) / s : pixel * s + tap * d - p[0];
            if (!Number.isInteger(source) || source < 0 || source >= w) continue;
            const wi = t ? ((group * (c / g) + ci) * (o / g) + oc % (o / g)) * k + tap : (oc * (c / g) + ci) * k + tap;
            sum += input[(n * c + group * (c / g) + ci) * w + source] * weights[wi];
          }
          expected[(n * o + oc) * width + pixel] = sum;
        }
        const x = engine.upload(input, [2, c, w]), weight = engine.upload(weights, t ? [c, o / g, k] : [o, c / g, k]), b = engine.upload(bias, [o]);
        const batch = engine.batch(), result = batch.convolution(x, weight, b, { strides: [s], dilations: [d], pads: p, group: g, transpose: t, outputPadding: [extra] });
        batch.submit(); compare(`1-D ${t ? 'ConvTranspose' : 'Conv'} ${JSON.stringify(spec)}`, await engine.read(result), expected, { absolute: 1e-4 });
        await engine.releaseMany([x, weight, b, ...batch.outputs], batch.scratchBuffers());
      }
      {
        const input = engine.uploadInt32(Int32Array.of(5, -2, 7, 0), [2, 2]);
        const offsets = engine.uploadInt32(Int32Array.of(10, 20), [2, 1]);
        const table = engine.upload(Float32Array.from({ length: 64 }, (_, i) => i * .5), [32, 2]);
        const batch = engine.batch(), transposed = batch.index(input, { shape: [2, 2], strides: [1, 2], offset: 0 });
        const indices = batch.binary('Add', transposed, offsets), gathered = batch.gatherTensor(table, indices);
        batch.submit(); compare('integer transpose/broadcast-add/dynamic gather', await engine.read(gathered), Float32Array.of(15, 15.5, 17, 17.5, 18, 18.5, 20, 20.5), { absolute: 0, relative: 0 });
        await engine.releaseMany([input, offsets, table, ...batch.outputs], batch.scratchBuffers());
      }
      {
        const source = engine.upload(Float32Array.of(1, -2, 3, -4, 5, 6), [6]);
        const batch = engine.batch(), positive = batch.unary('Relu', source), view = batch.view(positive, [2, 3]);
        batch.recycle(positive);
        batch.unary('Neg', source); // Must not recycle storage still used by the view.
        const borrowed = batch.view(source, [3, 2]); batch.submit();
        await engine.release(source);
        compare('owned reshape alias survives producer recycle', await engine.read(view), Float32Array.of(1, 0, 3, 0, 5, 6));
        compare('borrowed reshape alias survives source release', await engine.read(borrowed), Float32Array.of(1, -2, 3, -4, 5, 6));
        await engine.releaseMany([...batch.outputs], batch.scratchBuffers());
      }
      const a = engine.upload(Float32Array.of(1, -2, 3, 4, 5, -6), [2, 3]);
      const b = engine.upload(Float32Array.of(1, 2, 3, 4, 5, 6), [3, 2]);
      const scale = engine.upload(Float32Array.of(2), []);
      const batch = engine.batch();
      const product = batch.matmul(a, b); const activated = batch.unary('Relu', product); const out = batch.binary('Mul', activated, scale);
      let rejected = false;
      try { await engine.read(out); } catch { rejected = true; }
      if (!rejected) throw new Error('Unsubmitted command batch was readable.');
      batch.submit();
      compare('GPU-resident MatMul/Relu/scalar-Mul batch', await engine.read(out), Float32Array.of(20, 24, 0, 0));
      const pendingRead = engine.read(out);
      const disposal = engine.dispose();
      compare('read completes during disposal', await pendingRead, Float32Array.of(20, 24, 0, 0));
      await disposal; await engine.dispose();
      if (engine.buffers.size || engine.tensors.size) throw new Error('Engine resources remain after disposal.');
      if (validationErrors.length) throw new Error(validationErrors.join('\n'));
      return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description },
      cases, precisionDiagnostics, inferenceContracts, resourceCleanup: true, validationErrors, timingAcceptance: 'not measured; parity verification only' };
    } finally { await engine.dispose(); device.destroy(); }
  }, precision);
  if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
  verifyBrowserAdapter(result.adapter, adapterConfiguration);
  result.implementationPins = implementationPins;
  result.sourcesUnchanged = JSON.stringify(implementationPins) === JSON.stringify(await pins());
  result.browserVersion = browser.version(); result.browserArguments = adapterConfiguration.args;
  if (!result.sourcesUnchanged) throw new Error('Engine sources changed during verification.');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Verified ${result.cases.length} native WebGPU/C++ parity cases; resources released. ${JSON.stringify(result.adapter)}`);
  console.log(output);
} catch (error) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ status: 'fail', failure: String(error.stack || error),
    implementationPins, sourcesUnchanged: JSON.stringify(implementationPins) === JSON.stringify(await pins()),
    browserArguments: adapterConfiguration.args, browserVersion: browser?.version() }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
