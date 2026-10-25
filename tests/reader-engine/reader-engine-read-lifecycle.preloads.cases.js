import { describe, expect, it } from "vitest";
import { attachAudioEventListeners, createAudioHighlightResyncLoop, cleanupAudioElement, compactCompletedPdfChunks, compactPdfChunk, createSectionReadyTransitionTracker, createReusableAudioElementPool, createManagedAudioUrl, getSpeechPreloadMaxInFlight, getSpeechPreloadWindow, pruneSpeechPreloads, queueNextSpeechPreload } from "../../src/lib/reader-engine-read-lifecycle.js";
import { getTtsPerformanceProfileConfig } from '../../src/lib/tts-performance-profile.js';
import { deferred } from '../fixtures/async-helpers.js';

describe('toolbar player read lifecycle', () => {
  it('schedules the configured high-end speech preload window', () => {
    expect(getSpeechPreloadWindow({
      currentIndex: 4,
      availableChunkCount: 10,
      preloadAhead: 2,
    })).toEqual([4, 5, 6]);
  });

  it('keeps one handoff preload even when a low-power profile disables full lookahead', () => {
    expect(getSpeechPreloadWindow({
      currentIndex: 4,
      availableChunkCount: 10,
      preloadAhead: 0,
    })).toEqual([4, 5]);
  });

  it('can defer low-power handoff preloading until the current first segment is ready', () => {
    expect(getSpeechPreloadWindow({
      currentIndex: 4,
      availableChunkCount: 10,
      preloadAhead: 0,
      minimumAhead: 0,
    })).toEqual([4]);
  });

  it('clips the speech preload window at the loaded chunk boundary', () => {
    expect(getSpeechPreloadWindow({
      currentIndex: 8,
      availableChunkCount: 10,
      preloadAhead: 3,
    })).toEqual([8, 9]);
  });

  it('starts only one missing speech preload at a time', async () => {
    const first = deferred();
    const second = deferred();
    const speechPreloads = new Map();
    const preloadState = {};
    const started = [];

    function createPreload(index) {
      started.push(index);
      return index === 4 ? first.promise : second.promise;
    }

    expect(queueNextSpeechPreload({
      indices: [4, 5, 6],
      speechPreloads,
      preloadState,
      createPreload,
    })).toMatchObject({ index: 4 });
    expect(started).toEqual([4]);
    expect(speechPreloads.has(4)).toBe(true);

    expect(queueNextSpeechPreload({
      indices: [4, 5, 6],
      speechPreloads,
      preloadState,
      createPreload,
    })).toBeNull();
    expect(started).toEqual([4]);

    first.resolve({ result: 'first' });
    await first.promise;
    await Promise.resolve();

    expect(preloadState.inFlight).toBe(false);
    expect(queueNextSpeechPreload({
      indices: [4, 5, 6],
      speechPreloads,
      preloadState,
      createPreload,
    })).toMatchObject({ index: 5 });
    expect(started).toEqual([4, 5]);
  });

  it('backs off failed speech preload indices before retrying them', async () => {
    let now = 1000;
    const speechPreloads = new Map();
    const preloadState = {};
    const started = [];
    const createPreload = (index) => {
      started.push(index);
      return Promise.resolve({ error: new Error('voice service unavailable') });
    };
    const options = {
      indices: [4],
      speechPreloads,
      preloadState,
      createPreload,
      retryBackoffMs: 500,
      getNowMs: () => now,
    };

    expect(queueNextSpeechPreload(options)).toMatchObject({ index: 4 });
    await speechPreloads.get(4);
    await Promise.resolve();

    expect(speechPreloads.has(4)).toBe(false);
    expect(queueNextSpeechPreload(options)).toBeNull();
    expect(started).toEqual([4]);

    now += 500;
    expect(queueNextSpeechPreload(options)).toMatchObject({ index: 4 });
    expect(started).toEqual([4, 4]);
  });

  it('can fill the configured speech preload lookahead concurrently', () => {
    const speechPreloads = new Map();
    const preloadState = {};
    const started = [];

    const firstStarted = queueNextSpeechPreload({
      indices: [4, 5, 6],
      speechPreloads,
      preloadState,
      maxInFlight: 3,
      createPreload(index) {
        started.push(index);
        return Promise.resolve({ result: index });
      },
    });

    expect(firstStarted).toMatchObject({ index: 4 });
    expect(started).toEqual([4, 5, 6]);
    expect([...speechPreloads.keys()]).toEqual([4, 5, 6]);
    expect(preloadState.inFlight).toBe(true);
    expect(preloadState.inFlightCount).toBe(3);
  });

  it('lets progressive playback overlap the next section preload when lookahead is configured', () => {
    expect(getSpeechPreloadMaxInFlight({
      preloadAhead: 1,
      minimumAhead: 0,
      progressiveSegments: true,
    })).toBe(2);
    expect(getSpeechPreloadMaxInFlight({
      preloadAhead: 2,
      minimumAhead: 1,
      progressiveSegments: false,
    })).toBe(3);
    expect(getSpeechPreloadMaxInFlight({
      preloadAhead: 1,
      minimumAhead: 3,
      progressiveSegments: false,
    })).toBe(4);
    expect(getSpeechPreloadMaxInFlight({
      preloadAhead: -1,
      minimumAhead: -1,
      progressiveSegments: false,
    })).toBe(1);
  });

  it('keeps two progressive low-power handoff sections queued', () => {
    const lowPower = getTtsPerformanceProfileConfig('lowPower');

    expect(getSpeechPreloadWindow({
      currentIndex: 4,
      availableChunkCount: 10,
      preloadAhead: lowPower.preloadAhead,
      minimumAhead: 0,
    })).toEqual([4, 5, 6]);
    expect(getSpeechPreloadMaxInFlight({
      preloadAhead: lowPower.preloadAhead,
      minimumAhead: 0,
      progressiveSegments: lowPower.progressiveSegments,
    })).toBe(3);
  });

  it('records adjacent section-ready transitions even when preloads finish out of order', () => {
    const transitions = [];
    const tracker = createSectionReadyTransitionTracker({
      onTransition: (transition) => transitions.push(transition),
    });

    tracker.recordSectionReady({ sectionIndex: 0, readyAtMs: 100 });
    tracker.recordSectionReady({ sectionIndex: 2, readyAtMs: 2600 });
    tracker.recordSectionReady({ sectionIndex: 1, readyAtMs: 900 });
    tracker.recordSectionReady({ sectionIndex: 1, readyAtMs: 900 });

    expect(transitions).toEqual([
      {
        fromSectionIndex: 0,
        toSectionIndex: 1,
        nextSectionReadyGapMs: 800,
      },
      {
        fromSectionIndex: 1,
        toSectionIndex: 2,
        nextSectionReadyGapMs: 1700,
      },
    ]);
  });

  it('prioritizes the current chunk when a stale preload is still in flight', () => {
    const stale = deferred();
    const current = deferred();
    const speechPreloads = new Map([[4, stale.promise]]);
    const preloadState = { inFlight: true };
    const started = [];

    expect(queueNextSpeechPreload({
      indices: [5, 6],
      speechPreloads,
      preloadState,
      createPreload(index) {
        started.push(index);
        return current.promise;
      },
    })).toMatchObject({ index: 5 });

    expect(started).toEqual([5]);
    expect(speechPreloads.get(5)).toBe(current.promise);
  });

  it('compacts completed PDF chunks into bounded history metadata', () => {
    const speech = `${'word '.repeat(60)}final sentence`;
    const compact = compactPdfChunk({
      type: 'pdf-page',
      speech,
      text: speech,
      pageNumber: 12,
      anchorId: 'pdf-page-12',
      domWordOffset: 30,
    });

    expect(compact).toEqual({
      type: 'pdf-page',
      pageNumber: 12,
      anchorId: 'pdf-page-12',
      domWordOffset: 30,
      wordCount: 62,
      preview: expect.stringMatching(/^word word/),
      compact: true,
    });
    expect(compact.preview.length).toBeLessThanOrEqual(220);
    expect(compact).not.toHaveProperty('speech');
    expect(compact).not.toHaveProperty('text');
  });

  it('keeps only the current PDF playback neighborhood as full chunks after the history limit', () => {
    const chunks = Array.from({ length: 252 }, (_, index) => ({
      type: 'pdf-page',
      speech: `Page ${index + 1} full speech text.`,
      text: `Page ${index + 1} full speech text.`,
      pageNumber: index + 1,
      anchorId: `pdf-page-${index + 1}`,
    }));

    const compacted = compactCompletedPdfChunks(chunks, {
      source: 'pdf',
      currentIndex: 251,
      keepFullChunkHistoryLimit: 250,
      keepFullFromIndex: 250,
    });

    expect(compacted).toHaveLength(252);
    expect(compacted[0]).toMatchObject({
      compact: true,
      preview: 'Page 1 full speech text.',
      pageNumber: 1,
      anchorId: 'pdf-page-1',
      wordCount: 5,
    });
    expect(compacted[249]).toMatchObject({ compact: true, pageNumber: 250 });
    expect(compacted[250]).toEqual(chunks[250]);
    expect(compacted[251]).toEqual(chunks[251]);
  });

  it('does not compact normal webpage chunk history', () => {
    const chunks = Array.from({ length: 300 }, (_, index) => `Section ${index + 1}`);

    expect(compactCompletedPdfChunks(chunks, {
      source: 'reading-model',
      currentIndex: 299,
      keepFullChunkHistoryLimit: 250,
    })).toBe(chunks);
  });

  it('revokes managed audio object URLs at most once', () => {
    const calls = [];
    const managed = createManagedAudioUrl(new Blob(['audio']), {
      urlApi: {
        createObjectURL(blob) {
          calls.push(['create', blob]);
          return 'blob:test-audio';
        },
        revokeObjectURL(url) {
          calls.push(['revoke', url]);
        },
      },
    });

    expect(managed.url).toBe('blob:test-audio');
    managed.revoke();
    managed.revoke();

    expect(calls.map(([name, value]) => [name, typeof value === 'string' ? value : value.constructor.name])).toEqual([
      ['create', 'Blob'],
      ['revoke', 'blob:test-audio'],
    ]);
  });

  it('clears audio element sources during playback cleanup', () => {
    const calls = [];
    const audio = {
      onended: () => {},
      onerror: () => {},
      pause: () => calls.push('pause'),
      removeAttribute: (name) => calls.push(`remove:${name}`),
      load: () => calls.push('load'),
    };

    cleanupAudioElement(audio);

    expect(calls).toEqual(['pause', 'remove:src', 'load']);
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
  });

  it('removes registered audio listeners during playback cleanup', () => {
    const audio = new EventTarget();
    const events = [];
    const cleanup = attachAudioEventListeners(audio, {
      play: () => events.push('play'),
      pause: () => events.push('pause'),
    });

    audio.dispatchEvent(new Event('play'));
    cleanup();
    audio.dispatchEvent(new Event('pause'));
    audio.dispatchEvent(new Event('play'));

    expect(events).toEqual(['play']);
  });

  it('drives audio highlight resync from animation frames while playback is active', () => {
    const frames = [];
    const canceled = [];
    const resyncs = [];
    let nextFrameId = 0;
    const audio = { paused: false };
    const loop = createAudioHighlightResyncLoop({
      audio,
      onResync: () => resyncs.push('resync'),
      requestFrame(callback) {
        const id = ++nextFrameId;
        frames.push({ id, callback });
        return id;
      },
      cancelFrame(id) {
        canceled.push(id);
      },
    });

    loop.start();
    expect(frames).toHaveLength(1);
    frames.shift().callback();
    expect(resyncs).toEqual(['resync']);
    expect(frames).toHaveLength(1);

    audio.paused = true;
    frames.shift().callback();
    expect(resyncs).toEqual(['resync']);
    expect(frames).toHaveLength(0);

    audio.paused = false;
    loop.start();
    expect(frames).toHaveLength(1);
    loop.stop();
    expect(canceled).toEqual([3]);
  });

  it('reuses one audio element while swapping managed blob URLs', () => {
    const created = [];
    const pool = createReusableAudioElementPool({
      createAudio() {
        const audio = {
          src: '',
          pause() {},
          removeAttribute(name) {
            if (name === 'src') this.src = '';
          },
          load() {},
        };
        created.push(audio);
        return audio;
      },
    });

    const first = pool.acquire('blob:first');
    const second = pool.acquire('blob:second');

    expect(first).toBe(second);
    expect(first.src).toBe('blob:second');
    expect(created).toHaveLength(1);
  });

  it('can destroy the reusable audio element for full dormancy teardown', () => {
    const created = [];
    const pool = createReusableAudioElementPool({
      createAudio() {
        const audio = {
          src: '',
          pause() {},
          removeAttribute(name) {
            if (name === 'src') this.src = '';
          },
          load() {},
        };
        created.push(audio);
        return audio;
      },
    });

    const first = pool.acquire('blob:first');
    pool.destroy();
    const second = pool.acquire('blob:second');

    expect(first.src).toBe('');
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it('prunes stale speech preloads before queuing more work', () => {
    const speechPreloads = new Map([
      [3, Promise.resolve('old')],
      [4, Promise.resolve('current')],
      [5, Promise.resolve('next')],
      [7, Promise.resolve('outside-window')],
    ]);
    const queuedHighlightIndices = new Set([3, 5, 7]);

    pruneSpeechPreloads({
      speechPreloads,
      queuedHighlightIndices,
      activeIndices: [4, 5],
      currentIndex: 4,
    });

    expect([...speechPreloads.keys()]).toEqual([4, 5]);
    expect([...queuedHighlightIndices]).toEqual([5]);
  });

  it('returns progressive segment iterators when stale preloads are pruned', async () => {
    const returned = [];
    const speechPreloads = new Map([
      [3, Promise.resolve({
        result: {
          kind: 'segments',
          segments: {
            async return() {
              returned.push(3);
              return { done: true, value: undefined };
            },
          },
        },
      })],
      [4, Promise.resolve('current')],
    ]);

    pruneSpeechPreloads({
      speechPreloads,
      activeIndices: [4],
      currentIndex: 4,
    });
    await Promise.resolve();

    expect(returned).toEqual([3]);
    expect([...speechPreloads.keys()]).toEqual([4]);
  });
});
