import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReaderEngineMessageRouter,
  normalizeReaderAction,
} from '../../src/lib/core/reader-engine-message-router.js';
import { MESSAGE_TYPES, READER_ACTION_TYPES } from '../../src/lib/message-types.js';

describe('readerEngine message router', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes string reader actions to typed action objects', () => {
    expect(normalizeReaderAction('stop')).toEqual({ type: READER_ACTION_TYPES.STOP });
    expect(normalizeReaderAction({ type: READER_ACTION_TYPES.NEXT })).toEqual({ type: READER_ACTION_TYPES.NEXT });
    expect(normalizeReaderAction(null)).toBeNull();
  });

  it('dispatches floating reader speed adjustments through injected actions', () => {
    const setPlaybackSpeed = vi.fn();
    const router = createReaderEngineMessageRouter({
      getPlaybackSpeed: () => 1.25,
      actions: { setPlaybackSpeed },
    });

    router.handleFloatingReaderAction({ type: READER_ACTION_TYPES.ADJUST_SPEED, delta: 0.25 });

    expect(setPlaybackSpeed).toHaveBeenCalledWith(1.5);
  });

  it('confirms saved resume state for toolbar read actions', () => {
    const handlePrimaryAction = vi.fn();
    const router = createReaderEngineMessageRouter({ actions: { handlePrimaryAction } });
    const tab = { id: 55, url: 'https://example.com/article' };

    router.handleFloatingReaderAction({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK, tab });

    expect(handlePrimaryAction).toHaveBeenCalledWith({ resumeConfirmed: true, tab });
  });

  it('dispatches forwarded runtime action messages', () => {
    const stopReading = vi.fn();
    const router = createReaderEngineMessageRouter({ actions: { stopReading } });

    const handled = router.handleRuntimeMessage({
      type: MESSAGE_TYPES.READER_ENGINE_ACTION,
      action: { type: READER_ACTION_TYPES.STOP },
    });

    expect(handled).toBe(false);
    expect(stopReading).toHaveBeenCalledTimes(1);
  });

  it('ignores direct floating reader runtime messages so background forwarding owns dispatch', () => {
    const stopReading = vi.fn();
    const router = createReaderEngineMessageRouter({ actions: { stopReading } });

    const handled = router.handleRuntimeMessage({
      type: 'retiredFloatingReaderAction',
      action: { type: READER_ACTION_TYPES.STOP },
    });

    expect(handled).toBe(false);
    expect(stopReading).not.toHaveBeenCalled();
  });

  it('retries page messages without DOM dependencies', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce({ ok: true });
    const router = createReaderEngineMessageRouter({
      tabs: { sendMessage },
      delay: () => Promise.resolve(),
    });

    await expect(router.sendPageMessage(9, { type: 'ping' }, { attempts: 2 })).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('times out a pending page message attempt so retry handling can continue', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise(() => {}));
    const router = createReaderEngineMessageRouter({
      tabs: { sendMessage },
      delay: () => Promise.resolve(),
    });

    let result = 'pending';
    let settled = false;
    void router.sendPageMessage(9, { type: 'ping' }, { attempts: 1, timeoutMs: 25 }).then((value) => {
      result = value;
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
    expect(result).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps PDF chunk transport retries short after the viewer is ready', async () => {
    const delays = [];
    const sendMessage = vi.fn().mockRejectedValue(new Error('viewer transport unavailable'));
    const router = createReaderEngineMessageRouter({
      tabs: { sendMessage },
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(router.sendPdfViewerMessage(9, { type: MESSAGE_TYPES.GET_PDF_CHUNK })).resolves.toBeNull();

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([80, 80]);
  });

  it('keeps the longer PDF viewer readiness retry budget for metadata', async () => {
    const delays = [];
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('viewer booting'))
      .mockRejectedValueOnce(new Error('viewer booting'))
      .mockRejectedValueOnce(new Error('viewer booting'))
      .mockResolvedValueOnce({ ok: true });
    const router = createReaderEngineMessageRouter({
      tabs: { sendMessage },
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(router.sendPdfViewerMessage(9, { type: MESSAGE_TYPES.GET_PDF_STREAM_METADATA })).resolves.toEqual({ ok: true });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 100, 100]);
  });
});
