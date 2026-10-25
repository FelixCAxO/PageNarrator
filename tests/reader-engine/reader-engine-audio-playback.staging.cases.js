import { createFakeAudio } from "./reader-engine-audio-playback.fixtures.js";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioPlaybackManager } from '../../src/lib/reader-engine-audio-playback.js';

describe('readerEngine audio playback manager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let diagnostic progress polling cut the final speech samples', async () => {
    vi.useFakeTimers();
    const audio = createFakeAudio(), record = vi.fn();
    const manager = createAudioPlaybackManager({ audioPool: { acquire: () => audio },
      isTtsHardwareProbeRecordingEnabled: () => true, flowRecorder: { record },
      urlApi: { createObjectURL: () => 'blob:tail', revokeObjectURL() {} } });
    let finished = false;
    const playback = manager.playAudio(new Blob(['audio']), [], { speech: 'complete speech' })
      .then(() => { finished = true; });
    await Promise.resolve(); audio.currentTime = .98;
    await vi.advanceTimersByTimeAsync(125);
    expect(finished).toBe(false); expect(audio.pause).not.toHaveBeenCalled();
    expect(record.mock.calls.some(([event]) => event.kind === 'chunk_end')).toBe(false);
    audio.currentTime = 1; audio.ended = true; audio.onended(); await playback;
    expect(finished).toBe(true);
  });

  it('stages the next decoded audio before the play gate opens once duration is known', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 1.8;
    currentAudio.duration = 2;
    currentAudio.play = vi.fn(() => new Promise(() => {}));
    const nextAudio = createFakeAudio();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'current', start: 0, end: 2 },
    ], { speech: 'current' }, {
      canAdvanceEarly: false,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    currentAudio.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });

  it('keeps staged next audio inactive when waiting clears', async () => {
    vi.useFakeTimers();
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 1;
    currentAudio.duration = 2;
    const nextAudio = createFakeAudio();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'current', start: 0, end: 2 },
    ], { speech: 'current' }, {
      canAdvanceEarly: false,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    await Promise.resolve();
    currentAudio.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('waiting'));
    expect(nextAudio.pause).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('playing'));
    await Promise.resolve();
    await Promise.resolve();

    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });

  it('keeps staged next audio inactive during a near-EOF waiting stall', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 1.9;
    currentAudio.duration = 2;
    const nextAudio = createFakeAudio();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'current', start: 0, end: 2 },
    ], { speech: 'current' }, {
      canAdvanceEarly: false,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    await Promise.resolve();
    currentAudio.dispatchEvent(new Event('playing'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('waiting'));
    expect(nextAudio.pause).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });

  it('stages the next decoded audio before the current clip reaches ended', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 1.8;
    currentAudio.duration = 2;
    const nextAudio = createFakeAudio();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      ok: true,
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    let settled = false;
    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'current', start: 0, end: 2 },
    ], { speech: 'current' }, {
      canAdvanceEarly: true,
      sectionIndex: 0,
      onBeforeNormalEnd,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    currentAudio.onended();
    await playback;

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
  });

  it('stages generated audio on short clips before the play gate opens', async () => {
    vi.useFakeTimers();
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 0;
    currentAudio.duration = 0.3;
    let resolvePlay;
    currentAudio.play = vi.fn(() => new Promise((resolve) => {
      resolvePlay = resolve;
    }));
    const nextAudio = createFakeAudio();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0.2,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'short', start: 0, end: 0.3 },
    ], { speech: 'short' }, {
      canAdvanceEarly: false,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    currentAudio.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();
    expect(resolvePlay).toBeDefined();

    currentAudio.onended();
    await playback;
  });

  it('keeps a staged next clip inactive when waiting occurs near EOF', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 1.9;
    currentAudio.duration = 2;
    const nextAudio = createFakeAudio();
    nextAudio.pause = vi.fn();
    nextAudio.play = vi.fn(() => Promise.resolve());
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      canAdvanceEarly: true,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('waiting'));
    expect(nextAudio.pause).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });

  it('keeps a staged next clip inactive after a waiting stall clears', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 0.8;
    currentAudio.duration = 2;
    const nextAudio = createFakeAudio();
    nextAudio.pause = vi.fn(() => {
      nextAudio.paused = true;
    });
    nextAudio.play = vi.fn(() => {
      nextAudio.paused = false;
      return Promise.resolve();
    });
    const onBeforeNormalEnd = vi.fn(async () => ({
      preparedAudio: {
        audio: nextAudio,
        managedUrl: { url: 'blob:next-audio', revoke() {} },
      },
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { currentAudio.src = src; return currentAudio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:current-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 2 },
    ], { speech: 'tail' }, {
      canAdvanceEarly: true,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('waiting'));
    expect(nextAudio.pause).not.toHaveBeenCalled();

    currentAudio.dispatchEvent(new Event('playing'));
    await Promise.resolve();

    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });
});
