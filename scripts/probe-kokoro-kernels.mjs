// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const adapterConfiguration = browserAdapterConfiguration(), outputIndex = process.argv.indexOf('--output');
const output = resolve(root, outputIndex < 0 ? `artifacts/engines/kokoro-kernels-parity${adapterConfiguration.suffix}.json` : process.argv[outputIndex + 1]);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Kokoro independent kernel verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(`${root}${sep}`) || !['.js', '.mjs'].includes(extname(path))) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: adapterConfiguration.args });
  const page = await browser.newPage(); page.setDefaultTimeout(180_000);
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const moduleRoot = new URL('/src/engines/', location.href).href;
    const { WebGpuCompute } = await import(`${moduleRoot}webgpu-compute.js`);
    const { createKokoroKernels } = await import(`${moduleRoot}kokoro-kernels.js`);
    const { referenceLstm, referenceLayerNormalization, referenceStft } = await import(`${moduleRoot}kokoro-kernels-shape.js`);
    const { referenceCumulativeSum, referenceScatterNd, referenceKokoroUnary } = await import(`${moduleRoot}kokoro-kernels-duration.js`);
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable.');
    const device = await adapter.requestDevice(), engine = await WebGpuCompute.create({ device });
    const cases = [], validationErrors = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    function compare(name, actual, expected, absolute = 1e-5, relative = 2e-5) {
      if (actual.length !== expected.length) throw new Error(`${name}: output length differs.`);
      let maximum = 0;
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - expected[i]);
        if (!Number.isFinite(error) || error > absolute + relative * Math.abs(expected[i])) throw new Error(`${name}[${i}] GPU=${actual[i]} reference=${expected[i]}`);
        maximum = Math.max(maximum, error);
      }
      cases.push({ name, elements: actual.length, maximumAbsoluteError: maximum, absolute, relative });
    }
    const upload = (data, shape) => engine.upload(data, shape);
    const release = (batch, tensors) => engine.releaseMany([...tensors, ...batch.outputs], batch.scratchBuffers());
    let status = 'pass', error = null;
    try {
      await engine.prepareCnn();
      const kernels = await createKokoroKernels(engine);
      {
        const values = Float32Array.from([-0, 0, -1e-9, 1e-9, -1e-7, 1e-7,
          ...Array.from({ length: 257 }, (_, i) => (i - 128) / 1024)]);
        const input = upload(values, [values.length]), batch = engine.batch(), out = batch.unary('Tanh', input);
        batch.submit(); const actual = await engine.read(out);
        compare('Small Tanh activations', actual, Float32Array.from(values, Math.tanh), 0, 1e-6);
        if (!Object.is(actual[0], -0)) throw new Error('Tanh lost negative zero.');
        await release(batch, [input]);
      }
      {
        const inputs = [upload(Float32Array.of(1 + 2 ** -23, -1), [1, 2]), upload(Float32Array.of(1 - 2 ** -24, 1), [2])];
        const batch = engine.batch(), out = kernels.stft(batch, ...inputs, { frameLength: 2, frameStep: 1 });
        batch.submit(); compare('Float32 STFT window cancellation', await engine.read(out), [0, 0, 2, 0], 0, 0);
        await release(batch, inputs);
      }
      {
        const real = Float32Array.of(-1, -1, 1, 1, -1, -1, -1, -1, 0, 0), imaginary = Float32Array.of(0, -0, 0, -0, 1e-7, -1e-7, 1, -1, 1, -1);
        const raw = Float32Array.from(real, (x, i) => x < 0 ? Math.atan(imaginary[i] / x) + (imaginary[i] > 0 ? Math.PI : -Math.PI) : Math.atan(imaginary[i] / x));
        const inputs = [upload(real, [real.length]), upload(imaginary, [real.length]), upload(raw, [real.length]), upload(Float32Array.of(0), []), upload(Float32Array.of(Math.PI), [])];
        const batch = engine.batch(), negative = batch.compare('Less', inputs[0], inputs[3]), zero = batch.compare('Equal', inputs[1], inputs[3]);
        const mask = batch.compare('And', zero, negative), out = batch.where(mask, inputs[4], inputs[2]); batch.submit();
        const actual = await engine.read(out), expected = Float32Array.from(real, (x, i) => imaginary[i] === 0 && x < 0 ? Math.PI : Math.atan2(imaginary[i], x));
        compare('Exact-zero model phase correction (both zero signs; nonzero quadrants unchanged)', actual, expected, 0, 0);
        if (!Object.is(actual[3], -0)) throw new Error('Uncorrected positive-real negative-zero phase was not bit-preserved.');
        await release(batch, inputs);
      }
      for (const [rows, width] of [[2, 3], [3, 65], [2, 128], [2, 512]]) {
        const values = Float32Array.from({ length: rows * width }, (_, i) => Math.sin(i * .31) + 2);
        const scale = Float32Array.from({ length: width }, (_, i) => 1 + i * .001), bias = new Float32Array(width).fill(.125);
        const inputs = [upload(values, [rows, width]), upload(scale, [width]), upload(bias, [width])];
        const batch = engine.batch(), out = kernels.layerNormalization(batch, ...inputs, { epsilon: 1e-12 }); batch.submit();
        compare(`LayerNormalization ${rows}x${width}`, await engine.read(out), referenceLayerNormalization(values, [rows, width], scale, bias, { epsilon: 1e-12 }));
        await release(batch, inputs);
      }
      for (const spec of [{ t: 3, b: 2, i: 4, h: 2, direction: 'bidirectional' }, { t: 7, b: 1, i: 5, h: 3, direction: 'forward' },
        { t: 4, b: 2, i: 3, h: 4, direction: 'reverse' }, { t: 3, b: 1, i: 640, h: 256, direction: 'bidirectional' }, { t: 0, b: 1, i: 4, h: 2, direction: 'bidirectional' }]) {
        const { t, b, i, h, direction } = spec, d = direction === 'bidirectional' ? 2 : 1;
        const shapes = [[t, b, i], [d, h * 4, i], [d, h * 4, h], [d, h * 8], [d, b, h], [d, b, h]];
        const values = shapes.map((shape, index) => Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, n) => Math.sin(n * .07 + index) * (index === 1 || index === 2 ? .02 : .1)));
        const inputs = values.map((data, index) => upload(data, shapes[index]));
        const batch = engine.batch(), out = kernels.lstm(batch, ...inputs, { hiddenSize: h, direction }); batch.submit();
        const reference = referenceLstm(...values, shapes[0], { hiddenSize: h, direction });
        for (let k = 0; k < 3; k++) compare(`LSTM ${JSON.stringify(spec)} output${k}`, await engine.read(out[k]), reference[k], 2e-5, 2e-4);
        await release(batch, inputs);
      }
      {
        // Finite actual-model GELU magnitudes also exercise both explicit recurrent tanh sites.
        // Zero i/o/f projections give sigmoid=1/2. Large +/-c0 and +/-candidate gates
        // therefore have exact expected h=+/-1/2 and c=+/-[150.5,75.75,38.375].
        const values = [Float32Array.of(124.00637817382812, -124.00637817382812, 89.10293579101562, -89.10293579101562, 124, -124),
          Float32Array.of(0, 0, 0, 1), new Float32Array(4), new Float32Array(8), new Float32Array(2), Float32Array.of(300, -300)];
        const shapes = [[3, 2, 1], [1, 4, 1], [1, 4, 1], [1, 8], [1, 2, 1], [1, 2, 1]];
        const inputs = values.map((data, index) => upload(data, shapes[index]));
        const batch = engine.batch(), out = kernels.lstm(batch, ...inputs, { hiddenSize: 1, direction: 'forward' }); batch.submit();
        compare('LSTM finite extreme candidate and cell tanh: sequence', await engine.read(out[0]), Float32Array.of(.5, -.5, .5, -.5, .5, -.5), 0, 0);
        compare('LSTM finite extreme candidate and cell tanh: hidden', await engine.read(out[1]), Float32Array.of(.5, -.5), 0, 0);
        compare('LSTM finite extreme candidate and cell tanh: cell', await engine.read(out[2]), Float32Array.of(38.375, -38.375), 0, 0);
        await release(batch, inputs);
      }
      {
        const shape = [2, 35], values = Float32Array.from({ length: 70 }, (_, i) => Math.sin(i * .13));
        const window = Float32Array.from({ length: 20 }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / 20));
        const inputs = [upload(values, shape), upload(window, [20])];
        const batch = engine.batch(), options = { frameLength: 20, frameStep: 5 }, out = kernels.stft(batch, ...inputs, options); batch.submit();
        const spectrum = await engine.read(out);
        compare('STFT real Hann20 hop5 batch2', spectrum, referenceStft(values, shape, window, options), 1e-4);
        for (let frame = 0; frame < 8; frame++) for (const bin of [0, 10]) if (spectrum[(frame * 11 + bin) * 2 + 1] !== 0) throw new Error('Real STFT DC/Nyquist imaginary residue changes atan2 quadrant.');
        await release(batch, inputs);
      }
      for (const [shape, axis, integer] of [[[1025], 0, true], [[2, 1025, 3], 1, false], [[3, 2], 0, false], [[1, 0, 9], 1, false]]) {
        const size = shape.reduce((a, b) => a * b, 1), values = integer ? Int32Array.from({ length: size }, (_, i) => i % 7) : Float32Array.from({ length: size }, (_, i) => Math.sin(i * .03));
        const input = integer ? engine.uploadInt32(values, shape) : upload(values, shape);
        const batch = engine.batch(), out = kernels.cumsum(batch, input, axis); batch.submit();
        compare(`CumSum ${shape} axis${axis} ${integer ? 'integer' : 'float'}`, await engine.read(out), referenceCumulativeSum(values, shape, axis), integer ? 0 : .001, integer ? 0 : 2e-5);
        await release(batch, [input]);
      }
      {
        const data = Float32Array.from({ length: 24 }, (_, i) => i), updates = Float32Array.of(-4, 77), indices = [0, 1, 1, 10];
        const inputs = [upload(data, [2, 12]), upload(updates, [2])];
        const batch = engine.batch(), out = kernels.scatterNd(batch, inputs[0], indices, [2, 2], inputs[1]); batch.submit();
        compare('ScatterND bounded sample correction', await engine.read(out), referenceScatterNd(data, [2, 12], indices, [2, 2], updates, [2]), 0, 0);
        await release(batch, inputs);
      }
      for (const operation of ['Round', 'Floor', 'Atan', 'LeakyRelu', 'Clip']) {
        const values = Float32Array.of(-2.5, -1.5, -.5, .5, 1.5, 2.5, 3.5, -.3, .3, 0), options = { alpha: .2, min: -1, max: 1 };
        const input = upload(values, [values.length]), batch = engine.batch(), out = kernels.unary(batch, input, operation, options); batch.submit();
        const actual = await engine.read(out), expected = referenceKokoroUnary(values, operation, options);
        compare(operation, actual, expected);
        if (operation === 'Round' && !Object.is(actual[2], -0)) throw new Error('Round failed negative-zero preservation.');
        await release(batch, [input]);
      }
      if (validationErrors.length) throw new Error(validationErrors.join('\n'));
    } catch (failure) { status = 'fail'; error = failure.message; }
    finally { await engine.dispose(); device.destroy(); }
    return { status, error, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description },
      cases, validationErrors, resourceCleanup: engine.buffers.size === 0 && engine.tensors.size === 0, timingAcceptance: 'not measured; kernel numerical and lifecycle checks only' };
  });
  result.consoleErrors = consoleErrors;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  verifyBrowserAdapter(result.adapter, adapterConfiguration);
  if (result.status !== 'pass' || consoleErrors.length || !result.resourceCleanup) throw new Error(result.error || consoleErrors.join('\n') || 'Resource cleanup failed.');
  console.log(`Verified ${result.cases.length} own Kokoro WebGPU numerical cases; resources released. ${JSON.stringify(result.adapter)}`);
  console.log(output);
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
