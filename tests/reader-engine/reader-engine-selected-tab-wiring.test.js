import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { createReaderEngineChromeAdapter } from '../../src/app/reader-engine/reader-engine-session.js';
import { createReaderSession } from '../../src/reader/reader-session.js';
import { MESSAGE_TYPES, READER_ACTION_TYPES } from '../../src/lib/message-types.js';

const capture = vi.hoisted(() => ({ router: null, stop: new Error('captured complete reader composition') }));
vi.mock('../../src/lib/core/reader-engine-message-router.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createReaderEngineMessageRouter(deps) {
      capture.router = original.createReaderEngineMessageRouter(deps);
      return capture.router;
    },
  };
});
vi.mock('../../src/lib/reader-engine-reading-state-renderer.js', () => ({
  createReaderEngineReadingStateRenderer() {
    throw capture.stop;
  },
}));

it('forwards the clicked tab unchanged through the production router and read-selected controller to the read runner', async () => {
  const dom = new JSDOM(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
  const session = createReaderSession();
  const startPage = vi.fn(async () => {});
  const clickedTab = { id: 42, url: 'https://example.test/clicked-article', title: 'Clicked article' };
  try {
    // Stop before app initialization, preserving the real router, callback
    // wrapper, controller, and startReadPage closure constructed by production.
    const adapter = createReaderEngineChromeAdapter({
      document: dom.window.document, window: dom.window, chrome: globalThis.chrome,
      performance: { now: () => 0 },
      productCore: { session, readRunner: { startPage }, ttsService: {}, controller: {} },
    });
    expect(() => adapter.start()).toThrow(capture.stop);
    capture.router.handleRuntimeMessage({
      type: MESSAGE_TYPES.READER_ENGINE_ACTION,
      action: { type: READER_ACTION_TYPES.READ_SELECTED, tab: clickedTab },
    });
    await Promise.resolve();

    expect(startPage).toHaveBeenCalledOnce();
    expect(startPage).toHaveBeenCalledWith(expect.objectContaining({ readSelection: true, tab: clickedTab, run: expect.any(Function) }));
    expect(startPage.mock.calls[0][0].tab).toBe(clickedTab);
  } finally {
    dom.window.close();
    capture.router = null;
  }
});
