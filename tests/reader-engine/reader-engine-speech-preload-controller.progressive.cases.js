import { createController } from './reader-engine-speech-preload-controller.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readerEngine speech preload controller', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stores first progressive Kokoro segment metrics on the preload wrapper', async () => {
    let now = 1000;
    async function* segments() {
      yield {
        text: 'hello',
        audio: {
          audio: new Float32Array(20),
          sampling_rate: 10,
        },
      };
    }
    const firstSynthesis = [];
    const controller = createController({
      state: {
        activeChunks: [{ speech: 'hello' }],
        tts: { stream: () => segments() },
      },
      getNowMs: () => {
        now += 2000;
        return now;
      },
      getActiveTtsProfileConfig: () => ({ preloadAhead: 1, progressiveSegments: true }),
      resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
      recordFirstSynthesis: (metrics) => firstSynthesis.push(metrics),
    });

    const preload = controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart', detectCode: 'en' },
      { speech: 'hello' },
      { sectionIndex: 3 },
    );
    const speech = await controller.readPreloadedSpeech(preload);

    expect(firstSynthesis).toHaveLength(1);
    expect(speech).toMatchObject({
      kind: 'segments',
      synthesisMetrics: {
        synthesisMs: 2000,
        audioDurationSeconds: 2,
      realTimeFactor: 1,
      },
    });
  });

  it('passes a split pattern to progressive Kokoro streams so PDF chunks can start early', async () => {
    const stream = vi.fn(async function* streamSpeech(_text, _options) {
      yield {
        text: 'Can AI Agents Answer Your Data Questions?',
        audio: {
          audio: new Float32Array(20),
          sampling_rate: 10,
        },
      };
    });
    const controller = createController({
      state: {
        activeChunks: [{ speech: 'Can AI Agents Answer Your Data Questions? A Benchmark for Data Agents.' }],
        tts: { stream },
      },
      getActiveTtsProfileConfig: () => ({ preloadAhead: 1, progressiveSegments: true }),
      resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
    });

    const preload = controller.createSpeechPreloadForVoice(
      { engine: 'kokoro', id: 'af_heart', detectCode: 'en' },
      { speech: 'Can AI Agents Answer Your Data Questions? A Benchmark for Data Agents.' },
      { sectionIndex: 1 },
    );

    await controller.readPreloadedSpeech(preload);

    const [, options] = stream.mock.calls[0];
    expect(options).toMatchObject({
      voice: 'af_heart',
      split_pattern: expect.any(RegExp),
    });
    expect('Can AI Agents Answer Your Data Questions? A Benchmark for Data Agents.'.split(options.split_pattern))
      .toEqual(['Can AI Agents Answer Your Data Questions?', 'A Benchmark for Data Agents.']);
    expect('However, building reliable data agents remains difficult.'.split(options.split_pattern))
      .toEqual(['However,', 'building reliable data agents remains difficult.']);
  });

  it('does not let a stale settled preload restore an older preload window', async () => {
    const pending = new Map();
    const started = [];
    const controller = createController({
      state: {
        activeChunks: [
          { speech: 'zero' },
          { speech: 'one' },
          { speech: 'two' },
        ],
        tts: {
          generate: async (text) => {
            started.push(text);
            let release;
            const promise = new Promise((resolve) => { release = resolve; });
            pending.set(text, { promise, release });
            return promise;
          },
        },
      },
    });
    const selectedVoice = {
      engine: 'kokoro',
      id: 'af_heart',
      detectCode: 'en',
    };
    const speechPreloads = new Map();
    const preloadState = {};
    const queuedHighlightIndices = new Set();
    const baseWindow = {
      speechPreloads,
      queuedHighlightIndices,
      selectedVoice,
      syncPageHighlights: false,
      tabId: 3,
      minimumAhead: 1,
      preloadState,
      runId: 1,
    };

    controller.ensureSpeechPreloadWindow({ ...baseWindow, currentIndex: 0 });
    await Promise.resolve();
    expect(started).toEqual(['zero', 'one']);
    const staleZeroPreload = speechPreloads.get(0);

    controller.ensureSpeechPreloadWindow({ ...baseWindow, currentIndex: 1 });
    expect([...speechPreloads.keys()]).toEqual([1]);

    pending.get('zero').release({ audio: new Float32Array(24), sampling_rate: 24 });
    await staleZeroPreload;
    await Promise.resolve();
    await Promise.resolve();

    expect(started.filter((text) => text === 'zero')).toHaveLength(1);
    expect([...speechPreloads.keys()]).toEqual([1, 2]);
  });
});
