import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeNativeKernels, processPcm } from '../../src/lib/native-kernels.js';
import {
  createAlignedWordTimings,
  estimateWordTimings,
  pcmToWavBlob,
  synthesizeSpeechChunk,
  synthesizeSpeechSegments,
} from '../../src/lib/speech-audio.js';

beforeAll(async () => {
  const instance = await initializeNativeKernels(readFileSync(new URL('../../public/native/kernels.wasm', import.meta.url)));
  expect(instance?.exports.pcm_process).toBeTypeOf('function');
});

// Freeze the pre-native conversion: asymmetric scale and truncation are audible-data contracts.
function legacyPcm16(pcm) {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
  }
  return bytes;
}

function windowedPcm(length, start, end) {
  const pcm = new Float32Array(length);
  pcm.fill(0.2, start, end);
  return pcm;
}

async function expectSameSpeech(actual, reference) {
  expect(new Uint8Array(await actual.blob.arrayBuffer())).toEqual(new Uint8Array(await reference.blob.arrayBuffer()));
  expect(actual.wordTimings).toEqual(reference.wordTimings);
  expect(actual.durationSeconds).toBe(reference.durationSeconds);
}

describe('native audio parity', () => {
  it('preserves PCM16 bytes for clipping, nonfinite values, signed zero and a subarray', async () => {
    const backing = Float32Array.from([42, -Infinity, -2, -1, -0.5, -0.00001, -0, 0, 0.00001, 0.3, 0.5, 1, 2, Infinity, NaN, 42]);
    const pcm = backing.subarray(1, backing.length - 1);
    const native = processPcm(pcm, 0.0005, 0.015);
    expect(native).not.toBeNull();
    expect(native.pcm16).toEqual(legacyPcm16(pcm));
    const bytes = new Uint8Array(await pcmToWavBlob(pcm, 24000).arrayBuffer());
    expect(bytes.subarray(44)).toEqual(legacyPcm16(pcm));
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24000);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(pcm.length * 2);
  });

  it('preserves rounding near PCM16 boundaries over deterministic float32 samples', () => {
    let seed = 123;
    const pcm = Float32Array.from({ length: 4096 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff * 2.4 - 1.2;
    });
    expect(processPcm(pcm, 0.0005, 0.015).pcm16).toEqual(legacyPcm16(pcm));
  });

  it('keeps strict threshold boundaries and ignores nonfinite values', () => {
    const pcm = Float32Array.from([NaN, Infinity, 0.125, 0.25, 1, -0.125, -Infinity]);
    const bounds = processPcm(pcm, 0.125, 0.125, false);
    expect(bounds).toEqual({ pcm16: null, first: 3, last: 4 });
    expect(processPcm(new Float32Array(16), 0.0005, 0.015, false)).toEqual({ pcm16: null, first: -1, last: -1 });
    expect(processPcm([0, 0.5, 0], 0.0005, 0.015)).toBeNull();
  });

  it.each([
    ['trimmed', windowedPcm(2600, 200, 1600)],
    ['untrimmed', Float32Array.from({ length: 1600 }, () => 0.2)],
    ['silent', new Float32Array(1600)],
  ])('preserves generated WAV and word timing for %s audio', async (_name, pcm) => {
    const generate = (audio) => ({ generate: async () => ({ audio, sampling_rate: 1000 }) });
    const native = await synthesizeSpeechChunk(generate(pcm), 'Hello world', { useStream: false });
    const reference = await synthesizeSpeechChunk(generate(Array.from(pcm)), 'Hello world', { useStream: false });
    await expectSameSpeech(native, reference);
  });

  it('preserves combined stream WAV bytes and per-segment timing offsets', async () => {
    const chunks = [windowedPcm(2500, 400, 1700), windowedPcm(1800, 200, 1200)];
    const tts = (convert) => ({ async *stream() {
      for (let index = 0; index < chunks.length; index += 1) {
        yield { text: ['Hello world', 'Read more'][index], audio: { audio: convert(chunks[index]), sampling_rate: 1000 } };
      }
    } });
    const native = await synthesizeSpeechChunk(tts((pcm) => pcm), 'Hello world. Read more.');
    const reference = await synthesizeSpeechChunk(tts(Array.from), 'Hello world. Read more.');
    await expectSameSpeech(native, reference);
    expect(native.wordTimings[2].start).toBeGreaterThan(2.5);
  });

  it('preserves progressive segment WAV, timing and spoken-word offsets', async () => {
    const chunks = [windowedPcm(2500, 400, 1700), windowedPcm(1800, 200, 1200)];
    const collect = async (convert) => {
      const tts = { async *stream() {
        for (let index = 0; index < chunks.length; index += 1) {
          yield { text: ['Hello world.', 'Read more.'][index], audio: { audio: convert(chunks[index]), sampling_rate: 1000 } };
        }
      } };
      const segments = [];
      for await (const segment of synthesizeSpeechSegments(tts, 'Hello world. Read more.')) segments.push(segment);
      return segments;
    };
    const native = await collect((pcm) => pcm);
    const reference = await collect(Array.from);
    expect(native.map(({ speechWordOffset }) => speechWordOffset)).toEqual([0, 2]);
    for (let index = 0; index < native.length; index += 1) await expectSameSpeech(native[index], reference[index]);
  });

  it('does not re-read PCM when the supplied speech window is explicitly null', () => {
    let reads = 0;
    const pcm = new Proxy({ length: 1000 }, { get(target, key) {
      if (/^\d+$/u.test(String(key))) { reads += 1; return Number(key) >= 200 && Number(key) < 700 ? 0.2 : 0; }
      return target[key];
    } });
    const source = { audio: { audio: pcm, sampling_rate: 1000 } };
    expect(createAlignedWordTimings('Hello world', 1, source, { speechWindow: null })).toEqual(estimateWordTimings('Hello world', 1));
    expect(reads).toBe(0);
    expect(createAlignedWordTimings('Hello world', 1, source)[0].start).toBeCloseTo(0.16);
    expect(reads).toBeGreaterThan(0);
  });
});
