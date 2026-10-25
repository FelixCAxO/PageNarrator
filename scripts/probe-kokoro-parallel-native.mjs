// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Exact thin-wrapper controls only. Worker fences and complete speech have separate browser proofs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { assertKokoroParallelModule, KOKORO_PARALLEL_ABI, kokoroCpuRowRanges } from '../src/tts/kokoro/parallel-compute.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
if (process.argv.includes('--help')) {
  console.log('The complete original native suite and scalar-integer/refusal controls run without private inputs.\nOptional: --fixed <captured-directory> adds SHA-verified immutable actual operands/outputs from its manifest.json.\n--output <new-report-directory> selects the saved proof directory. No browser/timing inference runs.');
  process.exit(0);
}
const outputDirectory = resolve(option('--output', `artifacts/engines/kokoro-parallel-native-${Date.now()}`));
const fixed = option('--fixed', null);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = await readFile(resolve(root, 'public/native/kokoro-parallel.wasm'));
const metadata = JSON.parse(await readFile(resolve(root, 'public/native/kokoro-parallel.json')));
if (hash(binary) !== metadata.wasmSha256 || metadata.originalWasmSha256 !== hash(await readFile(resolve(root, 'public/native/kokoro-engine.wasm')))) throw new Error('Packaged engine identities disagree.');
const module = await WebAssembly.compile(binary); assertKokoroParallelModule(module);
const pins = async () => Object.fromEntries(await Promise.all(['native/kokoro-parallel.cpp', ...Object.keys(metadata.sourceSha256), 'public/native/kokoro-parallel.wasm', 'public/native/kokoro-parallel.json', 'tests/engines/kokoro-cpu.test.js', 'scripts/probe-kokoro-parallel-native.mjs']
  .map(async path => [path, hash(await readFile(resolve(root, path)))])));
const report = { status: 'incomplete', sourcePins: await pins(), wrapperSha256: metadata.wasmSha256, actual: [], independent: [], guards: [],
  capturedInputs: fixed ? { requested: true, directory: resolve(fixed) } : { requested: false, status: 'not evaluated; optional --fixed was not supplied' },
  scope: 'Original native regressions on the packaged shared binary, independent generated scalar integer gold and refusal controls. SHA-verified immutable actual captures are evaluated only with explicit --fixed. No worker, timing or complete speech acceptance.' };
await mkdir(outputDirectory, { recursive: true });
let engine;
function synthetic(xSigned, wSigned, zeroMode, maxK = false) {
  const X = xSigned ? Int8Array : Uint8Array, W = wSigned ? Int8Array : Uint8Array;
  const channels = maxK ? 1090 : 3, length = maxK ? 5 : 37, outputs = 9, kernel = 3, width = maxK ? 5 : 38, dilation = maxK ? 1 : 2, left = maxK ? 1 : 2;
  const x = X.from({ length: channels * length }, (_, i) => i * 53 % 256 - (xSigned ? 128 : 0)), w = W.from({ length: outputs * channels * kernel }, (_, i) => i * 29 % 256 - (wSigned ? 128 : 0));
  const xz = X.of(xSigned ? -127 : 253), wz = W.from({ length: zeroMode === 'channels' ? outputs : 1 }, (_, i) => wSigned ? -127 + i : 253 - i);
  const parameters = Uint32Array.of(1, channels, length, outputs, width, channels, outputs, kernel, 1, dilation, left, Number(xSigned), Number(wSigned), Number(zeroMode !== 'none'), zeroMode === 'none' ? 0 : wz.length, Math.min(32, width));
  const operands = [x, w, xz, wz].map(value => new Uint8Array(value.buffer));
  const expected = new Int32Array(outputs * width);
  for (let c = 0; c < outputs; c++) for (let j = 0; j < width; j++) {
    let sum = 0;
    for (let ci = 0; ci < channels; ci++) for (let k = 0; k < kernel; k++) {
      const source = j + k * dilation - left;
      if (source >= 0 && source < length) sum += (x[ci * length + source] - (zeroMode === 'none' ? 0 : xz[0])) * (w[(c * channels + ci) * kernel + k] - (zeroMode === 'none' ? 0 : wz[wz.length === 1 ? 0 : c]));
    }
    expected[c * width + j] = sum;
  }
  return { id: `${xSigned ? 'i8' : 'u8'}-${wSigned ? 'i8' : 'u8'}-${zeroMode}-${maxK ? 'K3270' : 'tails'}`, parameters, operands, expected };
}
function allocateCase(item) {
  const buffers = item.operands.map(bytes => { const buffer = engine.allocate(bytes.length); new Uint8Array(engine.memory.buffer, buffer.offset, bytes.length).set(bytes); return buffer; });
  buffers.push(engine.allocate(item.expected.byteLength), engine.allocate(item.parameters[5] * item.parameters[7] * item.parameters[15] * 2));
  return buffers;
}
function exact(actual, expected) {
  let differences = 0, first = null;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) { differences++; first ??= { index: i, actual: actual[i], expected: expected[i] }; }
  if (actual.length !== expected.length || differences) throw new Error(`Row-wrapper mismatch: ${JSON.stringify({ differences, first })}`);
  return { elements: expected.length, differences: 0, sha256: hash(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength)) };
}
function invoke(item, buffers, rows) {
  const offsets = buffers.map(buffer => buffer.offset), p = engine.parameterOffset;
  new Uint32Array(engine.memory.buffer, p, 16).set(item.parameters);
  new Int32Array(engine.memory.buffer, offsets[4], item.expected.length).fill(0x13572468);
  if (rows) for (const [begin, end] of kokoroCpuRowRanges(item.parameters, true)) {
    if (engine.exports.pn_kokoro_conv_integer_rows(...offsets, p, begin, end, buffers[5].size)) throw new Error('Valid row range refused.');
  } else engine.exports.pn_kokoro_conv_integer(...offsets, p);
  return new Int32Array(engine.memory.buffer, offsets[4], item.expected.length).slice();
}
function refusalControls(item, buffers) {
  const args = buffers.map(buffer => buffer.offset), rows = item.parameters[3];
  for (const guard of [{ begin: 1 }, { end: rows + 1 }, { end: rows % 2 ? rows - 2 : rows - 1 }, { begin: 2, end: 2 }, { scratchBytes: 1 },
    ...[[0, 2], [5, 64], [11, 2], [12, 2], [13, 2], [14, 2], [15, 33], [5, 33026]].map(([at, value]) => ({ at, value })),
    { pointer: [4, args[4] + 1] }, { pointer: [4, engine.memory.buffer.byteLength - 4] }, { pointer: [4, args[1]] }, { pointer: [5, args[1]] }, { parameterOffset: engine.parameterOffset + 1 }]) {
    const p = new Uint32Array(item.parameters), offsets = [...args]; if (guard.at !== undefined) p[guard.at] = guard.value; if (guard.pointer) offsets[guard.pointer[0]] = guard.pointer[1];
    new Uint32Array(engine.memory.buffer, engine.parameterOffset, 16).set(p); const out = new Int32Array(engine.memory.buffer, args[4], item.expected.length); out.fill(0x13572468);
    const status = engine.exports.pn_kokoro_conv_integer_rows(...offsets, guard.parameterOffset ?? engine.parameterOffset, guard.begin ?? 0, guard.end ?? rows, guard.scratchBytes ?? buffers[5].size);
    if (!status || !out.every(value => value === 0x13572468)) throw new Error('Invalid row metadata executed.'); report.guards.push({ id: item.id, guard, status, untouched: true });
  }
}
try {
  // Reuse all existing meaningful native regressions; only the memory-only construction changes.
  const originalTests = await readFile(resolve(root, 'tests/engines/kokoro-cpu.test.js'), 'utf8');
  const shim = `import { createMemoryOnlyTestEngine } from './test-loader.js';\n`;
  const tests = originalTests.replaceAll("'../../src/", `'${new URL('../src/', import.meta.url).href}`).replace('let engine;', `${shim}let engine;`)
    .replaceAll('WasmKokoroCompute.create(engineBinary()', 'createMemoryOnlyTestEngine(engineBinary()');
  await writeFile(resolve(outputDirectory, 'native-controls.test.js'), tests);
  await writeFile(resolve(outputDirectory, 'test-loader.js'), `import { WasmKokoroCompute } from ${JSON.stringify(new URL('../src/engines/kokoro-cpu-compute.js', import.meta.url).href)};
export async function createMemoryOnlyTestEngine(bytes,{maxBytes=536870912}={}) {const module=await WebAssembly.compile(bytes); const memory=new WebAssembly.Memory({initial:2,maximum:8192,shared:true});const instance=await WebAssembly.instantiate(module,{env:{memory}});return new WasmKokoroCompute(instance.exports,maxBytes);}\n`);
  await writeFile(resolve(outputDirectory, 'vitest.config.mjs'), `import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:[${JSON.stringify(resolve(outputDirectory, 'native-controls.test.js').replaceAll('\\', '/'))}],environment:'node',pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:30000}});\n`);
  const nativeOutput = resolve(outputDirectory, 'native-controls.json');
  const run = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(outputDirectory, 'vitest.config.mjs'), '--reporter=json', '--outputFile', nativeOutput],
    { cwd: root, stdio: 'inherit', env: { ...process.env, PN_KOKORO_TEST_WASM: resolve(root, 'public/native/kokoro-parallel.wasm') } });
  const native = JSON.parse(await readFile(nativeOutput)); report.nativeControls = { originalTestsSha256: hash(originalTests), generatedTestsSha256: hash(tests), passed: native.numPassedTests, failed: native.numFailedTests, pending: native.numPendingTests, total: native.numTotalTests };
  if (run.status !== 0 || !Number.isInteger(native.numTotalTests) || native.numTotalTests < 1 || native.numFailedTests !== 0 || native.numPendingTests !== 0 || native.numPassedTests !== native.numTotalTests) throw new Error('Existing native regression controls failed on shared binary.');
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true }), instance = await WebAssembly.instantiate(module, { env: { memory } });
  if (instance.exports.pn_parallel_abi_version() !== KOKORO_PARALLEL_ABI) throw new Error('Shared ABI mismatch.');
  engine = new WasmKokoroCompute(instance.exports, 536870912);
  let actualCases = [];
  if (fixed) {
    const manifestBytes = await readFile(resolve(fixed, 'manifest.json')); actualCases = JSON.parse(manifestBytes).cases; report.operandManifestSha256 = hash(manifestBytes);
  }
  for (const [index, entry] of actualCases.entries()) {
    const bytes = await Promise.all(entry.operands.map(async pin => { const value = await readFile(resolve(fixed, pin.filename)); if (value.length !== pin.bytes || hash(value) !== pin.sha256) throw new Error('Captured operand hash mismatch.'); return value; }));
    const item = { id: `actual-${index}`, parameters: Uint32Array.from(entry.parameters), operands: bytes.slice(0, 4), expected: new Int32Array(bytes[4].buffer.slice(bytes[4].byteOffset, bytes[4].byteOffset + bytes[4].byteLength)) };
    const buffers = allocateCase(item), result = { id: item.id, original: exact(invoke(item, buffers, false), item.expected), rows: exact(invoke(item, buffers, true), item.expected) };
    new Uint8Array(engine.memory.buffer, buffers[0].offset, 1)[0] ^= 0xff;
    result.changed = exact(invoke(item, buffers, true), invoke(item, buffers, false));
    new Uint8Array(engine.memory.buffer, buffers[0].offset, 1)[0] ^= 0xff;
    result.restored = exact(invoke(item, buffers, true), item.expected); report.actual.push(result);
    refusalControls(item, buffers);
    for (const buffer of buffers) engine.freeBuffer(buffer);
  }
  const independent = [];
  for (const x of [false, true]) for (const w of [false, true]) for (const zero of ['none', 'scalar', 'channels']) independent.push(synthetic(x, w, zero));
  independent.push(synthetic(true, false, 'channels', true));
  for (const [index, item] of independent.entries()) { const buffers = allocateCase(item); report.independent.push({ id: item.id, original: exact(invoke(item, buffers, false), item.expected), rows: exact(invoke(item, buffers, true), item.expected) }); if (index === 0) refusalControls(item, buffers); for (const buffer of buffers) engine.freeBuffer(buffer); }
  report.resources = { buffers: engine.buffers.size, tensors: engine.tensors.size, maximumBytes: engine.maxBytes, arenaBytes: memory.buffer.byteLength };
  if (engine.buffers.size || engine.tensors.size) throw new Error('Native control retained owned buffers.');
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.stack; process.exitCode = 1; }
finally { await engine?.dispose(); report.sourceStable = JSON.stringify(await pins()) === JSON.stringify(report.sourcePins); if (!report.sourceStable) { report.status = 'fail'; process.exitCode = 1; } await writeFile(resolve(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify({ status: report.status, outputDirectory, native: report.nativeControls, actualElements: report.actual.reduce((sum, item) => sum + item.rows.elements, 0), independent: report.independent.length, failure: report.failure }));
