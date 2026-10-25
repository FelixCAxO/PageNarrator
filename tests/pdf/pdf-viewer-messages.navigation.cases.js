import { loadViewer, cleanupViewerDom, trustedSender, installViewerDom, installChromeRuntime, createFakePdfDocument, createVisibleEntry, sendViewerMessage } from "./pdf-viewer-messages.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PDF viewer message API', () => {
  afterEach(cleanupViewerDom);

  it('does not let stale visible PDF page state override a fresh toolbar page jump', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();
    const observedPages = new Map();
    let observerCallback = null;
    const animationFrames = [];

    globalThis.requestAnimationFrame = (callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    };
    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor(callback) {
        observerCallback = callback;
      }

      observe(target) {
        target.scrollIntoView = vi.fn();
        observedPages.set(Number(target.dataset.pageNumber), target);
      }

      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument(Array.from({ length: 1000 }, (_value, index) => `Page ${index + 1} text`))) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));
    vi.doMock('../../src/lib/pdf-viewer-rendering.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createVirtualPdfPageRenderer() {
          return {
            ensurePageRendered: vi.fn(() => Promise.resolve()),
            unloadPage: vi.fn(),
            getRenderedPageNumbers: vi.fn(() => []),
            setProtectedPageNumbers: vi.fn(),
            destroy: vi.fn(),
          };
        },
      };
    });

    await loadViewer();
    await vi.waitFor(() => {
      expect(observedPages.get(1000)).toBeTruthy();
    });

    observerCallback([createVisibleEntry(observedPages.get(900))]);
    expect(animationFrames.length).toBeGreaterThan(0);

    const pageInput = dom.window.document.getElementById('pdf-page-input');
    pageInput.focus();
    pageInput.value = '1000';
    while (animationFrames.length) animationFrames.shift()();
    expect(pageInput.value).toBe('1000');
    pageInput.dispatchEvent(new dom.window.Event('change'));

    const response = await sendViewerMessage(listeners[0], { type: 'getReadingStart' });

    expect(response).toEqual({
      ok: true,
      startPosition: {
        source: 'page',
        pageNumber: 1000,
        anchorId: 'pdf-page-1000',
      },
    });
    expect(dom.window.location.hash).toBe('#page=1000');
    expect(observedPages.get(1000).scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('retains the active highlight outside the render window until the highlight is cleared', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const renderedPages = new Set();
    const renderer = {
      ensurePageRendered: vi.fn(async (_pdf, _element, pageNumber) => renderedPages.add(pageNumber)),
      unloadPage: vi.fn((pageNumber) => renderedPages.delete(pageNumber)),
      getRenderedPageNumbers: vi.fn(() => [...renderedPages]),
      setProtectedPageNumbers: vi.fn(),
      destroy: vi.fn(() => renderedPages.clear()),
    };
    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument(Array.from({ length: 8 }, (_, index) => `Page ${index + 1}`))) }),
      TextLayer: class TestTextLayer { async render() {} },
    }));
    vi.doMock('../../src/lib/pdf-viewer-rendering.js', async (importOriginal) => ({
      ...await importOriginal(),
      createVirtualPdfPageRenderer: () => renderer,
    }));
    const clearHighlights = vi.fn();
    vi.doMock('../../src/lib/page-highlighter.js', () => ({
      createPageHighlighter: () => ({
        highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
        setHighlightSettings: vi.fn(),
        cancelPendingScroll: vi.fn(),
        clearHighlights,
        dispose: vi.fn(),
      }),
    }));

    await loadViewer();
    await sendViewerMessage(listeners[0], { type: 'getReadingStart' });
    const pageInput = dom.window.document.getElementById('pdf-page-input');
    pageInput.focus();
    pageInput.value = '2';
    expect(await sendViewerMessage(listeners[0], {
      type: 'highlightChunk', anchorId: 'pdf-page-7', text: 'Page 7', chunkText: 'Page 7',
    })).toEqual({ ok: true });
    expect(pageInput.value).toBe('2');
    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([7]);

    pageInput.value = '2';
    pageInput.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect([...renderedPages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7]));
    expect(renderer.unloadPage).not.toHaveBeenCalledWith(7);

    const clearResponse = vi.fn();
    listeners[0]({ type: 'clearHighlight' }, trustedSender, clearResponse);
    expect(clearResponse).toHaveBeenCalledWith({ ok: true });
    expect(clearHighlights).toHaveBeenCalledOnce();
    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([]);
    await vi.waitFor(() => expect([...renderedPages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]));
    expect(renderer.unloadPage).toHaveBeenCalledWith(7);
  });

  it('after a finished read, reports a start only for a page the reader moved to', async () => {
    vi.resetModules();
    await installViewerDom();
    const { listeners } = installChromeRuntime();
    const observedPages = new Map();
    let observerCallback = null;

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor(callback) {
        observerCallback = callback;
      }

      observe(target) {
        target.scrollIntoView = vi.fn();
        observedPages.set(Number(target.dataset.pageNumber), target);
      }

      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument(['One', 'Two', 'Three', 'Four', 'Five'])) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));
    vi.doMock('../../src/lib/pdf-viewer-rendering.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createVirtualPdfPageRenderer() {
          return {
            ensurePageRendered: vi.fn(() => Promise.resolve()),
            unloadPage: vi.fn(),
            getRenderedPageNumbers: vi.fn(() => []),
            setProtectedPageNumbers: vi.fn(),
            destroy: vi.fn(),
          };
        },
      };
    });
    vi.doMock('../../src/lib/page-highlighter.js', () => ({
      createPageHighlighter() {
        return {
          highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
          setHighlightSettings: vi.fn(() => ({})),
          cancelPendingScroll: vi.fn(),
          clearHighlights: vi.fn(),
          dispose: vi.fn(),
        };
      },
    }));

    await loadViewer();
    await vi.waitFor(() => {
      expect(observedPages.get(5)).toBeTruthy();
    });

    // Narration ends on page 4 and the viewer follows it there.
    await sendViewerMessage(listeners[0], { type: 'highlightChunk', anchorId: 'pdf-page-4', text: 'Four', chunkText: 'Four' });
    observerCallback([createVisibleEntry(observedPages.get(4))]);
    listeners[0]({ type: 'clearHighlight' }, trustedSender, () => {});

    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart', afterFinishedRead: true }))
      .toEqual({ ok: true, startPosition: null });
    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart' })).toEqual({
      ok: true,
      startPosition: { source: 'viewport', pageNumber: 4, anchorId: 'pdf-page-4' },
    });

    observerCallback([
      { target: observedPages.get(4), isIntersecting: false, intersectionRect: { width: 0, height: 0 }, boundingClientRect: {} },
      createVisibleEntry(observedPages.get(2)),
    ]);

    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart', afterFinishedRead: true })).toEqual({
      ok: true,
      startPosition: { source: 'viewport', pageNumber: 2, anchorId: 'pdf-page-2' },
    });
  });
});
