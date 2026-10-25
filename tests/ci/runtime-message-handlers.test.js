import { describe, expect, it, vi } from 'vitest';
import {
  asyncResponse,
  createRuntimeMessageHandler,
  fireAndForget,
  syncResponse,
} from '../../src/lib/runtime-message-handlers.js';

describe('runtime message handler contract', () => {
  it('keeps the Chrome message channel open for async routes and sends the resolved response', async () => {
    const sendResponse = vi.fn();
    const handler = createRuntimeMessageHandler({
      handlers: {
        loadData: asyncResponse(async (message, sender) => ({
          ok: true,
          id: message.id,
          tabId: sender.tab.id,
        })),
      },
    });

    const keepOpen = handler({ type: 'loadData', id: 17 }, { tab: { id: 4 } }, sendResponse);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, id: 17, tabId: 4 });
    });

    expect(keepOpen).toBe(true);
  });

  it('sends synchronous route responses immediately and closes the channel', () => {
    const sendResponse = vi.fn();
    const handler = createRuntimeMessageHandler({
      handlers: {
        ping: syncResponse(() => ({ ok: true })),
      },
    });

    expect(handler({ type: 'ping' }, {}, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('runs fire-and-forget routes without responding and reports rejected work', async () => {
    const sendResponse = vi.fn();
    const onError = vi.fn();
    const error = new Error('background write failed');
    const handler = createRuntimeMessageHandler({
      handlers: {
        writeLater: fireAndForget(async () => {
          throw error;
        }),
      },
      onError,
    });

    expect(handler({ type: 'writeLater' }, {}, sendResponse)).toBe(false);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(error, { type: 'writeLater' });
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('serializes async errors into response objects including optional error codes', async () => {
    const sendResponse = vi.fn();
    const stale = new Error('PDF viewer stream is stale.');
    stale.code = 'stale_pdf_stream';
    const handler = createRuntimeMessageHandler({
      handlers: {
        getPdfChunk: asyncResponse(async () => {
          throw stale;
        }),
      },
    });

    expect(handler({ type: 'getPdfChunk' }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'PDF viewer stream is stale.',
        code: 'stale_pdf_stream',
      });
    });
  });

  it('ignores unrecognized messages without sending a response', () => {
    const sendResponse = vi.fn();
    const onUnhandled = vi.fn();
    const handler = createRuntimeMessageHandler({
      handlers: {
        ping: syncResponse(() => ({ ok: true })),
      },
      onUnhandled,
    });

    expect(handler({ type: 'unknown' }, { tab: { id: 1 } }, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(onUnhandled).toHaveBeenCalledWith({ type: 'unknown' }, { tab: { id: 1 } });
  });
});
