import { createSignal, createFakeAudio } from './reader-engine-audio-playback.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioPlaybackManager } from '../../src/lib/reader-engine-audio-playback.js';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

describe('readerEngine audio playback manager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes the playback URL when acquiring the audio element fails', async () => {
    const revokeObjectURL = vi.fn();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire() { throw new Error('decoder unavailable'); } },
      urlApi: { createObjectURL: () => 'blob:failed-playback', revokeObjectURL },
    });
    await expect(manager.playAudio(new Blob(['audio']), [], { speech: 'hello' }))
      .rejects.toThrow('decoder unavailable');
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:failed-playback');
    expect(manager.getState().currentAudio).toBeNull();
  });

  it.each([false, true])('schedules no highlight frames for disabled or unavailable marks, disabled=%s', async (disabled) => {
    const audio = createFakeAudio();
    const requestFrame = vi.fn();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: () => audio },
      requestFrame,
      urlApi: { createObjectURL: () => 'blob:no-marks', revokeObjectURL() {} },
    });
    const playback = manager.playAudio(new Blob(['audio']), disabled ? [{ start: 0, end: 1 }] : [], { speech: 'hello' }, {
      syncWordHighlights: !disabled,
    });
    await Promise.resolve();
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('playing'));
    audio.onended();
    await playback;
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('starts an unpaused word plan when buffering ends before the play promise resolves', async () => {
    vi.useFakeTimers();
    const audio = createFakeAudio();
    let resolvePlay;
    audio.play = vi.fn(() => new Promise((resolve) => { resolvePlay = resolve; }));
    const messages = [];
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: () => audio },
      readAudioOutputLatencySeconds: () => 0,
      sendPageMessage: async (_tabId, message) => messages.push(message),
      urlApi: { createObjectURL: () => 'blob:buffered', revokeObjectURL: () => {} },
    });
    const playback = manager.playAudio(new Blob(['audio']), [{ text: 'hello', start: 0, end: 1 }], { speech: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    audio.dispatchEvent(new Event('waiting'));
    audio.dispatchEvent(new Event('playing'));
    resolvePlay();
    await vi.advanceTimersByTimeAsync(0);
    const plan = messages.find(({ type }) => type === MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN);
    audio.onended();
    await playback;
    expect(plan).toMatchObject({ paused: false, currentTime: 0 });
  });

  it('plays generated audio, waits for normal handoff, and releases blob resources once', async () => {
    const calls = [];
    const audio = createFakeAudio();
    const revoked = [];
    const signal = createSignal();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      getActiveReadTabId: () => 7,
      sendPageMessage: async (_tabId, message) => calls.push(message.type),
      flowRecorder: { record: (event) => calls.push(event.kind) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: (url) => revoked.push(url),
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { word: 'hello', start: 0, end: 0.5 },
    ], { speech: 'hello' }, {
      signal,
      runId: 1,
      sectionIndex: 0,
      onBeforeNormalEnd: () => calls.push('handoff'),
    });
    await Promise.resolve();
    audio.dispatchEvent(new Event('playing'));
    audio.onended();
    await playback;

    expect(calls).toEqual(expect.arrayContaining([
      'chunk_play',
      MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN,
      'handoff',
      'chunk_end',
    ]));
    expect(revoked).toEqual(['blob:test-audio']);
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(manager.getState().currentAudio).toBeNull();
  });

  it('aborts generated audio once and releases listeners, watchdog, timers and its URL despite late events', async () => {
    vi.useFakeTimers();
    const audio = createFakeAudio();
    const signal = createSignal();
    const revokeObjectURL = vi.fn();
    const settled = vi.fn();
    const handoff = vi.fn();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      urlApi: { createObjectURL: () => 'blob:abort-audio', revokeObjectURL },
    });
    const playback = manager.playAudio(new Blob(['audio']), [{ text: 'hello', start: 0, end: 1 }],
      { speech: 'hello' }, { signal, runId: 1, onBeforeNormalEnd: handoff }).then(settled);
    await Promise.resolve();
    const lateEnd = audio.onended;
    const lateError = audio.onerror;
    const disposeWatchdog = vi.spyOn(manager.getState().currentAudioWatchdog, 'dispose');
    signal.abort();
    await playback;
    signal.abort();
    lateEnd();
    lateError(new Error('late media event'));
    audio.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:abort-audio');
    expect(disposeWatchdog).toHaveBeenCalledTimes(1);
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    for (const [type, listener] of audio.addEventListener.mock.calls) {
      expect(audio.removeEventListener).toHaveBeenCalledWith(type, listener);
    }
    expect(audio.src).toBe('');
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(manager.getState().currentAudio).toBeNull();
    expect(manager.getState().currentAudioWatchdog).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays generated audio without reading system speech APIs or exposing an alternate speech path', async () => {
    const descriptors = ['speechSynthesis', 'SpeechSynthesisUtterance'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const access = vi.fn(() => { throw new Error('System speech must not be consulted'); });
    for (const [name] of descriptors) Object.defineProperty(globalThis, name, { configurable: true, get: access });
    try {
      const audio = createFakeAudio();
      const manager = createAudioPlaybackManager({
        audioPool: { acquire: (src) => { audio.src = src; return audio; } },
        urlApi: { createObjectURL: () => 'blob:generated-audio', revokeObjectURL: vi.fn() },
      });
      const playback = manager.playAudio(new Blob(['audio']), [], { speech: 'hello' });
      await Promise.resolve();
      audio.onended();
      await playback;
      manager.stop();
      expect(access).not.toHaveBeenCalled();
      expect(manager).not.toHaveProperty('playBrowserSpeech');
      expect(manager).not.toHaveProperty('cancelBrowserSpeech');
      expect(manager.getState()).not.toHaveProperty('activeSpeechUtterance');
    } finally {
      for (const [name, descriptor] of descriptors) Object.defineProperty(globalThis, name, descriptor);
    }
  });

  it('does not arm early advance until audio.play resolves or the start fence expires', async () => {
    vi.useFakeTimers();
    const calls = [];
    const audio = createFakeAudio();
    let resolvePlay;
    audio.currentTime = 0.5;
    audio.duration = 2;
    audio.play = vi.fn(() => new Promise((resolve) => {
      resolvePlay = resolve;
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0.5,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: (event) => calls.push(event.kind) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'tail', start: 0, end: 1.2 },
    ], { speech: 'tail' }, {
      canAdvanceEarly: true,
      sectionIndex: 0,
    });

    await Promise.resolve();
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('play'));
    vi.advanceTimersByTime(1100);

    expect(calls).not.toContain('chunk_end');

    resolvePlay();
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    audio.onended();
    await playback;

    expect(calls).toContain('chunk_play');
  });

  it('records decode-to-play latency when the play gate opens', async () => {
    vi.useFakeTimers();
    const events = [];
    const audio = createFakeAudio();
    let nowMs = 1000;
    let resolvePlay;
    audio.readyState = 3;
    audio.play = vi.fn(() => new Promise((resolve) => {
      resolvePlay = resolve;
    }));
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      getNowMs: () => nowMs,
      flowRecorder: { record: (event) => events.push(event) },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [], { speech: 'hello' }, {
      sectionIndex: 3,
    });

    await Promise.resolve();
    nowMs += 17;
    resolvePlay();
    await Promise.resolve();
    audio.onended();
    await playback;

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'audio_decode_latency',
      channel: 'decode_latency',
      chunkIndex: 3,
      decodeLatencyMs: 17,
      readyState: 3,
    }));
  });

  it('tags word-highlight plans with the playing section index', async () => {
    const messages = [];
    const audio = createFakeAudio();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: (src) => { audio.src = src; return audio; } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      getActiveReadTabId: () => 7,
      sendPageMessage: async (_tabId, message) => messages.push(message),
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL: () => 'blob:test-audio',
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [
      { text: 'hello', start: 0, end: 0.2 },
    ], { speech: 'hello' }, {
      syncWordHighlights: true,
      sectionIndex: 5,
    });

    await Promise.resolve();
    audio.onended();
    await playback;

    const planMessage = messages.find((message) => message.type === MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN);
    expect(planMessage?.plan).toEqual([
      expect.objectContaining({ chunkIndex: 5, text: 'hello' }),
    ]);
  });

  it('plays a decode-prepared audio element without creating a fresh blob URL', async () => {
    const audio = createFakeAudio();
    audio.src = 'blob:prepared-audio';
    const cleanup = vi.fn(() => {
      audio.src = '';
    });
    const createObjectURL = vi.fn();
    const manager = createAudioPlaybackManager({
      audioPool: { acquire: () => { throw new Error('prepared audio should be reused'); } },
      readRunTracker: { isCurrentRun: () => true },
      getPlaybackSpeed: () => 1,
      getSectionEarlyAdvanceSeconds: () => 0,
      readAudioOutputLatencySeconds: () => 0,
      flowRecorder: { record: () => {} },
      urlApi: {
        createObjectURL,
        revokeObjectURL: () => {},
      },
    });

    const playback = manager.playAudio(new Blob(['audio']), [], { speech: 'hello' }, {
      preparedAudio: {
        audio,
        managedUrl: { url: 'blob:prepared-audio', revoke() {} },
        cleanup,
      },
    });

    await Promise.resolve();
    audio.onended();
    await playback;

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not audibly play the next prepared section before the current section finishes', async () => {
    const currentAudio = createFakeAudio();
    currentAudio.currentTime = 0;
    currentAudio.duration = 10;
    const nextAudio = createFakeAudio();
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
      { text: 'current', start: 0, end: 10 },
    ], { speech: 'current' }, {
      canAdvanceEarly: true,
      sectionIndex: 0,
      onBeforeNormalEnd,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onBeforeNormalEnd).toHaveBeenCalledTimes(1);
    expect(nextAudio.play).not.toHaveBeenCalled();

    currentAudio.onended();
    await playback;
  });
});
