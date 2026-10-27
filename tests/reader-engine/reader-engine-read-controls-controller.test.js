import { describe, expect, it, vi } from 'vitest';
import { createReaderEngineReadControlsController } from '../../src/lib/reader-engine-read-controls-controller.js';

function createController(overrides = {}) {
  const state = {
    readingState: 'error',
    activePrimaryAction: 'grant-access',
    ...overrides.state,
  };
  const onGrantAccess = vi.fn();
  const onPrimaryRead = vi.fn();
  const controller = createReaderEngineReadControlsController({
    state,
    readRunTracker: { abortCurrentRun: vi.fn() },
    playbackSession: { markReleaseBuffersAfterCleanup: vi.fn() },
    setReadingState: vi.fn(),
    setPageHighlightPaused: vi.fn(async () => {}),
    clearPageHighlight: vi.fn(async () => {}),
    clearActiveSpeechPreloads: vi.fn(),
    onPrimaryRead,
    onGrantAccess,
    ...overrides,
  });
  return { controller, state, onGrantAccess, onPrimaryRead };
}

describe('readerEngine read-control recovery actions', () => {
  it('pauses, resumes, jumps and stops generated audio without invoking system speech', async () => {
    const systemSpeech = ['getVoices', 'speak', 'pause', 'resume', 'cancel']
      .map((method) => vi.spyOn(globalThis.speechSynthesis, method));
    try {
      const audio = { pause: vi.fn(), play: vi.fn(async () => {}), duration: 2, currentTime: 0, dispatchEvent: vi.fn() };
      const watchdog = { pause: vi.fn(), resume: vi.fn() };
      const cursor = { requestJump: vi.fn() };
      const abortCurrentRun = vi.fn();
      const setPageHighlightPaused = vi.fn(async () => {});
      const state = {
        readingState: 'reading', currentAudio: audio, currentAudioWatchdog: watchdog,
        currentChunk: 0, activeChunks: ['first', 'second'], activeReadingCursor: cursor,
      };
      const { controller } = createController({
        state,
        readRunTracker: { abortCurrentRun },
        setReadingState: (value) => { state.readingState = value; },
        setPageHighlightPaused,
        fadeOutAudioThenPause: (_audio, { onComplete }) => onComplete(),
      });

      controller.pauseReading();
      expect(audio.pause).toHaveBeenCalledOnce();
      expect(watchdog.pause).toHaveBeenCalledOnce();
      expect(state.readingState).toBe('paused');
      expect(setPageHighlightPaused).toHaveBeenLastCalledWith(true);
      controller.resumeReading();
      await Promise.resolve();
      expect(audio.play).toHaveBeenCalledOnce();
      expect(watchdog.resume).toHaveBeenCalledOnce();
      expect(state.readingState).toBe('reading');
      expect(setPageHighlightPaused).toHaveBeenLastCalledWith(false);
      controller.requestJump(1);
      expect(cursor.requestJump).toHaveBeenCalledExactlyOnceWith(1);
      expect(audio.currentTime).toBe(2);
      expect(audio.dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'ended' }));
      await controller.stopReading();
      expect(abortCurrentRun).toHaveBeenCalledOnce();
      expect(audio.currentTime).toBe(0);
      expect(audio.dispatchEvent).toHaveBeenCalledTimes(1);
      expect(state.readingState).toBe('stopping');
      for (const method of systemSpeech) expect(method).not.toHaveBeenCalled();
    } finally {
      for (const method of systemSpeech) method.mockRestore();
    }
  });

  it('requests site access from a user gesture instead of retrying blindly', () => {
    const { controller, onGrantAccess, onPrimaryRead } = createController();
    const tab = { id: 41, url: 'https://example.test/article' };

    controller.handleErrorRecoveryAction('grant-access', { tab });

    expect(onGrantAccess).toHaveBeenCalledWith({ tab });
    expect(onPrimaryRead).not.toHaveBeenCalled();
  });

  it('restarts a finished read with the restart mode and starts other reads from the viewport', () => {
    const tab = { id: 41, url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=book.pdf' };
    const finished = createController({ state: { readingState: 'finished', activePrimaryAction: null } });
    const idle = createController({ state: { readingState: 'idle', activePrimaryAction: null } });

    finished.controller.handlePrimaryAction({ tab, resumeConfirmed: true });
    idle.controller.handlePrimaryAction({ tab, resumeConfirmed: true });

    expect(finished.onPrimaryRead).toHaveBeenCalledWith({ tab, startMode: 'restart', resumeConfirmed: true });
    expect(idle.onPrimaryRead).toHaveBeenCalledWith({ tab, startMode: 'viewport', resumeConfirmed: true });
  });

  it('aborts an active read before waiting for audio fade cleanup', () => {
    const events = [];
    const { controller } = createController({
      state: {
        readingState: 'reading',
        currentAudio: { volume: 1 },
      },
      readRunTracker: { abortCurrentRun: () => events.push('abort') },
      fadeOutAudioThenPause: (_audio, _options) => events.push('fade'),
    });

    controller.stopReading();

    expect(events[0]).toBe('abort');
    expect(events).toContain('fade');
  });

  it.each(['idle', 'stopping', 'finished', 'error'])('reads from the top after %s instead of resuming or recovering the old position', readingState => {
    const { controller, onPrimaryRead, onGrantAccess } = createController({ state: { readingState, activePrimaryAction: 'grant-access' } });
    const tab = { id: 41, url: 'https://example.test/book.pdf#page=7' };
    controller.handleReadFromStartAction({ tab });
    expect(onPrimaryRead).toHaveBeenCalledExactlyOnceWith({ tab, startMode: 'top', resumeConfirmed: true });
    expect(onGrantAccess).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'reading', 'paused'])('does not start a second read from the top while %s', readingState => {
    const { controller, onPrimaryRead } = createController({ state: { readingState } });
    controller.handleReadFromStartAction();
    expect(onPrimaryRead).not.toHaveBeenCalled();
  });

  it('leaves streamed iterator closure to the read lifecycle cleanup owner', () => {
    const closeIterator = vi.fn(async () => ({ done: true }));
    const { controller } = createController({
      state: {
        readingState: 'reading',
        activeChunkIterator: { return: closeIterator },
      },
    });

    controller.stopReading();

    expect(closeIterator).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'reading', 'paused'])('finishes stop cleanup when the source tab closes while %s', (readingState) => {
    const state = {
      readingState,
      activeReadTabId: 55,
      activeReadPromise: Promise.resolve(),
      pendingReadPauseGate: { resume: vi.fn() },
      activeSectionPauseDelay: { complete: vi.fn() },
    };
    const resume = state.pendingReadPauseGate.resume;
    const abortCurrentRun = vi.fn();
    const markReleaseBuffersAfterCleanup = vi.fn();
    const clearActiveSpeechPreloads = vi.fn();
    const clearPageHighlight = vi.fn(async () => {});
    const { controller } = createController({
      state,
      readRunTracker: { abortCurrentRun },
      playbackSession: { markReleaseBuffersAfterCleanup },
      setReadingState: (value) => { state.readingState = value; },
      clearActiveSpeechPreloads,
      clearPageHighlight,
    });

    expect(() => controller.handleReadTabRemoved(55)).not.toThrow();
    expect(state.readingState).toBe('stopping');
    expect(state.releaseReadSessionAfterCleanup).toBe(true);
    expect(markReleaseBuffersAfterCleanup).toHaveBeenCalledOnce();
    expect(abortCurrentRun).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(state.pendingReadPauseGate).toBeNull();
    expect(clearActiveSpeechPreloads).toHaveBeenCalledOnce();
    expect(clearPageHighlight).toHaveBeenCalledOnce();
    expect(state.activeSectionPauseDelay.complete).toHaveBeenCalledOnce();

    // Duplicate tab notifications and Stop during cleanup must not restart teardown.
    controller.handleReadTabRemoved(55);
    expect(controller.stopReading()).toBe(state.activeReadPromise);
    expect(abortCurrentRun).toHaveBeenCalledOnce();
    expect(clearActiveSpeechPreloads).toHaveBeenCalledOnce();
  });

  it('keeps reading when an unrelated tab closes', () => {
    const abortCurrentRun = vi.fn();
    const clearActiveSpeechPreloads = vi.fn();
    const { controller } = createController({
      state: { readingState: 'reading', activeReadTabId: 55 },
      readRunTracker: { abortCurrentRun },
      clearActiveSpeechPreloads,
    });

    expect(() => controller.handleReadTabRemoved(56)).not.toThrow();
    expect(abortCurrentRun).not.toHaveBeenCalled();
    expect(clearActiveSpeechPreloads).not.toHaveBeenCalled();
  });
});
