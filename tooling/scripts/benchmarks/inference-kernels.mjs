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
assert(process.argv.slice(2).every(arg => arg.startsWith('--output=')), 'Usage: node tooling/scripts/benchmarks/inference-kernels.mjs [--output=<new-report.json>]');
const output = resolve(root, outputArgument?.slice(9) || `artifacts/engines/inference-kernels${config.suffix}-${Date.now()}.json`);
const pins = () => engineSourcePins(root, ['tooling/scripts/benchmarks/inference-kernels.mjs']);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.end('<!doctype html><title>Half SiLU A/B</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = resolve(root, `.${pathname}`);
    assert(pathname.startsWith('/src/engines/') && pathname.endsWith('.js') && file.startsWith(`${root}${sep}`));
    response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
const lock = await acquireMeasurementLock({ owner: { purpose: 'Exact-half inference kernel A/B' } });
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
    const { executeIndexNode } = await import('/src/engines/onnx-metadata.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const adapter = await navigator.gpu.requestAdapter();
    check(adapter?.features.has('shader-f16') && adapter.features.has('timestamp-query'), 'Half SiLU diagnostic requires shader-f16 and timestamp-query');
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
    const repeatCount = (ns, fallback) => Number.isFinite(ns) && ns > 0 ? Math.max(1, Math.min(4096, Math.ceil(8e6 / ns))) : fallback;
    for (const [ns, expected] of [[0, 64], [NaN, 64], [1, 4096], [16e6, 1]]) check(repeatCount(ns, 64) === expected, 'Invalid adaptive timing repeat count');
    const calibratedRepeats = (estimate, wallMs, fallback) => {
      const repeatCap = Math.max(1, Math.min(4096, Math.floor(100 / Math.max(0.01, wallMs))));
      return Math.min(repeatCount(estimate, Math.min(fallback, repeatCap)), repeatCap);
    };
    for (const [estimate, wallMs, expected] of [[0, 1, 64], [1, 1, 100], [100000, 1, 80], [100000, 1000, 1], [NaN, 100, 1], [1e9, 0.01, 1]]) {
      check(calibratedRepeats(estimate, wallMs, 64) === expected, 'Unsafe calibrated timing repeat count');
    }
    const time = async batch => {
      const started = performance.now();
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass({ timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
      for (const command of batch.commands) {
        pass.setPipeline(command.pipeline); pass.setBindGroup(0, command.group); pass.dispatchWorkgroups(command.x, command.y, command.z);
      }
      pass.end(); encoder.resolveQuerySet(query, 0, 2, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, mapped, 0, 16); device.queue.submit([encoder.finish()]);
      await mapped.mapAsync(GPUMapMode.READ); const values = new BigUint64Array(mapped.getMappedRange()), ns = Number(values[1] - values[0]); mapped.unmap();
      return { ns, wallMs: performance.now() - started };
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
      for (const [id, shape, upShape] of [['all-finite-half', [allFinite.length], [allFinite.length]], ['broadcast', [65, 1], [1, 67]], ['odd', [17, 3073], [17, 3073]], ['mlp', [1, 320, 3072], [1, 320, 3072]], ['empty', [0, 3072], [1, 3072]]]) {
        const size = shape => shape.reduce((a, b) => a * b, 1);
        const gate = engine.upload(id === 'all-finite-half' ? allFinite : random(size(shape), 12), shape, 'float16');
        const up = engine.upload(random(size(upShape), 1), upShape, 'float16');
        const a = engine.batch({ capture: true }), s = a.unary('Sigmoid', gate), activation = a.binary('Mul', gate, s);
        a.recycle(s); const aOut = a.binary('Mul', activation, up); a.recycle(activation); a.submit({ retainParameters: true });
        const b = engine.batch({ capture: true }), bOut = b.siluGate(gate, up); b.submit({ retainParameters: true });
        try {
          if (id === 'all-finite-half') {
            const casts = engine.batch(), wide = casts.cast(gate, 1), narrow = casts.cast(wide, 10);
            casts.submit({ retainParameters: true });
            try { check((await engine.read(narrow)).every((bits, i) => bits === allFinite[i]), 'Half widening/narrowing changed finite bits'); }
            finally { await engine.releaseMany([...casts.outputs], [...casts.scratchBuffers(), ...casts.parameters]); }
          }
          const original = await engine.read(aOut), fused = await engine.read(bOut);
          check(original.length === fused.length && original.every((bits, i) => bits === fused[i]), `Changed half bits: ${id}`);
          const timing = original.length ? await pairedTimes(a, b) : { samples: [], controlSamples: [], controlMedianRatio: null, timingControlPassed: null };
          rows.push({ id, elements: original.length, exactBits: true, originalCommands: a.commands.length, fusedCommands: b.commands.length, originalBytes: a.allocatedBytes, fusedBytes: b.allocatedBytes, ...timing });
        } finally { await engine.releaseMany([gate, up, ...a.outputs, ...b.outputs], [...a.scratchBuffers(), ...b.scratchBuffers(), ...a.parameters, ...b.parameters]); }
      }
      for (const [id, data, shape, node] of [
        ['index-view-fp16-finite', allFinite, [1, 8, 62, 128], { opType: 'Slice', attrs: { starts: [0], ends: [Number.MAX_SAFE_INTEGER], axes: [2] } }],
        ['index-view-fp16-odd', allFinite.slice(0, 17), [17], { opType: 'Slice', attrs: { starts: [0], ends: [17] } }],
        ['index-view-fp32', Float32Array.of(0, -0, 1e-45, -1e-45, 3.5, -7.25), [2, 1, 3], { opType: 'Transpose', attrs: { perm: [1, 0, 2] } }],
        ['index-view-int32', Int32Array.of(-2147483648, 2147483647, -1, 0, 7, 16), [1, 2, 3], { opType: 'Transpose', attrs: { perm: [1, 0, 2] } }],
        ['index-view-empty', new Uint16Array(0), [0, 3], { opType: 'Slice', attrs: { starts: [0], ends: [3], axes: [1] } }],
      ]) {
        const type = data instanceof Uint16Array ? 'float16' : data instanceof Int32Array ? 'int32' : 'float32';
        const input = type === 'int32' ? engine.uploadInt32(data, shape) : engine.upload(data, shape, type);
        const a = engine.batch({ capture: true }), original = a.index(input, { shape: input.shape,
          strides: input.shape.map((_, axis) => input.shape.slice(axis + 1).reduce((n, size) => n * size, 1)), offset: 0 });
        a.submit({ retainParameters: true });
        const b = engine.batch({ capture: true }), view = executeIndexNode({ ...node, inputs: ['x'] }, { value: () => input, batch: b });
        b.submit({ retainParameters: true });
        const bytes = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
        try {
          check(view.buffer === input.buffer && original.buffer !== input.buffer, `Copy/view ownership changed: ${id}`);
          check(b.commands.length === 0 && b.allocatedBytes === 0, `View encoded GPU work: ${id}`);
          check(equal(bytes(await engine.read(original)), bytes(data)) && equal(bytes(await engine.read(view)), bytes(data)), `Index bits changed: ${id}`);
          const changed = data.slice().reverse(); engine.write(input, changed);
          check(equal(bytes(await engine.read(original)), bytes(data)), `Explicit copy aliased writable input: ${id}`);
          a.replay(); b.replay();
          check(equal(bytes(await engine.read(original)), bytes(changed)) && equal(bytes(await engine.read(view)), bytes(changed)), `Replay/view update changed: ${id}`);
          rows.push({ id, elements: data.length, exactBits: true, originalCommands: a.commands.length, fusedCommands: b.commands.length,
            originalBytes: a.allocatedBytes, fusedBytes: b.allocatedBytes, samples: [] });
        } finally { await engine.releaseMany([input, ...a.outputs, ...b.outputs], [...a.scratchBuffers(), ...b.scratchBuffers(), ...a.parameters, ...b.parameters]); }
      }
      for (const [id, aShape, bShape] of [
        ['matmul-all-finite-half', [allFinite.length, 2], [2, 2]],
        ['matmul-qkv', [1, 192, 1024], [1024, 2048]], ['matmul-up', [1, 320, 1024], [1024, 3072]],
        ['matmul-down', [1, 320, 3072], [3072, 1024]], ['matmul-attention', [1, 16, 192, 128], [1, 16, 128, 192]],
        ['matmul-even-tail', [33, 66], [66, 68]], ['matmul-broadcast', [2, 1, 35, 34], [1, 3, 34, 38]],
        ['matmul-odd-inner', [33, 65], [65, 68]], ['matmul-odd-output', [33, 66], [66, 67]],
      ]) {
        const size = shape => shape.reduce((a, b) => a * b, 1), plan = batchedMatmulPlan(aShape, bShape);
        const inputData = id === 'matmul-all-finite-half' ? Uint16Array.from({ length: allFinite.length * 2 }, (_, i) => i % 2 ? 0 : allFinite[i / 2]) : random(size(aShape), 1.73);
        const weightData = id === 'matmul-all-finite-half' ? Uint16Array.from([1, 0, 0, 1], floatToHalf) : random(size(bShape), 1.73);
        const input = engine.upload(inputData, aShape, 'float16'), weight = engine.upload(weightData, bShape, 'float16');
        const a = engine.batch({ capture: true }), original = a.output(plan.shape, 'float16');
        const parameters = new Uint32Array(32);
        parameters.set([aShape.at(-2), bShape.at(-1), aShape.at(-1), plan.batch.length]);
        parameters.set(plan.batch, 8); parameters.set(plan.aStrides, 16); parameters.set(plan.bStrides, 24);
        a.dispatchTensors(engine.half.matmul, [input, weight, original], parameters, Math.ceil(bShape.at(-1) / 16), Math.ceil(aShape.at(-2) / 16), size(plan.batch));
        a.submit({ retainParameters: true });
        const b = engine.batch({ capture: true }), candidate = b.matmul(input, weight); b.submit({ retainParameters: true });
        try {
          const left = await engine.read(original), right = await engine.read(candidate);
          check(left.length === right.length && left.every((bits, i) => bits === right[i]), `Changed matmul half bits: ${id}`);
          rows.push({ id, elements: left.length, exactBits: true, aShape, bShape,
            packed: b.commands[0].pipeline === engine.half.packedMatmul,
            originalCommands: a.commands.length, fusedCommands: b.commands.length,
            originalBytes: a.allocatedBytes, fusedBytes: b.allocatedBytes, ...await pairedTimes(a, b, 32) });
        } finally { await engine.releaseMany([input, weight, ...a.outputs, ...b.outputs], [...a.scratchBuffers(), ...b.scratchBuffers(), ...a.parameters, ...b.parameters]); }
      }
    } finally { query.destroy(); resolved.destroy(); mapped.destroy(); await engine.dispose(); device.destroy(); }
    check(!errors.length, errors.join('\n')); check(!engine.buffers.size && !engine.tensors.size, 'Retained resources');
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, rows, timingAttributionSelfTests: 13, cleanup: true, errors };
  });
  verifyBrowserAdapter(result.adapter, config); assert.deepEqual(await pins(), implementationPins, 'Source changed during diagnostic');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ status: 'pass', ...result, implementationPins, browserVersion: browser.version(),
    timingMethod: 'Interleaved ABBA/BAAB blocks in one submission, five pairs, adaptive target 8 ms per block capped at 4096 repeats and an estimated 100 ms per-block wall-time budget, with at least one batch repetition. Calibration executes each captured batch once. Zero-duration estimates use the caller fallback capped by the wall-time budget. A single batch can exceed the budget. Original/original controls precede each comparison; median control ratio must be within 5% for that timing row to pass its noise control. Correctness status is separate from timingControlPassed.',
    scope: 'Finite-half SiLU, packed MatMul, cast and index-view exactness, engine-owned temporary bytes, and controlled repeated GPU timestamp intervals. Index views perform no GPU dispatch and have no timing ratio. Failed noise controls retain raw timings without supporting a speed claim. Microkernel diagnostic, not full speech, power, device utilization or representative hardware acceptance.' }, null, 2)}\n`, { flag: 'wx' });
  console.log(output);
  for (const row of result.rows) console.log(JSON.stringify({ ...row, samples: undefined, controlSamples: undefined, ratios: row.samples.map(s => s.validIntervals ? s.b / s.a : null) }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); lock.release(); }
