import { createAudio } from "./speech-audio.fixtures.js";
import { describe, expect, it, vi } from 'vitest';
import { createAlignedWordTimings, estimateWordTimings, getGeneratedSpeechTimeoutMs, synthesizeSpeechChunk, synthesizeSpeechSegments } from "../../src/lib/speech-audio.js";

describe('speech audio synthesis', () => {
  it('returns deterministic silent test audio when the silent TTS flag is enabled', async () => {
    const speech = await synthesizeSpeechChunk({
      async generate() {
        throw new Error('real synthesis should not run in silent test mode');
      },
    }, 'One two three.', {
      testSilentTts: true,
    });

    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.durationSeconds).toBeCloseTo(3 * 0.06);
    expect(speech.wordTimings.map((timing) => timing.text)).toEqual(['One', 'two', 'three']);
    expect(speech.wordTimings[0].start).toBe(0);
    expect(speech.wordTimings.at(-1).end).toBeCloseTo(speech.durationSeconds);
  });

  it('emits a silent test segment without requiring a loaded TTS engine', async () => {
    const segments = [];
    for await (const segment of synthesizeSpeechSegments(null, 'One two.', { testSilentTts: true })) {
      segments.push(segment);
    }

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('One two.');
    expect(segments[0].speechWordOffset).toBe(0);
    expect(segments[0].durationSeconds).toBeCloseTo(2 * 0.06);
    expect(segments[0].wordTimings.map((timing) => timing.text)).toEqual(['One', 'two']);
  });

  it('retries a failed generated synthesis once as smaller batches before surfacing failure', async () => {
    const calls = [];
    const tts = {
      async generate(text) {
        calls.push(text);
        if (calls.length === 1) throw new Error('batch too large');
        return createAudio(text.length * 1200, 24000);
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'First sentence. Second sentence.', {
      voice: 'af_heart',
    });

    expect(calls).toEqual([
      'First sentence. Second sentence.',
      'First sentence.',
      'Second sentence.',
    ]);
    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.wordTimings.map((timing) => timing.text)).toEqual([
      'First',
      'sentence',
      'Second',
      'sentence',
    ]);
  });

  it('uses engine-provided word timestamps before falling back to estimates', async () => {
    const tts = {
      async *stream() {
        yield {
          text: 'Measured timing.',
          audio: createAudio(24000, 24000),
          wordTimings: [
            { text: 'Measured', start: 0.04, end: 0.32, confidence: 0.97 },
            { text: 'timing.', start: 0.36, end: 0.74, confidence: 0.95 },
          ],
        };
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'Measured timing.', {
      voice: 'af_heart',
    });

    expect(speech.wordTimings).toEqual([
      {
        text: 'Measured',
        start: 0.04,
        end: 0.32,
        confidence: 0.97,
        source: 'aligned',
      },
      {
        text: 'timing',
        start: 0.36,
        end: 0.74,
        confidence: 0.95,
        source: 'aligned',
      },
    ]);
  });

  it('reconciles provider word timestamps when English punctuation changes token counts', () => {
    const timings = createAlignedWordTimings("U.S. teams don't re-enter well-known 3.14 markets.", 3, {
      wordTimings: [
        { text: 'U.S', start: 0.02, end: 0.18, confidence: 0.96 },
        { text: '.', start: 0.18, end: 0.2, confidence: 0.96 },
        { text: 'teams', start: 0.24, end: 0.52, confidence: 0.95 },
        { text: 'do', start: 0.58, end: 0.7, confidence: 0.94 },
        { text: "n't", start: 0.7, end: 0.82, confidence: 0.94 },
        { text: 're', start: 0.9, end: 1.02, confidence: 0.93 },
        { text: '-', start: 1.02, end: 1.04, confidence: 0.93 },
        { text: 'enter', start: 1.04, end: 1.26, confidence: 0.93 },
        { text: 'well', start: 1.34, end: 1.52, confidence: 0.92 },
        { text: 'known', start: 1.54, end: 1.78, confidence: 0.92 },
        { text: '3.14', start: 1.9, end: 2.18, confidence: 0.91 },
        { text: 'markets', start: 2.28, end: 2.7, confidence: 0.9 },
      ],
    });

    expect(timings.map((timing) => timing.text)).toEqual([
      'U.S',
      'teams',
      "don't",
      're-enter',
      'well-known',
      '3.14',
      'markets',
    ]);
    expect(timings.every((timing) => timing.source === 'aligned')).toBe(true);
    expect(timings[0]).toMatchObject({ start: 0.02, end: 0.18 });
    expect(timings[2]).toMatchObject({ start: 0.58, end: 0.82 });
    expect(timings[3]).toMatchObject({ start: 0.9, end: 1.26 });
    expect(timings[4]).toMatchObject({ start: 1.34, end: 1.78 });
    for (let index = 1; index < timings.length; index += 1) {
      expect(timings[index].start).toBeGreaterThanOrEqual(timings[index - 1].end);
    }
  });

  it('keeps provider timings when the engine emits standalone punctuation boundaries', () => {
    const timings = createAlignedWordTimings('Hello, world.', 1, {
      wordTimings: [
        { text: 'Hello', start: 0.02, end: 0.22, confidence: 0.96 },
        { text: ',', start: 0.22, end: 0.25, confidence: 0.96 },
        { text: 'world', start: 0.35, end: 0.7, confidence: 0.95 },
        { text: '.', start: 0.7, end: 0.72, confidence: 0.95 },
      ],
    });

    expect(timings).toEqual([
      {
        text: 'Hello',
        start: 0.02,
        end: 0.22,
        confidence: 0.96,
        source: 'aligned',
      },
      {
        text: 'world',
        start: 0.35,
        end: 0.7,
        confidence: 0.95,
        source: 'aligned',
      },
    ]);
  });

  it('marks estimated timings as fallback alignment data', () => {
    const timings = estimateWordTimings('Fallback timing', 1.2);

    expect(timings).toEqual([
      expect.objectContaining({
        text: 'Fallback',
        start: 0,
        confidence: 0.35,
        source: 'estimated',
      }),
      expect.objectContaining({
        text: 'timing',
        confidence: 0.35,
        source: 'estimated',
      }),
    ]);
  });

  it('falls back to bounded generation when Kokoro streaming is unavailable', async () => {
    const tts = {
      async generate(text, options) {
        return createAudio(text.length, (options.speed || 1) * 24000);
      },
    };

    const speech = await synthesizeSpeechChunk(tts, 'Dot Product in Deep Learning.', {
      voice: 'af_heart',
    });

    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.wordTimings).toHaveLength(5);
    expect(speech.wordTimings.at(-1).end).toBeCloseTo(29 / 24000);
  });

  it('does not start generated synthesis when the signal is already aborted', async () => {
    const controller = new AbortController();
    const calls = [];
    const tts = {
      async generate(text) {
        calls.push(text);
        return createAudio(text.length, 24000);
      },
    };
    controller.abort();

    await expect(synthesizeSpeechChunk(tts, 'Abort before synthesis.', {
      voice: 'af_heart',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('keeps aborted generated synthesis owned until the underlying engine call settles', async () => {
    const controller = new AbortController();
    let releaseGenerate;
    let settled = false;
    const tts = {
      async generate() {
        await new Promise((resolve) => {
          releaseGenerate = resolve;
        });
        return createAudio(24000, 24000);
      },
    };

    const pending = synthesizeSpeechChunk(tts, 'Stop should not free a running WASM call.', {
      voice: 'af_heart',
      signal: controller.signal,
    });
    pending.finally(() => {
      settled = true;
    }).catch(() => null);

    await vi.waitFor(() => {
      expect(releaseGenerate).toEqual(expect.any(Function));
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);

    releaseGenerate();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(settled).toBe(true);
  });

  it('does not serialize generated synthesis for one shared TTS instance', async () => {
    let activeGenerateCalls = 0;
    let maxActiveGenerateCalls = 0;
    const releaseCalls = [];
    const tts = {
      async generate(text) {
        activeGenerateCalls += 1;
        maxActiveGenerateCalls = Math.max(maxActiveGenerateCalls, activeGenerateCalls);
        await new Promise((resolve) => releaseCalls.push(resolve));
        activeGenerateCalls -= 1;
        return createAudio(text.length, 24000);
      },
    };

    const first = synthesizeSpeechChunk(tts, 'First generated chunk.', { voice: 'af_heart' });
    const second = synthesizeSpeechChunk(tts, 'Second generated chunk.', { voice: 'af_heart' });

    await vi.waitFor(() => {
      expect(releaseCalls).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseCalls).toHaveLength(2);
    expect(maxActiveGenerateCalls).toBe(2);

    releaseCalls[0]();
    releaseCalls[1]();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maxActiveGenerateCalls).toBe(2);
  });

  it('starts split generated synthesis halves in parallel on one shared TTS instance', async () => {
    const started = [];
    let releaseLeft;
    let releaseRight;
    const tts = {
      calls: 0,
      async generate(text) {
        this.calls += 1;
        started.push(text);
        if (this.calls === 1) {
          return createAudio(2400, 24000);
        }
        if (this.calls === 2) {
          await new Promise((resolve) => {
            releaseLeft = resolve;
          });
        } else {
          await new Promise((resolve) => {
            releaseRight = resolve;
          });
        }
        return createAudio(text.length * 1200, 24000);
      },
    };

    const text = 'This chunk is long enough that one tenth of a second is suspiciously short for speech.';
    const speech = synthesizeSpeechChunk(tts, text, {
      voice: 'af_heart',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(3);

    releaseLeft();
    releaseRight();
    await expect(speech).resolves.toMatchObject({
      blob: expect.any(Blob),
      wordTimings: expect.any(Array),
    });
  });

  it('falls back to bounded generation when Kokoro streaming does not close promptly', async () => {
    let returnCalled = false;
    const tts = {
      async generate(text) {
        return createAudio(text.length, 24000);
      },
      stream() {
        return {
          async next() {
            await new Promise(() => {});
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

    const speech = await synthesizeSpeechChunk(tts, 'Dot Product in Deep Learning.', {
      voice: 'af_heart',
      streamTimeoutMs: 5,
    });

    expect(returnCalled).toBe(true);
    expect(speech.blob).toBeInstanceOf(Blob);
    expect(speech.wordTimings).toHaveLength(5);
    expect(speech.wordTimings.at(-1).end).toBeCloseTo(29 / 24000);
  });

  it('keeps generated-speech timeout proportional to chunk length', () => {
    expect(getGeneratedSpeechTimeoutMs('A')).toBeGreaterThan(0);
    expect(getGeneratedSpeechTimeoutMs('A')).toBeLessThan(getGeneratedSpeechTimeoutMs(
      'This is a much longer generated speech chunk that should get more time.',
    ));
  });

  it('gives high-quality article chunks enough generated-speech time for first-run synthesis', () => {
    expect(getGeneratedSpeechTimeoutMs('a'.repeat(480))).toBe(60_000);
  });

  it('times out stalled generated speech synthesis before it can wedge the queue', async () => {
    vi.useFakeTimers();
    const tts = {
      async generate() {
        return new Promise(() => {});
      },
    };

    const pending = synthesizeSpeechChunk(tts, 'A', {
      voice: 'af_heart',
    });

    await Promise.resolve();
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'generated_speech_timeout',
      message: 'Generated speech did not finish promptly.',
    });
    await vi.advanceTimersByTimeAsync(getGeneratedSpeechTimeoutMs('A'));
    await timeoutAssertion;
  });
});
