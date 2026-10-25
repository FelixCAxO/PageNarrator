import { createFakeAudio } from "./reader-engine-audio-playback.fixtures.js";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioPlaybackManager } from '../../src/lib/reader-engine-audio-playback.js';

import { STREAM_SYNTHESIS_TIMEOUT_MS } from '../../src/lib/timing-config.js';

describe('readerEngine audio playback manager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finishes a stalled generated-audio clip near EOF through the normal handoff path', async () => {
    vi.useFakeTimers();
    const calls = [];
    const audio = createFakeAudio();
    audio.currentTime = 1.9;
    audio.duration = 2;
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: (event) => calls.push(event.kind) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    let settled = false;
    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      sectionIndex: 0,
      onBeforeNormalEnd: () => calls.push('handoff'),
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('stalled'));
    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toBe(true);
    await playback;

    expect(calls).toEqual(expect.arrayContaining(['chunk_play', 'chunk_end', 'handoff']));
    expect(manager.getState().currentAudio).toBeNull();
  });

  it('keeps the watchdog alive until the normal handoff settles', async () => {
    vi.useFakeTimers();
    const audio = createFakeAudio();
    audio.currentTime = 1.9;
    audio.duration = 2;
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      sectionIndex: 0,
      onBeforeNormalEnd: () => new Promise(() => {}),
    });

    await Promise.resolve();
    await Promise.resolve();

    const watchdog = manager.getState().currentAudioWatchdog;
    expect(watchdog).toBeTruthy();
    const dispose = vi.spyOn(watchdog, 'dispose');

    audio.dispatchEvent(new Event('playing'));
    audio.onended();

    expect(dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_SYNTHESIS_TIMEOUT_MS);
    await playback;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.getState().currentAudioWatchdog).toBeNull();
  });

  it('does not finish a mid-stream stalled generated-audio clip with the EOF fence', async () => {
    vi.useFakeTimers();
    const calls = [];
    const audio = createFakeAudio();
    audio.currentTime = 0.8;
    audio.duration = 2;
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: (event) => calls.push(event.kind) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    let settled = false;
    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      sectionIndex: 0,
      onBeforeNormalEnd: () => calls.push('handoff'),
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(300);

    expect(settled).toBe(false);
    expect(calls).not.toContain('handoff');

    audio.onended();
    await playback;
  });

  it('cancels a near-EOF stall fence when generated audio starts playing again', async () => {
    vi.useFakeTimers();
    const calls = [];
    const audio = createFakeAudio();
    audio.currentTime = 1.9;
    audio.duration = 2;
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: (event) => calls.push(event.kind) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    let settled = false;
    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      sectionIndex: 0,
      onBeforeNormalEnd: () => calls.push('handoff'),
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(50);
    audio.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toBe(false);

    audio.onended();
    await playback;
    expect(calls).toContain('handoff');
  });
});
