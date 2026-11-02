import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { cpuOperator, cpuStft } from '../helpers/cpu-operator-oracle.js';

let engine;
beforeEach(async () => { engine = await WasmKokoroCompute.create(readFileSync(process.env.PN_KOKORO_TEST_WASM || 'public/native/kokoro-engine.wasm')); });
afterEach(async () => { await engine?.dispose(); });
const input = (name, data, shape) => ({ name, data, shape, type: 1 });
const output = shape => ({ name: 'y', shape, type: 1 });
const values = (length, scale = 1) => Float32Array.from({ length }, (_, i) => scale * (Math.sin(i * .713) + .1 * Math.cos(i * .219)));

it.each([3, 9, 32, 104, 768])('matches the independent softmax exactly at width %i', async width => {
  const data = values(8 * width, 20), shape = [8, width];
  const expected = await cpuOperator('Softmax', [input('x', data, shape)], output(shape), { axis: -1 });
  const batch = engine.batch(), result = batch.softmax(engine.upload(data, shape)); batch.submit();
  expect(await engine.read(result)).toEqual(expected);
});

it.each([3, 4, 7, 16, 10321, 30961])('matches aligned and unaligned reduction rows at width %i', async width => {
  const data = values(8 * width), shape = [8, width];
  const expected = await cpuOperator('ReduceMean', [input('x', data, shape)], output([8, 1]), { axes: [1], keepdims: 1 });
  const batch = engine.batch(), result = batch.reduce(engine.upload(data, shape), [1], true); batch.submit();
  expect(await engine.read(result)).toEqual(expected);
});

it.each(['Sin', 'Cos', 'Atan'])('matches independent packet and scalar-tail %s over the speech range', async op => {
  const data = Float32Array.from({ length: 4099 }, (_, i) => Math.sin(i * .713) * 10 ** ((i % 72 - 36) / 4));
  const expected = await cpuOperator(op, [input('x', data, [data.length])], output([data.length]));
  const batch = engine.batch(), result = batch.unary(op, engine.upload(data, [data.length])); batch.submit();
  expect(await engine.read(result)).toEqual(expected);
});

it.each([128, 768])('matches ordinary and fused skip normalization independently at width %i', async width => {
  const x = values(3 * width, 3), skip = values(3 * width, .713), gamma = values(width, 2), beta = values(width, .2), shape = [1, 3, width];
  const feeds = [input('x', x, shape), input('skip', skip, shape), input('gamma', gamma, [width]), input('beta', beta, [width])];
  const expected = await cpuOperator('SkipLayerNormalization', feeds, output(shape), { epsilon: 1e-5 }, 'com.microsoft');
  const plain = await cpuOperator('LayerNormalization', [feeds[0], ...feeds.slice(2)], output(shape), { epsilon: 1e-5, axis: -1 });
  const tensors = feeds.map(feed => engine.upload(feed.data, feed.shape)), batch = engine.batch();
  const a = engine.kokoro.skipLayerNormalization(batch, ...tensors), b = engine.kokoro.layerNormalization(batch, tensors[0], tensors[2], tensors[3]); batch.submit();
  expect(await engine.read(a)).toEqual(expected); expect(await engine.read(b)).toEqual(plain);
});

it.each([1, 2, 3, 7, 16, 20, 31, 64])('matches independent real STFT at frame length %i', async length => {
  const shape = [2, length + 5], data = values(shape[0] * shape[1]), window = values(length, .5);
  const expected = await cpuStft(data, shape, window, length, 2);
  const batch = engine.batch(), result = engine.kokoro.stft(batch, engine.upload(data, shape), engine.upload(window, [length]), { frameLength: length, frameStep: 2 }); batch.submit();
  expect(await engine.read(result)).toEqual(expected);
});

function exactFma(a, b, c) {
  const decode = value => {
    const bits = new Uint32Array(Float32Array.of(value).buffer)[0], exponent = bits >>> 23 & 255;
    const mantissa = BigInt((bits & 0x7fffff) | (exponent ? 0x800000 : 0));
    return { n: bits >>> 31 ? -mantissa : mantissa, e: exponent ? exponent - 150 : -149 };
  };
  const x = decode(a), y = decode(b), z = decode(c), e = Math.min(x.e + y.e, z.e);
  const exact = (x.n * y.n << BigInt(x.e + y.e - e)) + (z.n << BigInt(z.e - e));
  if (!exact) return 0;
  const magnitude = exact < 0 ? -exact : exact, high = magnitude.toString(2).length - 1 + e;
  const quantum = Math.max(high - 23, -149), shift = quantum - e;
  let rounded;
  if (shift > 0) {
    rounded = magnitude >> BigInt(shift);
    const remainder = magnitude - (rounded << BigInt(shift)), half = 1n << BigInt(shift - 1);
    if (remainder > half || remainder === half && (rounded & 1n)) rounded++;
  } else rounded = magnitude << BigInt(-shift);
  return Math.fround((exact < 0 ? -1 : 1) * Number(rounded) * 2 ** quantum);
}

it('rounds fused matrix products once, including ties, cancellation, overflow and subnormals', async () => {
  let seed = 0x713b4f;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const float = () => { let bits = random(); if ((bits >>> 23 & 255) === 255) bits ^= 1 << 23; return new Float32Array(Uint32Array.of(bits).buffer)[0]; };
  const triples = Array.from({ length: 2048 }, () => [float(), float(), float()]);
  triples.push([1 + 2 ** -12, 1 + 2 ** -12, 2 ** -80], [1 + 2 ** -12, 1 + 2 ** -12, -(2 ** -80)]);
  const largest = new Float32Array(Uint32Array.of(0x7f7fffff).buffer)[0];
  triples.push([1 + 2 ** -23, 1 - 2 ** -23, -1], [2 ** -126, 2 ** -23, 2 ** -149], [largest, 2, -largest], [largest, 2, 0]);
  const a = Float32Array.from(triples.flatMap(([x, , z]) => [z, x])), b = Float32Array.from(triples.flatMap(([, y]) => [1, y]));
  const batch = engine.batch(), result = batch.matmul(engine.upload(a, [triples.length, 1, 2]), engine.upload(b, [triples.length, 2, 1])); batch.submit();
  expect(await engine.read(result)).toEqual(Float32Array.from(triples, ([x, y, z]) => exactFma(x, y, z)));
});
