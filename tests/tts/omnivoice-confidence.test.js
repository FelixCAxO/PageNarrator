import { expect, it, vi } from 'vitest';
import { omniVoiceUnmaskSchedule, unmaskOmniVoiceTokens } from '../../src/tts/omnivoice/runtime.js';
import { floatToHalf, halfToFloat } from '../../src/engines/tensor-format.js';

// Original complete scoring path, retained as an independent oracle for pruning.
function complete(conditional, unconditional, codes, frames, prefix, count, random, guidanceScale = 2) {
  const c = conditional instanceof Uint16Array ? Float32Array.from(conditional, halfToFloat) : conditional;
  const u = unconditional instanceof Uint16Array ? Float32Array.from(unconditional, halfToFloat) : unconditional;
  const scores = new Float64Array(codes.length), predictions = new Int32Array(codes.length), candidates = [], guided = new Float64Array(1025);
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] !== 1024n) continue;
    const book = Math.floor(index / frames), offset = (book * (prefix + frames) + prefix + index % frames) * 1025;
    let maximum = -Infinity, best = -Infinity, token = 0;
    for (let v = 0; v < 1025; v++) {
      const value = guidanceScale === 2 ? 3 * c[offset + v] - 2 * u[index * 1025 + v]
        : (1 + guidanceScale) * c[offset + v] - guidanceScale * u[index * 1025 + v];
      if (!Number.isFinite(value)) throw Object.assign(new Error('OmniVoice produced non-finite logits.'), { name: 'OmniVoiceAudioQualityError' });
      guided[v] = value; maximum = Math.max(maximum, value);
      if (v !== 1024 && value > best) { best = value; token = v; }
    }
    let sum = 0; for (const value of guided) sum += Math.exp(value - maximum);
    scores[index] = (best - maximum - Math.log(sum) - book * 5) / 5 - Math.log(-Math.log(random()));
    predictions[index] = token; candidates.push(index);
  }
  candidates.sort((a, b) => scores[b] - scores[a] || a - b);
  for (const index of candidates.slice(0, count)) codes[index] = BigInt(predictions[index]);
}
function generator(seed) {
  let state = seed, calls = 0;
  const draw = () => { calls++; state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + .5) / 4294967296; };
  return { draw, snapshot: () => [state, calls] };
}

it.each([false, true])('uses the requested guidance in the token decision, half=%s', half => {
  const c = new Float32Array(8 * 1025).fill(-8), u = new Float32Array(c.length).fill(-8);
  for (let row = 0; row < 8; row++) {
    c[row * 1025 + 1] = 3; c[row * 1025 + 2] = 2;
    u[row * 1025 + 1] = 2.4; u[row * 1025 + 2] = 1;
  }
  for (const [guidanceScale, token] of [[2, 1n], [3, 2n]]) {
    const codes = new BigInt64Array(8).fill(1024n);
    unmaskOmniVoiceTokens(half ? Uint16Array.from(c, floatToHalf) : c,
      half ? Uint16Array.from(u, floatToHalf) : u, codes, 1, 0, 8, () => .5, guidanceScale);
    expect([...codes]).toEqual(Array(8).fill(token));
  }
});
function compare(c, u, frames, prefix, counts, seed, guidanceScale = 2) {
  const a = new BigInt64Array(8 * frames).fill(1024n), b = a.slice(), x = generator(seed), y = generator(seed);
  a[frames + 1] = b[frames + 1] = 19n;
  for (const count of counts) {
    complete(c, u, a, frames, prefix, count, x.draw, guidanceScale);
    unmaskOmniVoiceTokens(c, u, b, frames, prefix, count, y.draw, guidanceScale);
    expect(b).toEqual(a); expect(y.snapshot()).toEqual(x.snapshot());
  }
}

it.each([0, 1, 3, 4])('preserves complete scoring and random draws at guidance %s', guidanceScale => {
  const frames = 9, prefix = 5, random = generator(137);
  const values = size => Float32Array.from({ length: size }, () => halfToFloat(floatToHalf((random.draw() - .5) * 24)));
  const c = values(8 * (prefix + frames) * 1025), u = values(8 * frames * 1025);
  for (const cHalf of [false, true]) for (const uHalf of [false, true]) compare(
    cHalf ? Uint16Array.from(c, floatToHalf) : c, uHalf ? Uint16Array.from(u, floatToHalf) : u,
    frames, prefix, omniVoiceUnmaskSchedule(8 * frames - 1, 24), 42, guidanceScale);
});

it.each([[false, false], [true, false], [false, true], [true, true]])('preserves all decisions and draws across 24 steps, cHalf=%s uHalf=%s', (cHalf, uHalf) => {
  const frames = 17, prefix = 7, random = generator(91);
  const values = size => Float32Array.from({ length: size }, () => halfToFloat(floatToHalf((random.draw() - .5) * 24)));
  const c = values(8 * (prefix + frames) * 1025), u = values(8 * frames * 1025);
  for (const seed of [1, 42, 51, 0xffffffff]) compare(cHalf ? Uint16Array.from(c, floatToHalf) : c,
    uHalf ? Uint16Array.from(u, floatToHalf) : u, frames, prefix, omniVoiceUnmaskSchedule(8 * frames - 1, 24), seed);
});

it.each([0, 1, 2, 15, 16, 17, 71, 72, 73, -1, .5, 1.5, Infinity, NaN])('preserves full scoring for boundary count %s', count => {
  const c = new Float32Array(8 * 9 * 1025), u = new Float32Array(c.length);
  compare(c, u, 9, 0, [count], 42);
});

it('preserves ties and extreme finite values through 64 steps', () => {
  for (const scale of [0, 2 ** -24, 65504]) {
    const c = new Float32Array(8 * 3 * 1025), u = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) { c[i] = i % 3 === 0 ? -scale : scale; u[i] = i % 7 === 0 ? scale : -scale; }
    compare(c, u, 3, 0, omniVoiceUnmaskSchedule(23, 64), 42);
  }
});

it.each([[false, false], [true, false], [false, true], [true, true]])('matches complete scoring across finite half bit patterns, cHalf=%s uHalf=%s', (cHalf, uHalf) => {
  const frames = 9, prefix = 5;
  const values = size => Uint16Array.from({ length: size }, (_, i) => (i % 65536 & 0x7c00) === 0x7c00 ? 0 : i % 65536);
  const c = values(8 * (prefix + frames) * 1025), u = values(8 * frames * 1025);
  compare(cHalf ? c : Float32Array.from(c, halfToFloat), uHalf ? u : Float32Array.from(u, halfToFloat),
    frames, prefix, omniVoiceUnmaskSchedule(8 * frames - 1, 24), 42);
});

it.each([0, 1, .5])('preserves ties at a constant random value of %s', randomValue => {
  const c = new Float32Array(8 * 9 * 1025), u = new Float32Array(c.length);
  const a = new BigInt64Array(72).fill(1024n), b = a.slice(), x = vi.fn(() => randomValue), y = vi.fn(() => randomValue);
  complete(c, u, a, 9, 0, 2, x); unmaskOmniVoiceTokens(c, u, b, 9, 0, 2, y);
  expect(b).toEqual(a); expect(y.mock.calls).toEqual(x.mock.calls);
});

it('skips only losing softmax sums while retaining every random draw', () => {
  const c = new Float32Array(8 * 3 * 1025), u = new Float32Array(c.length), a = new BigInt64Array(24).fill(1024n), b = a.slice();
  const exp = vi.spyOn(Math, 'exp'), x = vi.fn(() => .5), y = vi.fn(() => .5);
  try {
    complete(c, u, a, 3, 0, 1, x); const fullCalls = exp.mock.calls.length; exp.mockClear();
    unmaskOmniVoiceTokens(c, u, b, 3, 0, 1, y);
    expect(b).toEqual(a); expect(y.mock.calls).toEqual(x.mock.calls);
    expect(fullCalls).toBe(24 * 1025); expect(exp.mock.calls.length).toBe(6 * 1025);
  } finally { exp.mockRestore(); }
});

it('tightens a weak initial cutoff using already completed positions', () => {
  const c = new Float32Array(8 * 16 * 1025), u = new Float32Array(c.length), a = new BigInt64Array(128).fill(1024n), b = a.slice();
  let xCalls = 0, yCalls = 0;
  const x = () => xCalls++ === 0 ? .00001 : .5, y = () => yCalls++ === 0 ? .00001 : .5;
  const exp = vi.spyOn(Math, 'exp');
  try {
    complete(c, u, a, 16, 0, 1, x); expect(exp.mock.calls.length).toBe(128 * 1025); exp.mockClear();
    unmaskOmniVoiceTokens(c, u, b, 16, 0, 1, y);
    expect(b).toEqual(a); expect(yCalls).toBe(xCalls);
    expect(exp.mock.calls.length).toBe(32 * 1025);
    expect(b[1]).toBe(0n);
  } finally { exp.mockRestore(); }
});

it.each([NaN, Infinity, -Infinity])('still rejects used non-finite logits on a row below the cutoff: %s', value => {
  const c = new Float32Array(8 * 16 * 1025), u = new Float32Array(c.length); c[7 * 16 * 1025 + 1024] = value;
  const a = new BigInt64Array(128).fill(1024n), b = a.slice(), x = vi.fn(() => .5), y = vi.fn(() => .5);
  expect(() => complete(c, u, a, 16, 0, 1, x)).toThrow('non-finite');
  expect(() => unmaskOmniVoiceTokens(c, u, b, 16, 0, 1, y)).toThrow('non-finite');
  expect(b).toEqual(a); expect(y.mock.calls).toEqual(x.mock.calls);
});
