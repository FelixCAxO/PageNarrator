import { createController } from './reader-engine-speech-preload-controller.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STREAM_SYNTHESIS_TIMEOUT_MS } from '../../src/lib/timing-config.js';
import { getTtsPerformanceProfileConfig } from '../../src/lib/tts-performance-profile.js';

describe('readerEngine speech preload controller', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('attaches an audio-ready promise to generated preload results before handoff can use them', async () => {
    let releaseDecode;
    const decodeGate = new Promise((resolve) => {
      releaseDecode = resolve;
    });
    const controller = createController({
      state: { testSilentTtsEnabled: true },
      prepareGeneratedAudioForPlayback: async (speech, { sectionIndex }) => {
        await decodeGate;
        return {
          sectionIndex,
          decodeLatencyMs: 42,
          readyState: 3,
          speech,
        };
      },
    });

    const preload = controller.createSpeechPreloadForVoice(
      {
        engine: 'kokoro',
        id: 'af_heart',
        detectCode: 'en',
      },
      { speech: 'hello' },
      { sectionIndex: 7 },
    );
    const entry = await preload;

    expect(entry.result.result.audioReady).toBeInstanceOf(Promise);
    let settled = false;
    const ready = entry.result.result.audioReady.then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDecode();
    await expect(ready).resolves.toMatchObject({
      sectionIndex: 7,
      decodeLatencyMs: 42,
      readyState: 3,
    });
  });

  it('times out stalled first-segment readiness before the current chunk can deadlock', async () => {
    vi.useFakeTimers();
    const controller = createController();
    const preload = Promise.resolve({
      result: {
        kind: 'segments',
        firstSegmentReady: new Promise(() => {}),
        segments: {},
      },
    });

    const pending = controller.readPreloadedSpeech(preload);

    await Promise.resolve();
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'speech_preload_timeout',
      message: `Speech preload did not become ready within ${STREAM_SYNTHESIS_TIMEOUT_MS} ms.`,
    });
    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS);
    await timeoutAssertion;
  });

  it('times out a generated speech preload that never resolves', async () => {
    vi.useFakeTimers();
    const controller = createController();
    const preload = new Promise(() => {});

    const pending = controller.readPreloadedSpeech(preload);
    let rejection = null;
    pending.catch((error) => {
      rejection = error;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS);
    await Promise.resolve();

    expect(rejection).toMatchObject({
      code: 'speech_preload_timeout',
      message: `Speech preload did not become ready within ${STREAM_SYNTHESIS_TIMEOUT_MS} ms.`,
    });
  });

  it('waits past the streaming handoff timeout when the profile supplies an extended preload timeout', async () => {
    vi.useFakeTimers();
    const controller = createController({
      getActiveTtsProfileConfig: () => ({
        profile: 'lowPower',
        preloadAhead: 1,
        progressiveSegments: true,
        speechPreloadTimeoutMs: 60_000,
      }),
    });
    let release;
    const preload = new Promise((resolve) => {
      release = () => resolve({ result: { kind: 'segments', firstSegmentReady: Promise.resolve(), segments: {} } });
    });

    const pending = controller.readPreloadedSpeech(preload);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS + 250);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('waits past the streaming handoff timeout for high-quality generated speech preloads', async () => {
    vi.useFakeTimers();
    const controller = createController({
      getActiveTtsProfileConfig: () => getTtsPerformanceProfileConfig('quality'),
    });
    let release;
    const preload = new Promise((resolve) => {
      release = () => resolve({
        result: {
          blob: new Blob(['audio']),
          wordTimings: [],
        },
      });
    });

    const pending = controller.readPreloadedSpeech(preload);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS + 250);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      blob: expect.any(Blob),
      wordTimings: [],
    });
  });

  it('lets high-quality generated speech use the full synthesis timeout before surfacing a preload timeout', async () => {
    vi.useFakeTimers();
    const quality = getTtsPerformanceProfileConfig('quality');
    expect(quality.speechPreloadTimeoutMs).toBe(60_000);
    const controller = createController({
      getActiveTtsProfileConfig: () => quality,
    });
    const preload = new Promise(() => {});

    const pending = controller.readPreloadedSpeech(preload);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS + 250);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000 - STREAM_SYNTHESIS_TIMEOUT_MS - 251);
    await Promise.resolve();
    expect(settled).toBe(false);

    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'speech_preload_timeout',
      message: 'Speech preload did not become ready within 60000 ms.',
    });
    await vi.advanceTimersByTimeAsync(1);
    await timeoutAssertion;
  });

  it('aborts stalled decode readiness when the read signal stops', async () => {
    const controller = createController();
    const signal = new AbortController();
    const preload = Promise.resolve({
      result: {
        blob: new Blob(['audio']),
        wordTimings: [],
        firstSegmentReady: Promise.resolve(),
        audioReady: new Promise(() => {}),
      },
    });

    const pending = controller.readPreloadedSpeech(preload, { signal: signal.signal });

    await Promise.resolve();
    await Promise.resolve();
    signal.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out stalled audio prewarm and releases the unused prepared element', async () => {
    vi.useFakeTimers();
    const revoked = [];
    class StalledAudio {
      constructor(src) {
        this.src = src;
        this.readyState = 0;
        this.preload = '';
      }

      addEventListener() {}
      removeEventListener() {}
      pause = vi.fn();
      load = vi.fn();
      removeAttribute(name) {
        if (name === 'src') this.src = '';
      }
    }
    vi.stubGlobal('Audio', StalledAudio);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:stalled-prewarm',
      revokeObjectURL: (url) => revoked.push(url),
    });

    const controller = createController({
      state: { testSilentTtsEnabled: true },
    });

    const preload = controller.createSpeechPreloadForVoice(
      {
        engine: 'kokoro',
        id: 'af_heart',
        detectCode: 'en',
      },
      { speech: 'hello' },
      { sectionIndex: 9 },
    );
    const entry = await preload;
    let settled = false;
    const ready = entry.result.result.audioReady.then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(250);

    await expect(ready).resolves.toMatchObject({
      sectionIndex: 9,
      readyState: 0,
    });
    expect(settled).toBe(true);
    expect(entry.result.result.preparedAudio).toBeUndefined();
    expect(revoked).toEqual(['blob:stalled-prewarm']);
  });
});
