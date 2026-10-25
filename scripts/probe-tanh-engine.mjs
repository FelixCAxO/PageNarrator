// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Actual failing model operands and independent Math.tanh, on a physical GPU.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';
import { engineSourcePins } from './lib/engine-source-pins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), configuration = browserAdapterConfiguration();
const fixture = 'tests/fixtures/engines/kokoro-intel-tanh-activation';
const metadata = JSON.parse(await readFile(resolve(root, `${fixture}.json`)));
const input = await readFile(resolve(root, `${fixture}.f32`));
if (input.length !== metadata.bytes || createHash('sha256').update(input).digest('hex') !== metadata.sha256) throw new Error('The frozen actual Tanh operands changed.');
const sourceFiles = ['scripts/probe-tanh-engine.mjs', 'scripts/lib/browser-adapter.mjs', 'scripts/lib/engine-source-pins.mjs',
  'scripts/lib/binary16-oracle.mjs', `${fixture}.json`, `${fixture}.f32`];
const pins = () => engineSourcePins(root, sourceFiles), sourcePins = await pins();
const output = resolve(root, `artifacts/engines/tanh-actual-operands${configuration.suffix}-${Date.now()}.json`);
const report = { status: 'incomplete', scope: 'Original GPU Tanh against independent binary64 Math.tanh rounded to the output type. Actual model operands and signed-zero/extreme controls; not full-model acceptance.',
  sourcePins, fixture: metadata, browserArguments: configuration.args };
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original Tanh numerical control</title>'); return; }
    if (name === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = resolve(root, `.${name}`);
    if (!file.startsWith(`${resolve(root)}${sep}`) || !(name.startsWith('/src/engines/')
      || name === '/scripts/lib/binary16-oracle.mjs' || name === `/${fixture}.f32`)) throw new Error('Unexpected probe resource.');
    response.writeHead(200, { 'Content-Type': ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: configuration.args });
  report.browserVersion = browser.version();
  const page = await browser.newPage(), pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  Object.assign(report, await page.evaluate(async ({ fixture, expectedSha256, tolerance }) => {
    const modules = new URL('/src/engines/', location.href).href, helpers = new URL('/scripts/lib/', location.href).href;
    const [{ WebGpuCompute }, { ELEMENTWISE_SHADER }, { halfStorageShader }, { floatToHalf, halfToFloat }, { binary64ToHalf }] = await Promise.all([
      import(`${modules}webgpu-compute.js`), import(`${modules}webgpu-shaders.js`), import(`${modules}webgpu-precision-shaders.js`),
      import(`${modules}tensor-format.js`), import(`${helpers}binary16-oracle.mjs`),
    ]);
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter?.features.has('shader-f16')) throw new Error('A physical fp16-capable adapter is required for both precision controls.');
    const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] }), validationErrors = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    const engine = await WebGpuCompute.create({ device, float16: true }), cases = [];
    try {
      await engine.prepareCnn();
      const bytes = await (await fetch(`/${fixture}.f32`)).arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== expectedSha256) throw new Error('Browser actual operands differ from the frozen source.');
      const extremes = Float32Array.of(-3.4028234663852886e38, -1000, -124.00637817382812, -89.10293579101562, -10.000001, -10, -9.999999,
        -3, -0.125, -1e-10, -0, 0, 1e-10, .125, 3, 9.999999, 10, 10.000001, 89.10293579101562, 124.00637817382812, 1000, 3.4028234663852886e38);
      const fixedExpression = 'result = pn_tanh(x);';
      if (ELEMENTWISE_SHADER.split(fixedExpression).length !== 2) throw new Error('The legacy Tanh control must replace exactly one bounded expression.');
      const legacyCode = ELEMENTWISE_SHADER.replace(fixedExpression, 'result = tanh(x);');
      for (const type of ['float32', 'float16']) {
        const fixedPipeline = type === 'float32' ? engine.elementwisePipeline : engine.half.elementwise;
        const legacyPipeline = await engine.pipeline(type === 'float32' ? legacyCode : halfStorageShader(legacyCode), 'Unbounded Tanh diagnostic control');
        for (const [name, values] of [['actual-model-activation', new Float32Array(bytes)], ['finite-extremes-and-signed-zero', extremes]]) {
          const source = type === 'float32' ? values : Uint16Array.from(values, value => floatToHalf(Math.max(-65504, Math.min(65504, value))));
          const numbers = type === 'float32' ? source : Float32Array.from(source, halfToFloat);
          const expected = Float32Array.from(numbers, value => type === 'float32' ? Math.fround(Math.tanh(value)) : halfToFloat(binary64ToHalf(Math.tanh(value))));
          const result = { name, type, elements: values.length, tolerance: type === 'float32' ? tolerance.float32Absolute : tolerance.float16Absolute };
          for (const [implementation, pipeline] of [['legacy', legacyPipeline], ['bounded', fixedPipeline]]) {
            if (type === 'float32') engine.elementwisePipeline = pipeline; else engine.half.elementwise = pipeline;
            const input = engine.upload(source, [source.length], type), batch = engine.batch(), tensor = batch.unary('Tanh', input);
            batch.submit({ retainParameters: true });
            try {
              const raw = await engine.read(tensor), actual = type === 'float32' ? raw : Float32Array.from(raw, halfToFloat);
              let maximumAbsoluteError = 0, mismatches = 0, nonfinite = 0, signedZeroMismatches = 0;
              for (let i = 0; i < actual.length; i++) {
                if (!Number.isFinite(actual[i])) { nonfinite++; mismatches++; continue; }
                const error = Math.abs(actual[i] - expected[i]); maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
                if (error > result.tolerance) mismatches++;
                if (numbers[i] === 0 && !Object.is(numbers[i], actual[i])) signedZeroMismatches++;
              }
              result[implementation] = { maximumAbsoluteError, mismatches, nonfinite, signedZeroMismatches };
            } finally { await engine.releaseMany([input, ...batch.outputs], [...batch.scratchBuffers(), ...batch.parameters]); }
          }
          if (type === 'float32') engine.elementwisePipeline = fixedPipeline; else engine.half.elementwise = fixedPipeline;
          result.passed = !result.bounded.mismatches && !result.bounded.signedZeroMismatches;
          cases.push(result);
        }
      }
      return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }, cases, validationErrors };
    } finally {
      await engine.dispose();
      globalThis.probeCleanup = { remainingBuffers: engine.buffers.size, remainingTensors: engine.tensors.size,
        completionError: engine.completionError?.message || null,
        unexpectedDeviceLoss: engine.lost ? { reason: engine.lost.reason, message: engine.lost.message } : null };
      device.destroy();
    }
  }, { fixture, expectedSha256: metadata.sha256, tolerance: metadata.tolerance }));
  report.cleanup = await page.evaluate(() => globalThis.probeCleanup);
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  verifyBrowserAdapter(report.adapter, configuration);
  report.sourcesUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await pins());
  report.status = report.cases.every(value => value.passed) && !report.validationErrors.length && !pageErrors.length && !consoleErrors.length
    && !report.cleanup.remainingBuffers && !report.cleanup.remainingTensors && !report.cleanup.completionError
    && !report.cleanup.unexpectedDeviceLoss && report.sourcesUnchanged ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = error.stack || String(error); }
finally {
  await browser?.close(); await new Promise(done => server.close(done));
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, output, cases: report.cases, error: report.error }, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
