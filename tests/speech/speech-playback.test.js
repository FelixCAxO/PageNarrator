import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SECTION_EARLY_ADVANCE_TAIL_SECONDS,
  WORD_HIGHLIGHT_LEAD_SECONDS,
  createAudioStallWatchdog,
  createHighlightPlanResyncTracker,
  createPauseableDelay,
  createWordHighlightPlan,
  createWordHighlightTracker,
  fadeOutAudioThenPause,
  getAudioEndedGapDelayMs,
  getAudioWatchdogDelayMs,
  getHighlightedWordIndex,
  getOutputLatencyAdjustedLeadSeconds,
  getPlaybackRateAdjustedLeadSeconds,
  getSectionEarlyAdvanceDelayMs,
  startWordHighlightLoop,
} from '../../src/lib/speech-playback.js';
import { MAX_SPEED, MIN_SPEED } from '../../src/lib/playback-settings.js';

const SPEED_STEP = 0.05;

function getSupportedSpeedValues() {
  const speeds = [];
  for (let speed = MIN_SPEED; speed <= MAX_SPEED + 0.0001; speed += SPEED_STEP) {
    speeds.push(Number(speed.toFixed(2)));
  }
  return speeds;
}

describe('speech playback highlighting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects the next word when playback is within the lead time before it starts', () => {
    const timings = [
      { start: 0, end: 0.2 },
      { start: 0.2, end: 0.4 },
    ];

    expect(getHighlightedWordIndex(timings, 0.199, 0.001)).toBe(1);
  });

  it('uses the current word outside the lead window', () => {
    const timings = [
      { start: 0, end: 0.2 },
      { start: 0.2, end: 0.4 },
    ];

    expect(getHighlightedWordIndex(timings, 0.1989, 0.001)).toBe(0);
  });

  it('does not lead word highlights by default', () => {
    const timings = [
      { start: 0, end: 0.24 },
      { start: 0.24, end: 0.48 },
      { start: 0.48, end: 0.72 },
    ];

    expect(WORD_HIGHLIGHT_LEAD_SECONDS).toBe(0);
    expect(getHighlightedWordIndex(timings, 0.239)).toBe(0);
    expect(getHighlightedWordIndex(timings, 0.24)).toBe(1);
  });

  it('can delay word highlights to compensate for audio output latency', () => {
    const timings = [
      { start: 0, end: 0.24 },
      { start: 0.24, end: 0.48 },
    ];

    const leadSeconds = getOutputLatencyAdjustedLeadSeconds({
      playbackRate: 1,
      outputLatencySeconds: 0.08,
    });

    expect(leadSeconds).toBeCloseTo(-0.08);
    expect(getHighlightedWordIndex(timings, 0.27, leadSeconds)).toBe(0);
    expect(getHighlightedWordIndex(timings, 0.32, leadSeconds)).toBe(1);
  });

  it('builds a page-side word timing plan without an early default lead', () => {
    const plan = createWordHighlightPlan([
      { start: 0, end: 0.18, text: 'Prefix' },
      { start: 0.18, end: 0.44, text: 'visible' },
      { start: 0.44, end: 0.7, text: 'text' },
    ], {
      mapWordIndex(index) {
        return index === 0 ? -1 : index + 3;
      },
    });

    expect(plan).toEqual([
      {
        speechIndex: 0,
        index: -1,
        synthetic: true,
        start: 0,
        end: 0.18,
        highlightAt: 0,
        endAt: 0.18,
        text: 'Prefix',
        confidence: null,
      },
      {
        speechIndex: 1,
        index: 4,
        synthetic: false,
        start: 0.18,
        end: 0.44,
        highlightAt: 0.18,
        endAt: 0.44,
        text: 'visible',
        confidence: null,
      },
      {
        speechIndex: 2,
        index: 5,
        synthetic: false,
        start: 0.44,
        end: 0.7,
        highlightAt: 0.44,
        endAt: 0.7,
        text: 'text',
        confidence: null,
      },
    ]);
  });

  it('delays page-side word start and end times when output latency is compensated', () => {
    const plan = createWordHighlightPlan([
      { start: 0.2, end: 0.3, text: 'short' },
    ], {
      leadSeconds: getOutputLatencyAdjustedLeadSeconds({
        playbackRate: 1,
        outputLatencySeconds: 0.08,
      }),
    });

    expect(plan[0]?.highlightAt).toBeCloseTo(0.28);
    expect(plan[0]?.endAt).toBeCloseTo(0.38);
  });

  it('scales media-clock lead so the perceptual word lead stays constant at faster playback rates', () => {
    const timings = [
      { start: 0, end: 0.2 },
      { start: 0.2, end: 0.4 },
    ];

    expect(getPlaybackRateAdjustedLeadSeconds(2, 0.04)).toBeCloseTo(0.08);
    expect(getHighlightedWordIndex(timings, 0.119, getPlaybackRateAdjustedLeadSeconds(2, 0.04))).toBe(0);
    expect(getHighlightedWordIndex(timings, 0.12, getPlaybackRateAdjustedLeadSeconds(2, 0.04))).toBe(1);
  });

  it('keeps the wall-clock word lead stable at any supported playback speed', () => {
    const timings = [
      { start: 0, end: 0.2 },
      { start: 0.2, end: 0.4 },
      { start: 0.4, end: 0.6 },
    ];

    expect(getSupportedSpeedValues()).toHaveLength(51);

    for (const speed of getSupportedSpeedValues()) {
      const rateAdjustedLead = getPlaybackRateAdjustedLeadSeconds(speed, 0.04);
      expect(rateAdjustedLead, `${speed}x lead`).toBeCloseTo(0.04 * speed);

      const beforeSecondWord = 0.2 - rateAdjustedLead - 0.001;
      const atSecondWordLead = 0.2 - rateAdjustedLead;
      expect(getHighlightedWordIndex(timings, beforeSecondWord, rateAdjustedLead), `${speed}x before lead`).toBe(0);
      expect(getHighlightedWordIndex(timings, atSecondWordLead, rateAdjustedLead), `${speed}x at lead`).toBe(1);
    }
  });

  it('updates the media-clock lead when playback rate changes mid-section', () => {
    const frames = [];
    const highlighted = [];
    let currentTime = 0.15;
    let playbackRate = 1;
    const stop = startWordHighlightLoop({
      wordTimings: [
        { start: 0, end: 0.2 },
        { start: 0.2, end: 0.4 },
      ],
      getCurrentTime: () => currentTime,
      getPlaybackRate: () => playbackRate,
      leadSeconds: 0.04,
      onHighlight: (index) => highlighted.push(index),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => {},
    });

    try {
      expect(highlighted).toEqual([0]);
      playbackRate = 1.3;
      frames.shift()?.();
      expect(highlighted).toEqual([0, 1]);

      currentTime = 0.2;
      frames.shift()?.();
      expect(highlighted).toEqual([0, 1]);
    } finally {
      stop();
    }
  });

  it('advances the word highlight loop at a constant wall-clock lead for any supported playback speed', () => {
    for (const speed of getSupportedSpeedValues()) {
      const frames = [];
      const highlighted = [];
      const leadSeconds = getPlaybackRateAdjustedLeadSeconds(speed, 0.04);
      let currentTime = 0.2 - leadSeconds - 0.001;
      const stop = startWordHighlightLoop({
        wordTimings: [
          { start: 0, end: 0.2 },
          { start: 0.2, end: 0.4 },
        ],
        getCurrentTime: () => currentTime,
        getPlaybackRate: () => speed,
        leadSeconds: 0.04,
        onHighlight: (index) => highlighted.push(index),
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: () => {},
      });

      try {
        expect(highlighted, `${speed}x before boundary`).toEqual([0]);

        currentTime = 0.2 - leadSeconds;
        frames.shift()?.();
        expect(highlighted, `${speed}x at boundary`).toEqual([0, 1]);
      } finally {
        stop();
      }
    }
  });

  it('tracks all newly crossed word changes as playback time advances', () => {
    const tracker = createWordHighlightTracker([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.5 },
      { start: 0.5, end: 0.75 },
    ], 0.1);

    expect(tracker.update(0)).toEqual([0]);
    expect(tracker.update(0.05)).toEqual([]);
    expect(tracker.update(0.16)).toEqual([1]);
    expect(tracker.update(0.22)).toEqual([]);
    expect(tracker.update(0.41)).toEqual([2]);
    expect(tracker.update(Number.NaN)).toEqual([]);
    expect(tracker.update(0.16)).toEqual([]);
    expect(tracker.update(9)).toEqual([]);
  });

  it('backfills words skipped between animation frames', () => {
    const tracker = createWordHighlightTracker([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.5 },
      { start: 0.5, end: 0.75 },
      { start: 0.75, end: 1 },
    ], 0);

    expect(tracker.update(0.1)).toEqual([0]);
    expect(tracker.update(0.8)).toEqual([1, 2, 3]);
  });

  it('sets a bounded watchdog delay from expected audio duration and playback rate', () => {
    expect(getAudioWatchdogDelayMs(10, 1)).toBe(25000);
    expect(getAudioWatchdogDelayMs(10, 2)).toBe(15000);
    expect(getAudioWatchdogDelayMs(Number.NaN, 1)).toBe(65000);
  });

  it('caps the ended residual gap wait instead of holding the next chunk for the whole reported remainder', () => {
    expect(getAudioEndedGapDelayMs({
      durationSeconds: 10,
      currentTimeSeconds: 9.7,
      playbackRate: 1,
    })).toBe(0);
    expect(getAudioEndedGapDelayMs({
      durationSeconds: 10,
      currentTimeSeconds: 9.4,
      playbackRate: 1,
    })).toBe(250);
    expect(getAudioEndedGapDelayMs({
      durationSeconds: 10,
      currentTimeSeconds: 9.4,
      playbackRate: 3,
    })).toBe(200);
  });

  it('detects highlight-plan drift against the media clock before re-anchoring the page timers', () => {
    let nowMs = 1000;
    const tracker = createHighlightPlanResyncTracker({
      driftThresholdSeconds: 0.03,
      now: () => nowMs,
    });

    expect(tracker.shouldResync({ currentTime: 2, playbackRate: 1, paused: false })).toBe(true);
    tracker.markSync({ currentTime: 2, playbackRate: 1, paused: false });

    nowMs += 250;
    expect(tracker.shouldResync({ currentTime: 2.25, playbackRate: 1, paused: false })).toBe(false);
    expect(tracker.shouldResync({ currentTime: 2.19, playbackRate: 1, paused: false })).toBe(true);
    tracker.markSync({ currentTime: 2.19, playbackRate: 1, paused: false });

    nowMs += 100;
    expect(tracker.shouldResync({ currentTime: 2.29, playbackRate: 1.5, paused: false })).toBe(true);
  });

  it('fades early-advance playback before pausing the audio element', () => {
    vi.useFakeTimers();
    const events = [];
    const audio = {
      volume: 1,
      pause() {
        events.push(['pause', this.volume]);
      },
    };

    fadeOutAudioThenPause(audio, {
      durationMs: 60,
      frameMs: 20,
      onComplete: () => events.push(['complete', audio.volume]),
    });

    vi.advanceTimersByTime(20);
    expect(audio.volume).toBeLessThan(1);
    expect(audio.volume).toBeGreaterThan(0);

    vi.advanceTimersByTime(40);
    expect(events).toEqual([
      ['pause', 0],
      ['complete', 1],
    ]);
    expect(audio.volume).toBe(1);
  });

  it('turns negative section pacing into a safe early advance over trailing silence', () => {
    expect(SECTION_EARLY_ADVANCE_TAIL_SECONDS).toBe(0.05);

    const wordTimings = [
      { start: 0, end: 0.4 },
      { start: 1, end: 4.4 },
    ];

    expect(getSectionEarlyAdvanceDelayMs({
      currentTime: 0,
      durationSeconds: 5,
      playbackRate: 1,
      wordTimings,
      advanceSeconds: 1,
      tailSeconds: 0.1,
    })).toBe(4500);
    expect(getSectionEarlyAdvanceDelayMs({
      currentTime: 0,
      durationSeconds: 5,
      playbackRate: 3,
      wordTimings,
      advanceSeconds: 1,
      tailSeconds: 0.1,
    })).toBe(1500);
  });

  it('does not early-advance when there is no safe trailing audio to skip', () => {
    expect(getSectionEarlyAdvanceDelayMs({
      durationSeconds: 5,
      wordTimings: [{ start: 0, end: 5 }],
      advanceSeconds: 1,
    })).toBeNull();
    expect(getSectionEarlyAdvanceDelayMs({
      durationSeconds: 5,
      wordTimings: [{ start: 0, end: 4.8 }],
      advanceSeconds: 0,
    })).toBeNull();
  });

  it('does not fail playback while the user has paused audio', () => {
    vi.useFakeTimers();
    const events = [];
    const watchdog = createAudioStallWatchdog({
      delayMs: 1000,
      onStall: () => events.push('stalled'),
    });

    vi.advanceTimersByTime(400);
    watchdog.pause();
    vi.advanceTimersByTime(5000);
    expect(events).toEqual([]);

    watchdog.resume();
    vi.advanceTimersByTime(599);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['stalled']);
  });

  it('ignores an already queued stall callback after disposal', () => {
    let queuedCallback;
    const onStall = vi.fn();
    const clearTimer = vi.fn();
    const watchdog = createAudioStallWatchdog({
      onStall,
      setTimer: (callback) => { queuedCallback = callback; return 42; },
      clearTimer,
    });
    watchdog.dispose();
    watchdog.dispose();
    queuedCallback();
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(42);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('pauses and resumes an inter-section delay without losing the remaining wait time', () => {
    vi.useFakeTimers();
    const events = [];
    const delay = createPauseableDelay({
      delayMs: 5000,
      onComplete: () => events.push('complete'),
    });

    vi.advanceTimersByTime(2000);
    delay.pause();
    vi.advanceTimersByTime(5000);
    expect(events).toEqual([]);

    delay.resume();
    vi.advanceTimersByTime(2999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['complete']);
  });

  it('can finish a pending inter-section delay when playback stops or jumps', () => {
    vi.useFakeTimers();
    const events = [];
    const delay = createPauseableDelay({
      delayMs: 5000,
      onComplete: () => events.push('complete'),
    });

    vi.advanceTimersByTime(1200);
    delay.complete();
    vi.advanceTimersByTime(5000);

    expect(events).toEqual(['complete']);
  });
});
