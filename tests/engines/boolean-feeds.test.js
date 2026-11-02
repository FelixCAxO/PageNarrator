import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { modelFeed } from '../../src/engines/bounded-integers.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';

const info = { name: 'mask', dataType: 9, dims: ['n'] };
const feed = data => ({ shape: [data.length], data });

it('validates every possible boolean byte while widening and keeps shape/type checks', () => {
  const storage = new Map();
  for (let value = 0; value < 256; value += 1) {
    const run = () => modelFeed(info, feed(Uint8Array.of(0, value, 1)), storage);
    if (value <= 1) expect(run().data).toEqual(Uint32Array.of(0, value, 1));
    else expect(run).toThrow(/Boolean/);
  }
  expect(() => modelFeed(info, { shape: [3], data: new Uint8Array(2) }, storage)).toThrow(/count/);
  expect(() => modelFeed({ ...info, dims: [3] }, feed(new Uint8Array(2)), storage)).toThrow(/shape/);
  expect(() => modelFeed(info, { ...feed(new Uint8Array(2)), type: 'uint8' }, storage)).toThrow(/type/);
  expect(() => modelFeed(info, feed(new Uint32Array(2)), storage)).toThrow(/type/);
  expect(modelFeed(info, feed(new Uint8Array()), storage).data).toEqual(new Uint32Array());
});

it('reuses capacity while rewriting caller mutations and keeping input names separate', () => {
  const storage = new Map(), source = Uint8Array.of(1, 0, 1, 1);
  const first = modelFeed(info, feed(source), storage).data;
  source.fill(0);
  const shrunk = modelFeed(info, feed(source.subarray(0, 2)), storage).data;
  expect(shrunk.buffer).toBe(first.buffer); expect(shrunk).toEqual(Uint32Array.of(0, 0));
  const other = modelFeed({ ...info, name: 'other' }, feed(source), storage).data;
  expect(other.buffer).not.toBe(first.buffer);
  source.fill(1);
  expect(modelFeed(info, feed(source), storage).data).toBe(first);
  expect(first).toEqual(Uint32Array.of(1, 1, 1, 1)); expect(other).toEqual(new Uint32Array(4));
});

it('caps retained conversion storage across inputs and does not cache oversized or invalid growth', () => {
  const storage = new Map(), half = new Uint8Array(512 * 1024);
  const first = modelFeed(info, feed(half), storage).data;
  modelFeed({ ...info, name: 'other' }, feed(half), storage);
  expect([...storage.values()].reduce((sum, data) => sum + data.byteLength, 0)).toBe(4 * 1024 * 1024);
  modelFeed({ ...info, name: 'third' }, feed(Uint8Array.of(1)), storage);
  expect(storage.has('third')).toBe(false);
  modelFeed(info, feed(new Uint8Array(1024 * 1024 + 1)), storage);
  expect(storage.get('mask')).toBe(first);
  const invalid = new Uint8Array(half.length + 1); invalid[invalid.length - 1] = 255;
  expect(() => modelFeed(info, feed(invalid), storage)).toThrow(/Boolean/);
  expect(storage.get('mask')).toBe(first);
  expect(modelFeed(info, feed(half.fill(1)), storage).data).toBe(first);
  expect(first.every(value => value === 1)).toBe(true);
});

it('returns independent conversion storage when no serialized session owns a cache', () => {
  const source = Uint8Array.of(0, 1), first = modelFeed(info, feed(source)).data;
  source.fill(1);
  expect(modelFeed(info, feed(source)).data.buffer).not.toBe(first.buffer);
  expect(first).toEqual(Uint32Array.of(0, 1));
});

it('copies safely when a supplied byte view overlaps the reusable conversion buffer', () => {
  const storage = new Map();
  const previous = modelFeed(info, feed(new Uint8Array(8).fill(1)), storage).data;
  const source = new Uint8Array(previous.buffer, 0, 8), expected = Uint32Array.from(source);
  const result = modelFeed(info, feed(source), storage).data;
  expect(result.buffer).not.toBe(previous.buffer); expect(result).toEqual(expected);
  expect(previous).toEqual(new Uint32Array(8).fill(1));
});

it('replays mutable masks without changing old outputs, isolates sessions and clears storage on disposal', async () => {
  const engine = await WasmKokoroCompute.create(readFileSync('public/native/kokoro-engine.wasm'));
  const node = (opType, inputs, output, attributes = new Map()) => ({ opType, name: output, inputs, outputs: [output], attributes });
  const model = { graph: { initializers: [], inputs: [info, { ...info, name: 'other' }],
    outputs: [{ name: 'y', dataType: 9, dims: ['n'] }], nodes: [node('And', ['mask', 'other'], 'y')] }, functions: [], opsets: [{ version: 17 }] };
  const a = new WebGpuOnnxSession(structuredClone(model), engine, false, 1024 * 1024, 2);
  const b = new WebGpuOnnxSession(structuredClone(model), engine, false, 1024 * 1024, 2);
  try {
    const source = Uint8Array.of(1, 0, 1, 1), ones = new Uint8Array(4).fill(1);
    const old = (await a.run({ mask: feed(source), other: feed(ones) })).y.data;
    source.fill(0);
    const [x, y] = await Promise.all([a.run({ mask: feed(source), other: feed(ones) }), b.run({ mask: feed(ones), other: feed(ones) })]);
    expect(x.y.data).toEqual(new Uint8Array(4)); expect(y.y.data).toEqual(ones); expect(old).toEqual(Uint8Array.of(1, 0, 1, 1));
    expect(a.lastRun.cacheHit).toBe(true);
    expect(a.booleanFeeds.get('mask').buffer).not.toBe(b.booleanFeeds.get('mask').buffer);
    source[3] = 2;
    await expect(a.run({ mask: feed(source), other: feed(ones) })).rejects.toThrow(/Boolean/);
    source.fill(1);
    expect((await a.run({ mask: feed(source), other: feed(ones) })).y.data).toEqual(ones);
  } finally { await a.dispose(); await b.dispose(); await engine.dispose(); }
  expect(a.booleanFeeds.size).toBe(0); expect(b.booleanFeeds.size).toBe(0);
});
