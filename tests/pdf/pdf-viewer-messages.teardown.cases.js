import { loadViewer, cleanupViewerDom, trustedSender, installViewerDom, installChromeRuntime, createFakePdfDocument, sendViewerMessage } from "./pdf-viewer-messages.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PDF viewer message API', () => {
  afterEach(cleanupViewerDom);

  it('tears down viewer-owned PDF resources on pagehide so article reads can return to lower memory', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();
    const observerDisconnects = [];
    const observerInstances = [];
    const renderer = {
      ensurePageRendered: vi.fn(() => Promise.resolve()),
      unloadPageSoon: vi.fn(),
      unloadPage: vi.fn(),
      getRenderedPageNumbers: vi.fn(() => []),
      setProtectedPageNumbers: vi.fn(),
      destroy: vi.fn(),
    };
    const clearHighlights = vi.fn();
    const dispose = vi.fn();
    const pdfDocument = createFakePdfDocument([
      'First page text',
      'Second page text',
    ]);
    pdfDocument.destroy = vi.fn(() => Promise.resolve());
    const loadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn(() => Promise.resolve()),
    };

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor() {
        this.disconnect = vi.fn(() => observerDisconnects.push(this));
        observerInstances.push(this);
      }

      observe() {}
      unobserve() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => loadingTask,
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));
    vi.doMock('../../src/lib/pdf-viewer-rendering.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createVirtualPdfPageRenderer() {
          return renderer;
        },
      };
    });
    vi.doMock('../../src/lib/page-highlighter.js', () => ({
      createPageHighlighter() {
        return {
          highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightQueuedChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightWord: vi.fn(() => ({ ok: true })),
          highlightWordPlan: vi.fn(() => ({ ok: true })),
          highlightSyntheticSpeech: vi.fn(() => ({ ok: true })),
          setHighlightSettings: vi.fn(() => ({})),
          setPaused: vi.fn(() => ({ ok: true })),
          cancelPendingScroll: vi.fn(),
          clearHighlights,
          dispose,
        };
      },
    }));

    await loadViewer();
    await vi.waitFor(() => {
      expect(dom.window.document.querySelectorAll('[data-page-number]')).toHaveLength(2);
    });

    await sendViewerMessage(listeners[0], {
      type: 'getPdfChunk',
      streamId: 'cleanup-stream',
      startPage: 1,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
    });

    renderer.destroy.mockClear();
    dispose.mockClear();
    const activeObserver = observerInstances.at(-1);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));

    await vi.waitFor(() => {
      expect(renderer.destroy).toHaveBeenCalledTimes(1);
      expect(clearHighlights).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
      expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
      expect(observerDisconnects.length).toBeGreaterThan(0);
      expect(dom.window.document.getElementById('pdf-pages').childElementCount).toBe(0);
    });
    expect(activeObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([]);

    // A second route to teardown must not destroy the same document/resources twice.
    const teardownResponse = vi.fn();
    listeners[0]({ type: 'tearDownPdfViewer' }, trustedSender, teardownResponse);
    listeners[0]({ type: 'tearDownPdfViewer' }, trustedSender, teardownResponse);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    expect(teardownResponse).toHaveBeenCalledTimes(2);
    expect(teardownResponse).toHaveBeenLastCalledWith({ ok: true });
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(clearHighlights).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(activeObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });
});
