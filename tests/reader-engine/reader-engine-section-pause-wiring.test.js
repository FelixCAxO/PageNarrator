import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { createReaderEngineChromeAdapter } from '../../src/app/reader-engine/reader-engine-session.js';
import { createReaderSession } from '../../src/reader/reader-session.js';

const capture = vi.hoisted(() => ({ deps: null, stop: new Error('captured read controls') }));
vi.mock('../../src/lib/reader-engine-read-controls-controller.js', () => ({
  createReaderEngineReadControlsController(deps) {
    capture.deps = deps;
    throw capture.stop;
  },
}));

it('shares and clears a section pause through the real session accessors when paused, resumed, and stopped', async () => {
  const dom = new JSDOM(readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8'));
  const session = createReaderSession({ readingState: 'reading' });
  dom.window.document.getElementById('section-pause').value = '1';
  vi.useFakeTimers();
  try {
    // Stop composition at the controller boundary, retaining the exact production
    // accessors without initializing the rest of the offscreen app or its models.
    const adapter = createReaderEngineChromeAdapter({
      document: dom.window.document, window: dom.window, chrome: globalThis.chrome,
      performance: { now: () => Date.now() },
      productCore: { session, readRunner: {}, ttsService: {}, controller: {} },
    });
    expect(() => adapter.start()).toThrow(capture.stop);
    const { createReaderEngineReadControlsController } = await vi.importActual('../../src/lib/reader-engine-read-controls-controller.js');
    const controls = createReaderEngineReadControlsController({
      ...capture.deps,
      setReadingState: (state) => session.setReadingState(state),
      setPageHighlightPaused: async () => {},
      clearPageHighlight: async () => {},
      clearActiveSpeechPreloads: () => {},
    });
    const waiting = controls.waitBetweenSections(1, 2);
    const settled = vi.fn();
    const result = waiting.then(settled, (error) => error);
    await Promise.resolve();
    expect(capture.deps.state.activeSectionPauseDelay).toMatchObject({ pause: expect.any(Function), resume: expect.any(Function) });
    controls.pauseReading();
    expect(session.state.readingState).toBe('paused');
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).not.toHaveBeenCalled();
    controls.resumeReading();
    expect(session.state.readingState).toBe('reading');
    controls.stopReading();
    expect(await result).toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
    expect(capture.deps.state.activeSectionPauseDelay).toBeNull();
    expect(session.state.readingState).toBe('stopping');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    dom.window.close();
    capture.deps = null;
  }
});
