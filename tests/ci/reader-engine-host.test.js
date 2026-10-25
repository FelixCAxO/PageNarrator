import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';
import { ensureReaderEngine, sendReaderEngineAction } from '../../src/lib/reader-engine-host.js';

describe('reader engine host', () => {
  it('delivers Pause through one runtime message when the engine is ready', async () => {
    const sent = [];
    const runtime = {
      getContexts: vi.fn(),
      async sendMessage(message) {
        sent.push(message);
        if (message.type === MESSAGE_TYPES.READER_ENGINE_PING) return { ready: true };
        return undefined;
      },
    };

    await sendReaderEngineAction({
      runtime,
      offscreen: { createDocument: vi.fn() },
      engineUrl: 'src/reader-engine.html?engine=1',
      action: { type: 'togglePlayback' },
    });

    expect(sent.filter((message) => message.type === MESSAGE_TYPES.READER_ENGINE_ACTION)).toEqual([{
      type: MESSAGE_TYPES.READER_ENGINE_ACTION,
      action: { type: 'togglePlayback' },
    }]);
    expect(runtime.getContexts).not.toHaveBeenCalled();
  });

  it('creates the offscreen engine once and waits until it is ready', async () => {
    let pings = 0;
    const runtime = {
      getContexts: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ ready: ++pings >= 3 })),
    };
    const offscreen = { createDocument: vi.fn(async () => {}) };

    await ensureReaderEngine({ runtime, offscreen, engineUrl: 'src/reader-engine.html?engine=1', delay: async () => {} });

    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});
