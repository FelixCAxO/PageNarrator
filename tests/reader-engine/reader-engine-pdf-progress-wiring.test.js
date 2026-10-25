import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { createReaderEngineChromeAdapter } from '../../src/app/reader-engine/reader-engine-session.js';
import { createReaderSession } from '../../src/reader/reader-session.js';

const capture = vi.hoisted(() => ({ deps: null, stop: new Error('captured reading state renderer') }));
vi.mock('../../src/lib/reader-engine-reading-state-renderer.js', () => ({
  createReaderEngineReadingStateRenderer(deps) {
    capture.deps = deps;
    throw capture.stop;
  },
}));

it('passes the real PDF page count through session wiring into reading and paused progress broadcasts', async () => {
  const dom = new JSDOM(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
  const session = createReaderSession();
  session.startRead({
    source: 'pdf', pdfPageCount: 401,
    chunks: [{ pageNumber: 8, speech: 'Read this scanned page.' }],
  });
  const sendMessage = vi.fn(async () => {});
  const chrome = { ...globalThis.chrome, runtime: { ...globalThis.chrome.runtime, sendMessage } };
  try {
    // Capture the exact production state accessors before app initialization,
    // then exercise the real renderer and callbacks without replacing its state.
    const adapter = createReaderEngineChromeAdapter({
      document: dom.window.document, window: dom.window, chrome,
      performance: { now: () => 0 },
      productCore: { session, readRunner: {}, ttsService: {}, controller: {} },
    });
    expect(() => adapter.start()).toThrow(capture.stop);
    expect.soft(capture.deps.state.activePdfPageCount).toBe(401);

    const { createReaderEngineReadingStateRenderer } = await vi.importActual('../../src/lib/reader-engine-reading-state-renderer.js');
    const renderer = createReaderEngineReadingStateRenderer(capture.deps);
    for (const state of ['reading', 'paused']) {
      renderer.setReadingState(state);
      expect.soft(capture.deps.els.readingProgressLabel.textContent).toBe('Page 8 of 401');
      expect.soft(capture.deps.els.readingRemainingLabel.textContent).toBe('393 pages after this page');
      expect.soft(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        state, progressLabel: 'Page 8 of 401', remainingLabel: '393 pages after this page',
      }));
    }
  } finally {
    dom.window.close();
    capture.deps = null;
  }
});
