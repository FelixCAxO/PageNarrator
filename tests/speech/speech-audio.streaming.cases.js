import { createAudio } from "./speech-audio.fixtures.js";
import { describe, expect, it, vi } from 'vitest';
import { pcmToWavBlob, primeSpeechSegments, synthesizeSpeechChunk, synthesizeSpeechSegments } from "../../src/lib/speech-audio.js";

describe('speech audio synthesis', () => {
  it.each([1, 3])('encodes %s stream segments without allocating a concatenated PCM copy', async (count) => {
    const NativeFloat32Array = globalThis.Float32Array;
    const chunks = Array.from({ length: count }, () => [-2, -1, -0.5, 0, 0.3, 1, 2]);
    const expected = pcmToWavBlob(NativeFloat32Array.from(chunks.flat()), 24);
    let copiedBytes = 0;
    vi.stubGlobal('Float32Array', class extends NativeFloat32Array {
      constructor(...args) { super(...args); copiedBytes += this.byteLength; }
    });
    let speech;
    try {
      speech = await synthesizeSpeechChunk({
        async *stream() {
          for (const chunk of chunks) yield { text: 'hello', audio: { audio: chunk, sampling_rate: 24 } };
        },
      }, 'hello', { voice: 'af_heart' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(new Uint8Array(await speech.blob.arrayBuffer())).toEqual(new Uint8Array(await expected.arrayBuffer()));
    expect(speech.durationSeconds).toBeCloseTo(count * chunks[0].length / 24);
    expect(speech.wordTimings.map(({ text }) => text)).toEqual(Array(count).fill('hello'));
    expect(copiedBytes).toBe(0);
  });

  it.each(['error', 'early end', 'timeout'])('synthesizes the unread tail after a progressive stream %s without repeating words', async (failure) => {
    const tts = {
      async *stream() {
        yield { text: 'First clause,', audio: createAudio() };
        if (failure === 'error') throw new Error('GPU inference failed');
        if (failure === 'timeout') await new Promise(() => {});
      },
      generate: vi.fn(async () => createAudio()),
    };
    const segments = [];
    for await (const segment of synthesizeSpeechSegments(tts, 'First clause, then finish the sentence.', { voice: 'af_heart', streamTimeoutMs: 10 })) segments.push(segment);
    expect(segments.map(({ text, speechWordOffset }) => [text, speechWordOffset])).toEqual([
      ['First clause,', 0], ['then finish the sentence.', 2],
    ]);
    expect(tts.generate).toHaveBeenCalledExactlyOnceWith('then finish the sentence.', { voice: 'af_heart' });
  });

  it('primes the first progressive segment during preload without draining the stream', async () => {
    let releaseFirst;
    let releaseSecond;
    const firstReady = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const secondReady = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    let nextCalls = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            if (nextCalls === 1) {
              await firstReady;
              return { done: false, value: 'first' };
            }
            if (nextCalls === 2) {
              await secondReady;
              return { done: false, value: 'second' };
            }
            return { done: true };
          },
          async return() {
            return { done: true };
          },
        };
      },
    };

    const segments = primeSpeechSegments(source);
    expect(nextCalls).toBe(1);

    let firstSettled = false;
    const firstPromise = segments.next().then((result) => {
      firstSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    releaseFirst();
    await expect(firstPromise).resolves.toEqual({ done: false, value: 'first' });
    expect(nextCalls).toBe(1);

    const secondPromise = segments.next();
    expect(nextCalls).toBe(2);
    releaseSecond();
    await expect(secondPromise).resolves.toEqual({ done: false, value: 'second' });
  });

  it('reports when a primed progressive segment is ready before playback consumes it', async () => {
    let releaseFirst;
    const firstReady = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const ready = [];
    const source = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await firstReady;
            return { done: false, value: 'first' };
          },
        };
      },
    };

    const segments = primeSpeechSegments(source, {
      onSegmentReady: (event) => ready.push(event),
    });
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(ready).toEqual([{
      segmentIndex: 0,
      result: { done: false, value: 'first' },
    }]);
    await expect(segments.next()).resolves.toEqual({ done: false, value: 'first' });
  });

  it('yields Kokoro stream segments before the stream closes for progressive playback', async () => {
    let releaseSecond;
    const secondReady = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    const tts = {
      stream() {
        return {
          async next() {
            callCount += 1;
            if (callCount === 1) {
              return {
                done: false,
                value: { text: 'First sentence.', audio: createAudio(12000, 24000) },
              };
            }
            if (callCount === 2) {
              await secondReady;
              return {
                done: false,
                value: { text: 'Second sentence.', audio: createAudio(24000, 24000) },
              };
            }
            return { done: true };
          },
          async return() {
            return { done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    const iterator = synthesizeSpeechSegments(tts, 'First sentence. Second sentence.', {
      voice: 'af_heart',
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.text).toBe('First sentence.');
    expect(first.value.blob).toBeInstanceOf(Blob);
    expect(first.value.wordTimings.at(-1).end).toBeCloseTo(0.5);
    expect(first.value.speechWordOffset).toBe(0);

    let secondSettled = false;
    const secondPromise = iterator.next().then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseSecond();
    const second = await secondPromise;
    expect(second.done).toBe(false);
    expect(second.value.text).toBe('Second sentence.');
    expect(second.value.speechWordOffset).toBe(2);

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('returns the underlying stream when progressive synthesis is aborted while waiting', async () => {
    const controller = new AbortController();
    let returnCalled = false;
    const tts = {
      stream() {
        return {
          async next() {
            await new Promise(() => {});
            return { done: true };
          },
          async return() {
            returnCalled = true;
            return { done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    const iterator = synthesizeSpeechSegments(tts, 'First sentence.', {
      voice: 'af_heart',
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(returnCalled).toBe(true);
  });

  it('does not yield a stream segment that arrives after the signal has been aborted', async () => {
    const controller = new AbortController();
    let returnCalled = false;
    const tts = {
      stream() {
        return {
          async next() {
            controller.abort();
            return {
              done: false,
              value: { text: 'Late segment.', audio: createAudio(12000, 24000) },
            };
          },
          async return() {
            returnCalled = true;
            return { done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    const iterator = synthesizeSpeechSegments(tts, 'Late segment.', {
      voice: 'af_heart',
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(returnCalled).toBe(true);
  });

  it('uses Kokoro stream segments for sentence-bounded timing accuracy', async () => {
    const tts = {
      async *stream(text, options) {
        expect(text).toBe('Dot Product in Deep Learning.');
        expect(options.voice).toBe('af_heart');
        yield { text: 'Dot Product.', audio: createAudio(12000, 24000) };
        yield { text: 'In Deep Learning.', audio: createAudio(36000, 24000) };
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'Dot Product in Deep Learning.', {
      voice: 'af_heart',
    });

    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.wordTimings).toHaveLength(5);
    expect(speech.wordTimings[2].start).toBeCloseTo(0.5);
    expect(speech.wordTimings.at(-1).end).toBeCloseTo(2);
  });
});
