import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { assertKokoroParallelModule, KOKORO_PARALLEL_ABI, kokoroCpuRowRanges } from '../../src/tts/kokoro/parallel-compute.js';

let module, engine;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  const bytes = readFileSync('public/native/kokoro-parallel.wasm'), metadata = JSON.parse(readFileSync('public/native/kokoro-parallel.json', 'utf8'));
  expect(hash(bytes)).toBe(metadata.wasmSha256);
  expect(metadata.originalWasmSha256).toBe(hash(readFileSync('public/native/kokoro-engine.wasm')));
  expect(metadata.maximumMemoryBytes).toBe(536870912); expect(metadata.parallelAbi).toBe(KOKORO_PARALLEL_ABI);
  module = await WebAssembly.compile(bytes); assertKokoroParallelModule(module);
  expect(WebAssembly.Module.imports(module)).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }]);
});
beforeEach(async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  expect(instance.exports.memory).toBe(memory); expect(instance.exports.pn_parallel_abi_version()).toBe(KOKORO_PARALLEL_ABI);
  engine = new WasmKokoroCompute(instance.exports, 536870912);
});
afterEach(async () => { await engine?.dispose(); });

function fixture(xSigned, wSigned, zeroMode, maxProducts = false) {
  const X = xSigned ? Int8Array : Uint8Array, W = wSigned ? Int8Array : Uint8Array;
  const channels = maxProducts ? 1090 : 3, length = maxProducts ? 5 : 37, outputs = 9, kernel = 3, width = maxProducts ? 5 : 38, dilation = maxProducts ? 1 : 2, left = maxProducts ? 1 : 2;
  const x = X.from({ length: channels * length }, (_, i) => i * 53 % 256 - (xSigned ? 128 : 0)), w = W.from({ length: outputs * channels * kernel }, (_, i) => i * 29 % 256 - (wSigned ? 128 : 0));
  const xz = X.of(xSigned ? -127 : 253), wz = W.from({ length: zeroMode === 'channels' ? outputs : 1 }, (_, i) => wSigned ? -127 + i : 253 - i);
  const p = Uint32Array.of(1, channels, length, outputs, width, channels, outputs, kernel, 1, dilation, left, Number(xSigned), Number(wSigned), Number(zeroMode !== 'none'), zeroMode === 'none' ? 0 : wz.length, Math.min(32, width));
  const expected = new Int32Array(outputs * width);
  for (let row = 0; row < outputs; row++) for (let j = 0; j < width; j++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) for (let k = 0; k < kernel; k++) {
      const source = j + k * dilation - left;
      if (source >= 0 && source < length) sum += (x[channel * length + source] - (zeroMode === 'none' ? 0 : xz[0])) * (w[(row * channels + channel) * kernel + k] - (zeroMode === 'none' ? 0 : wz[wz.length === 1 ? 0 : row]));
    }
    expected[row * width + j] = sum;
  }
  const buffers = [x, w, xz, wz].map(value => { const buffer = engine.allocate(value.byteLength); new Uint8Array(engine.memory.buffer, buffer.offset, value.byteLength).set(new Uint8Array(value.buffer)); return buffer; });
  buffers.push(engine.allocate(expected.byteLength), engine.allocate(channels * kernel * p[15] * 2));
  return { p, expected, buffers, args: buffers.map(buffer => buffer.offset) };
}

const cases = [false, true].flatMap(x => [false, true].flatMap(w => ['none', 'scalar', 'channels'].map(zero => [x, w, zero, false])));
cases.push([true, false, 'channels', true]);
it.each(cases)('matches independent integer rows with signed flags %s/%s, zero points %s, maximum products %s', (x, w, zero, maxProducts) => {
  const { p, expected, buffers, args } = fixture(x, w, zero, maxProducts);
  new Uint32Array(engine.memory.buffer, engine.parameterOffset, 16).set(p);
  const output = new Int32Array(engine.memory.buffer, args[4], expected.length); output.fill(0x13572468);
  for (const [begin, end] of kokoroCpuRowRanges(p, true)) expect(engine.exports.pn_kokoro_conv_integer_rows(...args, engine.parameterOffset, begin, end, buffers[5].size)).toBe(0);
  expect(output).toEqual(expected);
  for (const buffer of buffers) engine.freeBuffer(buffer); expect(engine.buffers.size).toBe(0);
});

it('refuses malformed row metadata, pointer spans and hazardous aliases before touching output', () => {
  const { p, expected, buffers, args } = fixture(false, true, 'channels');
  const guards = [
    { begin: 1 }, { end: 7 }, { begin: 2, end: 2 }, { end: 10 }, { scratchBytes: 1 }, { parameterOffset: engine.parameterOffset + 1 },
    ...[[0, 2], [5, 4], [11, 2], [12, 2], [13, 2], [14, 2], [15, 33]].map(([index, value]) => ({ change: [index, value] })),
    { pointer: [4, args[4] + 1] }, { pointer: [4, engine.memory.buffer.byteLength - 4] }, { pointer: [0, engine.memory.buffer.byteLength - 1] },
    { pointer: [3, engine.memory.buffer.byteLength - 1] }, { pointer: [4, args[1]] }, { pointer: [5, args[1]] }, { pointer: [5, engine.parameterOffset] },
  ];
  for (const guard of guards) {
    const parameters = new Uint32Array(p), offsets = [...args]; if (guard.change) parameters[guard.change[0]] = guard.change[1]; if (guard.pointer) offsets[guard.pointer[0]] = guard.pointer[1];
    new Uint32Array(engine.memory.buffer, engine.parameterOffset, 16).set(parameters);
    const output = new Int32Array(engine.memory.buffer, args[4], expected.length); output.fill(0x13572468);
    const status = engine.exports.pn_kokoro_conv_integer_rows(...offsets, guard.parameterOffset ?? engine.parameterOffset, guard.begin ?? 0, guard.end ?? 9, guard.scratchBytes ?? buffers[5].size);
    expect(status, JSON.stringify(guard)).not.toBe(0); expect(output.every(value => value === 0x13572468), JSON.stringify(guard)).toBe(true);
  }
});
