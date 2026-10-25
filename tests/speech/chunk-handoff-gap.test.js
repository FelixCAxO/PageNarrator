import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSpeechPreloadWindow,
  waitForSpeechPreloadReady,
} from '../../src/lib/reader-engine-read-lifecycle.js';
import { getTtsPerformanceProfileConfig } from '../../src/lib/tts-performance-profile.js';

describe('chunk handoff gap controls', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps two sections ready for normal profiles so the next chunk can start inside one frame', () => {
    expect(getSpeechPreloadWindow({
      currentIndex: 7,
      availableChunkCount: 20,
      preloadAhead: 1,
      minimumAhead: 2,
    })).toEqual([7, 8, 9]);
  });

  it('keeps a deeper generated-audio window for fast quality reads', () => {
    const quality = getTtsPerformanceProfileConfig('quality');

    expect(getSpeechPreloadWindow({
      currentIndex: 7,
      availableChunkCount: 20,
      preloadAhead: quality.preloadAhead,
      minimumAhead: quality.preloadAhead,
    })).toEqual([7, 8, 9, 10, 11]);
  });

  it('blocks handoff resolution until the next speech preload is ready', async () => {
    let resolveNext;
    const nextReady = new Promise((resolve) => {
      resolveNext = resolve;
    });
    const speechPreloads = new Map([
      [3, Promise.resolve({ result: { kind: 'chunk', result: 'current' } })],
      [4, nextReady],
    ]);

    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 4,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveNext({ result: { kind: 'chunk', result: 'next' } });
    await expect(wait).resolves.toEqual({ ok: true });
    expect(settled).toBe(true);
  });

  it('reports a failed mandatory preload instead of resolving as ready', async () => {
    const speechPreloads = new Map([
      [2, Promise.resolve({ error: new Error('synthesis failed') })],
    ]);

    await expect(waitForSpeechPreloadReady({
      speechPreloads,
      index: 2,
    })).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('blocks handoff readiness until the next preloaded audio is decode-ready', async () => {
    let resolveAudioReady;
    const audioReady = new Promise((resolve) => {
      resolveAudioReady = resolve;
    });
    const speechPreloads = new Map([
      [4, Promise.resolve({
        result: {
          blob: new Blob(['audio']),
          wordTimings: [],
          audioReady,
        },
      })],
    ]);

    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 4,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAudioReady({ decodeLatencyMs: 31, readyState: 3 });
    await expect(wait).resolves.toEqual({ ok: true });
    expect(settled).toBe(true);
  });

  it('returns decoded prepared audio with handoff readiness so playback can prestart it', async () => {
    const preparedAudio = {
      audio: { play() {} },
      managedUrl: { url: 'blob:next-audio', revoke() {} },
    };
    const speechPreloads = new Map([
      [4, Promise.resolve({
        result: {
          blob: new Blob(['audio']),
          wordTimings: [],
          audioReady: Promise.resolve({ decodeLatencyMs: 18, readyState: 3 }),
          preparedAudio,
        },
      })],
    ]);

    await expect(waitForSpeechPreloadReady({
      speechPreloads,
      index: 4,
    })).resolves.toEqual({
      ok: true,
      preparedAudio,
    });
  });

  it('blocks progressive handoff readiness until the next first segment is ready', async () => {
    let resolveFirstSegmentReady;
    const firstSegmentReady = new Promise((resolve) => {
      resolveFirstSegmentReady = resolve;
    });
    const speechPreloads = new Map([
      [5, Promise.resolve({
        result: {
          kind: 'segments',
          firstSegmentReady,
          segments: {},
        },
      })],
    ]);

    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 5,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFirstSegmentReady();
    await expect(wait).resolves.toEqual({ ok: true });
    expect(settled).toBe(true);
  });

  it('stops waiting for progressive handoff readiness when the read aborts', async () => {
    const controller = new AbortController();
    const firstSegmentReady = new Promise(() => {});
    const speechPreloads = new Map([
      [5, Promise.resolve({
        result: {
          kind: 'segments',
          firstSegmentReady,
          segments: {},
        },
      })],
    ]);

    let settled = false;
    let result = null;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 5,
      signal: controller.signal,
    }).then((value) => {
      settled = true;
      result = value;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'aborted' });
    await expect(wait).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('stops waiting when an in-flight preload itself never settles', async () => {
    const controller = new AbortController();
    const speechPreloads = new Map([[5, new Promise(() => {})]]);
    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 5,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(wait).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('bounds progressive handoff readiness when the first segment never arrives', async () => {
    vi.useFakeTimers();
    const firstSegmentReady = new Promise(() => {});
    const speechPreloads = new Map([
      [5, Promise.resolve({
        result: {
          kind: 'segments',
          firstSegmentReady,
          segments: {},
        },
      })],
    ]);

    let result = null;
    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 5,
      firstSegmentReadyTimeoutMs: 25,
    }).then((value) => {
      result = value;
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'failed' });
    await expect(wait).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('blocks handoff readiness for wrapped generated chunk payloads until audio is decode-ready', async () => {
    let resolveAudioReady;
    const audioReady = new Promise((resolve) => {
      resolveAudioReady = resolve;
    });
    const speechPreloads = new Map([
      [8, Promise.resolve({
        result: {
          kind: 'chunk',
          result: {
            blob: new Blob(['audio']),
            wordTimings: [],
            audioReady,
          },
        },
      })],
    ]);

    let settled = false;
    const wait = waitForSpeechPreloadReady({
      speechPreloads,
      index: 8,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAudioReady({ decodeLatencyMs: 22, readyState: 3 });
    await expect(wait).resolves.toEqual({ ok: true });
    expect(settled).toBe(true);
  });

  it('summarizes decode latency so flow tests can fail before handoff gaps regress', async () => {
    const { buildCorpusFlowReport } = await import('../e2e/corpus-flow-invariants.js');
    const report = buildCorpusFlowReport({
      readerEngineLog: [
        { kind: 'chunks_extracted', totalChunks: 3 },
        { kind: 'audio_decode_latency', channel: 'decode_latency', chunkIndex: 0, decodeLatencyMs: 12 },
        { kind: 'audio_decode_latency', channel: 'decode_latency', chunkIndex: 1, decodeLatencyMs: 49 },
        { kind: 'audio_decode_latency', channel: 'decode_latency', chunkIndex: 2, decodeLatencyMs: 81 },
      ],
    });

    expect(report.decodeLatencyP95Ms).toBe(81);
  });
});
