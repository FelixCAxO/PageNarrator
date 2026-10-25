import { describe, expect, it } from 'vitest';
import {
  createAudioProgressProbeObserver,
  createTtsHardwareProbeRecorder,
  getProbeRealTimeFactor,
} from '../../src/lib/tts-hardware-probe.js';

describe('TTS hardware probe recorder', () => {
  it('records backend, model load, synthesis, and model fallback metrics in the probe result', () => {
    let now = 100;
    const recorder = createTtsHardwareProbeRecorder({ now: () => now });

    recorder.recordBackendPlan({
      device: 'webgpu',
      dtype: 'fp32',
      reason: 'fast-webgpu',
      cpuBudgetTarget: false,
    });
    recorder.recordModelLoad({ loadMs: 1234 });
    recorder.recordFirstSynthesis({
      synthesisMs: 640,
      audioDurationSeconds: 2,
    });
    recorder.recordTimingSources([
      { source: 'aligned' },
      { source: 'estimated' },
      { source: 'phoneme-estimated' },
      { source: 'estimated' },
    ]);
    recorder.recordWasmThreadDowngrade({
      previousThreadCount: 4,
      threadCount: 2,
      reason: 'idle-overrun',
    });
    now = 120;
    recorder.recordModelFallback(new Error('WebGPU failed'), {
      device: 'wasm',
      dtype: 'q8',
      reason: 'webgpu-load-fallback',
      cpuBudgetTarget: true,
    });

    expect(recorder.result()).toEqual({
      selectedBackendPlan: {
        device: 'webgpu',
        dtype: 'fp32',
        reason: 'fast-webgpu',
        cpuBudgetTarget: false,
      },
      modelLoadMs: 1234,
      preTtsLatency: {
        panelReadyMs: null,
        extractionMs: null,
        chunkingMs: null,
        firstAudibleMs: null,
      },
      firstSynthesisMs: 640,
      audioDurationSeconds: 2,
      realTimeFactor: 0.32,
      timingSources: {
        total: 4,
        aligned: 1,
        estimated: 2,
        phonemeEstimated: 1,
        unknown: 0,
      },
      wasmThreadEvents: [
        {
          previousThreadCount: 4,
          threadCount: 2,
          reason: 'idle-overrun',
        },
      ],
      sections: [],
      flow: {
        sectionCount: 0,
        loadTransitionCount: 0,
        measuredTransitionCount: 0,
        audioPlaybackObserved: false,
        pauseThresholdMs: 250,
        maxNextSectionReadyGapMs: null,
        sectionLoadTransitions: [],
        maxInterSectionGapMs: null,
        averageInterSectionGapMs: null,
        pauseCount: 0,
        interSectionGaps: [],
      },
      fallbackOccurred: true,
      fallbacks: [
        {
          type: 'model',
          message: 'WebGPU failed',
          fallbackPlan: {
            device: 'wasm',
            dtype: 'q8',
            reason: 'webgpu-load-fallback',
            cpuBudgetTarget: true,
          },
        },
      ],
    });
    expect(recorder.events().map((event) => event.type)).toEqual([
      'backend-plan',
      'model-load',
      'first-synthesis',
      'timing-sources',
      'wasm-thread-downgrade',
      'model-fallback',
    ]);
  });

  it('returns null real-time factor when synthesis or audio duration is not measurable', () => {
    expect(getProbeRealTimeFactor({
      synthesisMs: null,
      audioDurationSeconds: 2,
    })).toBeNull();
    expect(getProbeRealTimeFactor({
      synthesisMs: 100,
      audioDurationSeconds: 0,
    })).toBeNull();
  });

  it('records per-section synthesis, playback timing, and inter-section gaps', () => {
    let now = 1000;
    const recorder = createTtsHardwareProbeRecorder({ now: () => now });

    recorder.recordSectionSynthesis({
      sectionIndex: 0,
      synthesisMs: 500,
      audioDurationSeconds: 2,
    });
    recorder.recordSectionPlaybackStart({ sectionIndex: 0 });
    now = 3100;
    recorder.recordSectionPlaybackEnd({ sectionIndex: 0 });
    recorder.recordSectionPause({
      fromSectionIndex: 0,
      toSectionIndex: 1,
      pauseAppliedMs: 200,
    });
    recorder.recordSectionSynthesis({
      sectionIndex: 1,
      synthesisMs: 420,
      audioDurationSeconds: 1.5,
    });
    now = 3450;
    recorder.recordSectionPlaybackStart({ sectionIndex: 1 });
    now = 5000;
    recorder.recordSectionPlaybackEnd({ sectionIndex: 1 });

    expect(recorder.result()).toMatchObject({
      sections: [
        {
          sectionIndex: 0,
          synthesisMs: 500,
          audioDurationSeconds: 2,
          realTimeFactor: 0.25,
          synthesisEndedAtMs: 1000,
          audioStartAtMs: 1000,
          audioEndAtMs: 3100,
          playbackDurationMs: 2100,
        },
        {
          sectionIndex: 1,
          synthesisMs: 420,
          audioDurationSeconds: 1.5,
          realTimeFactor: 0.28,
          synthesisEndedAtMs: 3100,
          audioStartAtMs: 3450,
          audioEndAtMs: 5000,
          playbackDurationMs: 1550,
        },
      ],
      flow: {
        sectionCount: 2,
        loadTransitionCount: 1,
        measuredTransitionCount: 1,
        audioPlaybackObserved: true,
        pauseThresholdMs: 250,
        maxNextSectionReadyGapMs: 2100,
        sectionLoadTransitions: [
          {
            fromSectionIndex: 0,
            toSectionIndex: 1,
            nextSectionReadyGapMs: 2100,
          },
        ],
        maxInterSectionGapMs: 350,
        averageInterSectionGapMs: 350,
        pauseCount: 0,
        interSectionGaps: [
          {
            fromSectionIndex: 0,
            toSectionIndex: 1,
            gapMs: 350,
            pauseAppliedMs: 200,
            unplannedGapMs: 150,
            pauseDetected: false,
          },
        ],
      },
    });
  });

  it('polls audio progress to record playback start and end when native events are silent', async () => {
    let now = 1000;
    const startedIntervals = [];
    const clearedIntervals = [];
    let intervalId = 0;
    const events = [];
    const audio = {
      currentTime: 0,
      duration: 2,
      paused: false,
      ended: false,
    };
    const observer = createAudioProgressProbeObserver({
      audio,
      sectionIndex: 2,
      intervalMs: 25,
      setIntervalFn(callback, ms) {
        const id = ++intervalId;
        startedIntervals.push({ id, ms, callback });
        return id;
      },
      clearIntervalFn(id) {
        clearedIntervals.push(id);
      },
      onStart: (event) => events.push(['start', event]),
      onEnd: (event) => events.push(['end', event]),
      now: () => now,
    });

    expect(startedIntervals).toEqual([{ id: 1, ms: 25, callback: expect.any(Function) }]);
    audio.currentTime = 0.1;
    startedIntervals[0].callback();
    now = 3000;
    audio.currentTime = 2;
    audio.ended = true;
    startedIntervals[0].callback();
    observer.stop();

    expect(events).toEqual([
      ['start', { sectionIndex: 2, observedCurrentTime: 0.1, observedAtMs: 1000, source: 'audio-progress' }],
      ['end', { sectionIndex: 2, observedCurrentTime: 2, observedAtMs: 3000, source: 'audio-progress' }],
    ]);
    expect(clearedIntervals).toEqual([1]);
  });
});
