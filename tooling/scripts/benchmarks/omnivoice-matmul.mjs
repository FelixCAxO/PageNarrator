// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// See docs/benchmarks/omnivoice.md for the separate full-synthesis adoption gate.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserAdapterConfiguration, verifyBrowserAdapter } from '../lib/browser-adapter.mjs';
import { engineSourcePins } from '../lib/engine-source-pins.mjs';
import { acquireMeasurementLock } from '../weak-hardware/measurement-lock.mjs';
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url))), config = browserAdapterConfiguration();
const outputArgument = process.argv.find(arg => arg.startsWith('--output='));
assert(process.argv.slice(2).every(arg => arg.startsWith('--output=')), 'Usage: node tooling/scripts/benchmarks/omnivoice-matmul.mjs [--output=<new-report.json>]');
const output = resolve(root, outputArgument?.slice(9) || `artifacts/engines/omnivoice-matmul${config.suffix}-${Date.now()}.json`);
const pins = () => engineSourcePins(root, ['tooling/scripts/benchmarks/omnivoice-matmul.mjs']);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.end('<!doctype html><title>OmniVoice MatMul exact A/B</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = resolve(root, `.${pathname}`);
    assert(pathname.startsWith('/src/engines/') && pathname.endsWith('.js') && file.startsWith(`${root}${sep}`));
    response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
const lock = await acquireMeasurementLock({ owner: { purpose: 'Exact OmniVoice MatMul kernel A/B' } });
let browser;
try {
  const implementationPins = await pins();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--mute-audio', ...config.args] });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { WebGpuCompute } = await import('/src/engines/webgpu-compute.js');
    const { floatToHalf } = await import('/src/engines/tensor-format.js');
    const { batchedMatmulPlan } = await import('/src/engines/index-shape.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const adapter = await navigator.gpu.requestAdapter();
    check(adapter?.features.has('shader-f16') && adapter.features.has('timestamp-query'), 'MatMul diagnostic requires shader-f16 and timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16', 'timestamp-query'] });
    const errors = []; device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const engine = await WebGpuCompute.create({ device }); await engine.prepareCnn();
    const query = device.createQuerySet({ type: 'timestamp', count: 8 });
    const resolved = device.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const mapped = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const rows = [];
    const allFinite = Uint16Array.from({ length: 65536 }, (_, i) => i).filter(bits => (bits & 0x7c00) !== 0x7c00);
    let seed = 42;
    const random = (count, scale) => Uint16Array.from({ length: count }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return floatToHalf((seed / 4294967296 * 2 - 1) * scale);
    });
    const timingSample = (values, order, repeats) => {
      const sample = { a: 0, b: 0, repeatsPerBlock: repeats, order, blocksNs: [] };
      for (let block = 0; block < order.length; block++) {
        const ns = Number(values[block * 2 + 1] - values[block * 2]);
        sample.blocksNs.push(ns); sample[order[block]] += ns / (2 * repeats);
      }
      sample.validIntervals = sample.blocksNs.every(ns => Number.isFinite(ns) && ns > 0);
      if (!sample.validIntervals) sample.a = sample.b = null;
      return sample;
    };
    const known = timingSample([0n, 10n, 20n, 40n, 50n, 90n, 100n, 130n], ['a', 'b', 'b', 'a'], 2);
    check(known.validIntervals && known.a === 10 && known.b === 15, 'Interleaved timing attribution changed');
    for (const end of [20n, 19n]) {
      const invalid = timingSample([0n, 10n, 20n, end, 50n, 90n, 100n, 130n], ['a', 'b', 'b', 'a'], 2);
      check(!invalid.validIntervals && invalid.a === null && invalid.b === null, 'Invalid interval produced a usable timing');
    }
    const repeatCount = (ns, fallback) => Number.isFinite(ns) && ns > 0 ? Math.max(1, Math.min(4096, Math.ceil(32e6 / ns))) : fallback;
    for (const [ns, expected] of [[0, 64], [NaN, 64], [1, 4096], [16e6, 2]]) check(repeatCount(ns, 64) === expected, 'Invalid adaptive timing repeat count');
    const calibratedRepeats = (estimate, wallMs, fallback) => {
      const repeatCap = Math.max(1, Math.min(4096, Math.floor(100 / Math.max(0.01, wallMs))));
      return Math.min(repeatCount(estimate, Math.min(fallback, repeatCap)), repeatCap);
    };
    for (const [estimate, wallMs, expected] of [[0, 1, 64], [1, 1, 100], [100000, 1, 100], [100000, 1000, 1], [NaN, 100, 1], [1e9, 0.01, 1]]) {
      check(calibratedRepeats(estimate, wallMs, 64) === expected, 'Unsafe calibrated timing repeat count');
    }
    const time = async batch => {
      const started = performance.now();
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
      for(let warm=0;warm<64;warm++) for (const command of batch.commands) {
        pass.setPipeline(command.pipeline); pass.setBindGroup(0, command.group); pass.dispatchWorkgroups(command.x, command.y, command.z);
      }
      pass.end(); encoder.resolveQuerySet(query, 0, 2, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, mapped, 0, 16); device.queue.submit([encoder.finish()]);
      await mapped.mapAsync(GPUMapMode.READ); const values = new BigUint64Array(mapped.getMappedRange()), ns = Number(values[1] - values[0]); mapped.unmap();
      return { ns:ns/64, wallMs:(performance.now() - started)/64, calibrationReplays:64 };
    };
    const pairedTimes = async (a, b, repeats = 64) => {
      const calibration = [await time(a), await time(b)];
      const calibrationWallMs = Math.max(...calibration.map(sample => sample.wallMs));
      const blockRepeats = calibratedRepeats(Math.max(...calibration.map(sample => sample.ns)), calibrationWallMs, repeats);
      const paired = async batches => {
        const samples = [];
        for (let pair = 0; pair < 5; pair++) {
          const order = pair % 2 ? ['b', 'a', 'a', 'b'] : ['a', 'b', 'b', 'a'], encoder = device.createCommandEncoder();
          for (let block = 0; block < order.length; block++) {
            const pass = encoder.beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: block * 2, endOfPassWriteIndex: block * 2 + 1 } });
            for (let repeat = 0; repeat < blockRepeats; repeat++) for (const command of batches[order[block]].commands) {
              pass.setPipeline(command.pipeline); pass.setBindGroup(0, command.group); pass.dispatchWorkgroups(command.x, command.y, command.z);
            }
            pass.end();
          }
          encoder.resolveQuerySet(query, 0, 8, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, mapped, 0, 64); device.queue.submit([encoder.finish()]);
          await mapped.mapAsync(GPUMapMode.READ);
          const sample = timingSample(new BigUint64Array(mapped.getMappedRange()), order, blockRepeats);
          mapped.unmap();
          samples.push(sample);
        }
        return samples;
      };
      const controlSamples = await paired({ a, b: a }), samples = await paired({ a, b });
      const validIntervals = [...controlSamples, ...samples].every(s => s.validIntervals);
      const controlMedianRatio = validIntervals ? controlSamples.map(s => s.b / s.a).sort((x, y) => x - y)[2] : null;
      return { samples, controlSamples, controlMedianRatio, calibration, calibrationWallMs, blockRepeats, timingControlPassed: validIntervals && Math.abs(controlMedianRatio - 1) <= 0.05 };
    };
    try {
      for (const [id, aShape, bShape] of [
        ['up-en', [1,289,1024], [1024,3072]],
        ['down-en', [1,289,3072], [3072,1024]],
        ['up-sv', [1,227,1024], [1024,3072]],
        ['short-rows', [1,45,1024], [1024,3072]],
        ['inner-tail-258', [33,258], [258,130]],
        ['inner-tail-272', [33,272], [272,130]],
        ['inner-tail-274', [33,274], [274,130]],
        ['heldout-square', [1,256,1024], [1024,4096]],
        ['heldout-wide', [1,512,2048], [2048,2048]],
        ['square-tail', [193,1026], [1026,3074]],
        ['wide-boundary', [191,1024], [1024,3072]],
        ['q-sv', [1,227,1024], [1024,2048]],
        ['threshold', [128,1024], [1024,1024]],
        ['even-tail', [129,1026], [1026,2050]],
        ['broadcast', [2,1,129,1024], [1,3,1024,2050]],
        ['finite-bits', [192,1024], [1024,3072]],
        ['cancellation-overflow', [129,1024], [1024,2048]],
        ['small-fallback', [127,1024], [1024,1024]],
        ['odd-inner-fallback', [129,1025], [1025,1024]],
        ['odd-output-fallback', [129,1024], [1024,1025]],
        ['short-45-1024-1024',[1,45,1024],[1024,1024]],
        ['short-45-1024-2048',[1,45,1024],[1024,2048]],
        ['short-45-1024-3072',[1,45,1024],[1024,3072]],
        ['short-45-2048-1024',[1,45,2048],[2048,1024]],
        ['short-45-3072-1024',[1,45,3072],[3072,1024]],
        ['short-55-1024-1024',[1,55,1024],[1024,1024]],
        ['short-55-1024-2048',[1,55,1024],[1024,2048]],
        ['short-55-1024-3072',[1,55,1024],[1024,3072]],
        ['short-55-2048-1024',[1,55,2048],[2048,1024]],
        ['short-55-3072-1024',[1,55,3072],[3072,1024]],
        ['short-heldout-budget',[64,1024],[1024,3072]],
        ['short-heldout-tall',[1024,1024],[1024,128]],
        ['short-heldout-even-tail',[47,1026],[1026,2050]],
        ['budget-above',[129,1024],[1024,1024]],
      ]) {
        const size = shape => shape.reduce((a, b) => a * b, 1), plan = batchedMatmulPlan(aShape, bShape);
        const inputData = id === 'finite-bits' ? Uint16Array.from({length:size(aShape)},(_,i)=>allFinite[i%allFinite.length])
          : id === 'cancellation-overflow' ? Uint16Array.from({length:size(aShape)},(_,i)=>floatToHalf(i%2?65504:-65504)) : random(size(aShape),1.73);
        const weightData = id === 'finite-bits' ? Uint16Array.from({length:size(bShape)},(_,i)=>floatToHalf(Math.floor(i/3072)===(i%3072)%1024?1:0))
          : id === 'cancellation-overflow' ? Uint16Array.from({length:size(bShape)},(_,i)=>floatToHalf(i%3?65504:-65504)) : random(size(bShape),1.73);
        const input = engine.upload(inputData, aShape, 'float16'), weight = engine.upload(weightData, bShape, 'float16');
        const a = engine.batch({ capture: true }), original = a.output(plan.shape, 'float16');
        const parameters = new Uint32Array(32);
        parameters.set([aShape.at(-2), bShape.at(-1), aShape.at(-1), plan.batch.length]);
        parameters.set(plan.batch, 8); parameters.set(plan.aStrides, 16); parameters.set(plan.bStrides, 24);
        a.dispatchTensors(aShape.at(-1)%2===0 && bShape.at(-1)%2===0 ? engine.half.packedMatmul : engine.half.matmul, [input, weight, original], parameters, Math.ceil(bShape.at(-1) / 16), Math.ceil(aShape.at(-2) / 16), size(plan.batch));
        a.submit({ retainParameters: true });
        const b = engine.batch({ capture: true }), candidate = b.matmul(input, weight); b.submit({ retainParameters: true });
        try {
          const left = await engine.read(original), right = await engine.read(candidate);
          check(left.length === right.length && left.every((bits, i) => bits === right[i]), `Changed matmul half bits: ${id}`);
          rows.push({ id, elements: left.length, exactBits: true, aShape, bShape,
            routed: [engine.half.packedMatmulK32,engine.half.packedMatmulWide,engine.half.packedMatmul32].includes(b.commands[0].pipeline),
            originalCommands: a.commands.length, fusedCommands: b.commands.length,
            originalBytes: a.allocatedBytes, fusedBytes: b.allocatedBytes, ...await pairedTimes(a, b, 512) });
        } finally { await engine.releaseMany([input, weight, ...a.outputs, ...b.outputs], [...a.scratchBuffers(), ...b.scratchBuffers(), ...a.parameters, ...b.parameters]); }
      }
    } finally { query.destroy(); resolved.destroy(); mapped.destroy(); await engine.dispose(); device.destroy(); }
    check(!errors.length, errors.join('\n')); check(!engine.buffers.size && !engine.tensors.size, 'Retained resources');
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, rows, timingAttributionSelfTests: 13, cleanup: true, errors };
  });
  verifyBrowserAdapter(result.adapter, config);
  const dominant = new Set(['up-en', 'up-sv', 'down-en', 'q-sv', 'heldout-square', 'heldout-wide']);
  const decisions = result.rows.map(row => {
    const ratio = row.samples.map(sample => sample.b / sample.a).sort((a, b) => a - b)[2];
    const requiredRatio = row.routed && (row.id.startsWith('short-') || dominant.has(row.id)) ? 0.95 : 1.05;
    return { id: row.id, routed: row.routed, exactBits: row.exactBits, timingControlPassed: row.timingControlPassed,
      medianRatio: ratio, requiredRatio, accepted: row.exactBits && row.timingControlPassed && ratio <= requiredRatio };
  });
  const accepted = decisions.every(row => row.accepted);
  console.log(JSON.stringify({ decisions, accepted }));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ status: accepted?'accepted':'rejected', decisions, ...result, implementationPins, browserVersion: browser.version(),
    timingMethod: { order: 'Five interleaved ABBA/BAAB pairs, with original/original controls before each comparison',
      calibrationReplays: 64, targetBlockMs: 32, maxRepeats: 4096, estimatedBlockWallLimitMs: 100,
      controlMedianRatioTolerance: 0.05, zeroIntervalsAreInvalid: true },
    scope: 'Raw-half exactness and GPU microkernel timing for the unchanged 16x16 reference versus selected K32/wide/square kernels. Includes projection, inner/output tails, batch broadcasts, finite-half patterns and overflow controls. Allocated engine output/scratch bytes are recorded. This diagnostic does not qualify full speech, audible latency, physical VRAM residency, energy or other hardware.'
 }, null, 2)}\n`, { flag: 'wx' });
  console.log(output); if(!accepted) process.exitCode=1;
  for (const row of result.rows) console.log(JSON.stringify({ ...row, samples: undefined, controlSamples: undefined, ratios: row.samples.map(s => s.validIntervals ? s.b / s.a : null) }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); lock.release(); }
