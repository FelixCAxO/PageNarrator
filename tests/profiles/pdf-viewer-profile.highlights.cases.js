import { trustedEngineSender, installViewerDom, installChromeRuntime, sendViewerMessage, createFakePdfDocument } from "./pdf-viewer-profile.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PDF viewer memory profile wiring', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete globalThis.chrome;
    delete globalThis.IntersectionObserver;
    delete globalThis.requestAnimationFrame;
    delete globalThis.history;
    delete globalThis.Range;
    delete globalThis.Node;
    delete globalThis.location;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  });

  it('reapplies the active PDF chunk and word after a toolbar layout refresh', async () => {
    vi.resetModules();
    const dom = installViewerDom();
    const listeners = installChromeRuntime();
    const renderer = {
      ensurePageRendered: vi.fn(() => Promise.resolve()),
      unloadPageSoon: vi.fn(),
      unloadPage: vi.fn(),
      getRenderedPageNumbers: vi.fn(() => [1]),
    };
    const highlightChunkByAnchor = vi.fn(() => ({ ok: true }));
    const highlightWordCalls = [];

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument(3)) }),
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
          highlightChunkByAnchor,
          highlightQueuedChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightWord(index, trailLength) {
            highlightWordCalls.push([index, trailLength]);
            return { ok: true };
          },
          highlightWordPlan: vi.fn(() => ({ ok: true })),
          highlightSyntheticSpeech: vi.fn(() => ({ ok: true })),
          setHighlightSettings: vi.fn(() => ({})),
          setPaused: vi.fn(() => ({ ok: true })),
          clearHighlights: vi.fn(),
        };
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="1"]')).toBeTruthy();
    });

    await sendViewerMessage(listeners[0], {
      type: 'highlightChunk',
      anchorId: 'pdf-page-1',
      text: 'Attention Is All You Need',
      chunkText: 'Attention Is All You Need',
      domWordOffset: 2,
    });
    listeners[0]({ type: 'highlightWord', index: 5 }, trustedEngineSender, () => {});

    highlightChunkByAnchor.mockClear();
    highlightWordCalls.length = 0;
    dom.window.document.getElementById('pdf-zoom-in-btn')?.click();

    await vi.waitFor(() => {
      expect(renderer.unloadPage).toHaveBeenCalledWith(1, { force: true });
      expect(renderer.ensurePageRendered).toHaveBeenCalledWith(
        expect.any(Object),
        dom.window.document.querySelector('[data-page-number="1"]'),
        1,
      );
      expect(highlightChunkByAnchor).toHaveBeenCalledWith('pdf-page-1', 'Attention Is All You Need', {
        chunkText: 'Attention Is All You Need',
        domWordOffset: 2,
        preserveWordPlan: true,
      });
      expect(highlightWordCalls).toContainEqual([5, 4]);
    });
  });

  it('pins the actively narrated PDF page and releases it when highlighting is cleared', async () => {
    vi.resetModules();
    const dom = installViewerDom();
    const listeners = installChromeRuntime();
    const renderer = {
      ensurePageRendered: vi.fn(() => Promise.resolve()),
      unloadPageSoon: vi.fn(),
      unloadPage: vi.fn(),
      getRenderedPageNumbers: vi.fn(() => []),
      setProtectedPageNumbers: vi.fn(),
    };
    const highlightChunkByAnchor = vi.fn(() => ({ ok: true }));
    const clearHighlights = vi.fn();

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument(3)) }),
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
          highlightChunkByAnchor,
          highlightQueuedChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightWord: vi.fn(() => ({ ok: true })),
          highlightWordPlan: vi.fn(() => ({ ok: true })),
          highlightSyntheticSpeech: vi.fn(() => ({ ok: true })),
          setHighlightSettings: vi.fn(() => ({})),
          setPaused: vi.fn(() => ({ ok: true })),
          clearHighlights,
        };
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="3"]')).toBeTruthy();
    });

    await sendViewerMessage(listeners[0], {
      type: 'highlightChunk',
      anchorId: 'pdf-page-2',
      text: 'Visible narration text',
      chunkText: 'Visible narration text',
    });

    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([2]);

    await sendViewerMessage(listeners[0], {
      type: 'highlightChunk',
      anchorId: 'pdf-page-3',
      text: 'Next page narration text',
      chunkText: 'Next page narration text',
    });

    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([3]);

    let clearResponse = null;
    const handledSync = listeners[0]({ type: 'clearHighlight' }, trustedEngineSender, (value) => {
      clearResponse = value;
    });

    expect(handledSync).toBe(false);
    expect(clearResponse).toEqual({ ok: true });
    expect(clearHighlights).toHaveBeenCalledTimes(1);
    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([]);
  });
});
