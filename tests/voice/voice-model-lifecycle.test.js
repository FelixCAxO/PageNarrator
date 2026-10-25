import { describe, expect, it } from 'vitest';
import {
  VOICE_MODEL_IDLE_RELEASE_DELAY_MS,
  createInFlightActivityTracker,
  createVoiceModelIdleReleaseController,
} from '../../src/lib/voice-registry.js';

function createManualTimers() {
  const timers = new Map();
  let nextId = 1;

  return {
    timers,
    setTimeoutFn(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
  };
}

describe('voice model idle release lifecycle', () => {
  it('schedules cached model release only after the panel stays hidden', async () => {
    const releases = [];
    const timers = createManualTimers();
    const controller = createVoiceModelIdleReleaseController({
      releaseVoiceModel: async () => {
        releases.push('released');
        return true;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.handleVisibilityChange({ hidden: true });

    expect(timers.timers.size).toBe(1);
    expect([...timers.timers.values()][0].delayMs).toBe(VOICE_MODEL_IDLE_RELEASE_DELAY_MS);

    controller.handleVisibilityChange({ hidden: false });
    expect(timers.timers.size).toBe(0);

    controller.handleVisibilityChange({ hidden: true });
    const scheduledRelease = [...timers.timers.values()][0];
    await scheduledRelease.callback();

    expect(releases).toEqual(['released']);
    expect(timers.timers.size).toBe(0);
  });

  it('releaseNow cancels pending hidden-panel release before freeing the model', async () => {
    const releases = [];
    const timers = createManualTimers();
    const controller = createVoiceModelIdleReleaseController({
      releaseVoiceModel: async () => {
        releases.push('released-now');
        return true;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.handleVisibilityChange({ hidden: true });
    const pendingRelease = [...timers.timers.values()][0];

    await expect(controller.releaseNow()).resolves.toBe(true);
    await pendingRelease.callback();

    expect(releases).toEqual(['released-now']);
    expect(timers.timers.size).toBe(0);
  });

  it('reschedules hidden-panel release while active synthesis still owns the model', async () => {
    const releases = [];
    let canRelease = false;
    const timers = createManualTimers();
    const controller = createVoiceModelIdleReleaseController({
      canRelease: () => canRelease,
      releaseVoiceModel: async () => {
        releases.push('released');
        return true;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.handleVisibilityChange({ hidden: true });
    const firstRelease = [...timers.timers.values()][0];
    await firstRelease.callback();

    expect(releases).toEqual([]);
    expect(timers.timers.size).toBe(1);

    canRelease = true;
    const secondRelease = [...timers.timers.values()][0];
    await secondRelease.callback();

    expect(releases).toEqual(['released']);
    expect(timers.timers.size).toBe(0);
  });

  it('tracks in-flight synthesis promises until they settle', async () => {
    const tracker = createInFlightActivityTracker();
    let finishSynthesis;
    const synthesis = new Promise((resolve) => {
      finishSynthesis = resolve;
    });

    const tracked = tracker.trackPromise(synthesis);

    expect(tracker.isActive()).toBe(true);

    finishSynthesis('speech-ready');

    await expect(tracked).resolves.toBe('speech-ready');
    expect(tracker.isActive()).toBe(false);
  });

  it('tracks progressive synthesis iterators until playback returns them', async () => {
    const tracker = createInFlightActivityTracker();
    let returned = false;
    let index = 0;
    const segments = tracker.trackAsyncIterable({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            index += 1;
            if (index === 1) return { done: false, value: { text: 'First segment.' } };
            if (index === 2) return { done: false, value: { text: 'Second segment.' } };
            return { done: true, value: undefined };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    });

    const iterator = segments[Symbol.asyncIterator]();

    expect(tracker.isActive()).toBe(true);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { text: 'First segment.' },
    });

    await iterator.return();

    expect(returned).toBe(true);
    expect(tracker.isActive()).toBe(false);
  });

  it('does not schedule hidden-panel release when idle release is disabled', () => {
    const timers = createManualTimers();
    const controller = createVoiceModelIdleReleaseController({
      idleReleaseEnabled: () => false,
      releaseVoiceModel: async () => true,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.handleVisibilityChange({ hidden: true });

    expect(timers.timers.size).toBe(0);
  });

  it('does not release a scheduled model after idle release is disabled', async () => {
    const releases = [];
    let enabled = true;
    const timers = createManualTimers();
    const controller = createVoiceModelIdleReleaseController({
      idleReleaseEnabled: () => enabled,
      releaseVoiceModel: async () => {
        releases.push('released');
        return true;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.handleVisibilityChange({ hidden: true });
    const scheduledRelease = [...timers.timers.values()][0];
    enabled = false;
    await scheduledRelease.callback();

    expect(releases).toEqual([]);
    expect(timers.timers.size).toBe(0);
  });
});
