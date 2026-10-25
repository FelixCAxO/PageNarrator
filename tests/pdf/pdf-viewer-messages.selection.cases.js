import { loadViewer, cleanupViewerDom, installViewerDom, installChromeRuntime, createFakePdfDocument, appendTextLayer, createVisibleEntry, selectRange, sendViewerMessage } from "./pdf-viewer-messages.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PDF viewer message API', () => {
  afterEach(cleanupViewerDom);

  it('returns selected PDF text as page-anchored chunks through getPdfSelection', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument()) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await loadViewer();
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="3"]')).toBeTruthy();
    });

    const pageOne = appendTextLayer(dom.window.document, 1, 'One two three');
    appendTextLayer(dom.window.document, 2, 'Alpha beta gamma delta');
    const pageThree = appendTextLayer(dom.window.document, 3, 'Four five six');
    selectRange(dom, pageOne, 'One '.length, pageThree, 'Four five'.length);

    const response = await sendViewerMessage(listeners[0], { type: 'getPdfSelection' });

    expect(response).toMatchObject({
      ok: true,
      selection: {
        text: 'two three Alpha beta gamma delta Four five',
        pageNumber: 1,
        anchorId: 'pdf-page-1',
        pageCount: 3,
      },
    });
    expect(response.selection.chunks).toEqual([
      expect.objectContaining({ speech: 'two three', anchorId: 'pdf-page-1', pageNumber: 1, domWordOffset: 1 }),
      expect.objectContaining({ speech: 'Alpha beta gamma delta', anchorId: 'pdf-page-2', pageNumber: 2, domWordOffset: 0 }),
      expect.objectContaining({ speech: 'Four five', anchorId: 'pdf-page-3', pageNumber: 3, domWordOffset: 0 }),
    ]);

    // Explicit selection takes priority over a different page start, including
    // when the popup takes focus and the browser selection disappears.
    dom.window.history.replaceState(null, '', '#page=3');
    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart' }))
      .toMatchObject({ startPosition: { source: 'page', pageNumber: 3 } });
    const selectionStart = {
      ok: true,
      startPosition: {
        source: 'selection',
        text: response.selection.text,
        pageNumber: 1,
        anchorId: 'pdf-page-1',
        pageCount: 3,
      },
    };
    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart', readSelection: true }))
      .toEqual(selectionStart);
    dom.window.getSelection().removeAllRanges();
    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart', readSelection: true }))
      .toEqual(selectionStart);
  });

  it('uses the largest visible PDF page for read start and the topmost page for equal areas', async () => {
    vi.resetModules();
    await installViewerDom();
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

    observerCallback([
      createVisibleEntry(observedPages.get(1000), { top: 20, bottom: 620 }),
      createVisibleEntry(observedPages.get(900), { top: 0, bottom: 100 }),
    ]);
    expect(animationFrames.length).toBeGreaterThan(0);

    const response = await sendViewerMessage(listeners[0], { type: 'getReadingStart' });

    expect(response).toEqual({
      ok: true,
      startPosition: {
        source: 'viewport',
        pageNumber: 1000,
        anchorId: 'pdf-page-1000',
      },
    });

    // Reverse geometric order relative to insertion order: ties follow the page
    // nearest the top, not whichever observer entry arrived first.
    observerCallback([
      createVisibleEntry(observedPages.get(1000), { top: 400, bottom: 600 }),
      createVisibleEntry(observedPages.get(900), { top: 80, bottom: 280 }),
    ]);
    expect(await sendViewerMessage(listeners[0], { type: 'getReadingStart' })).toEqual({
      ok: true,
      startPosition: { source: 'viewport', pageNumber: 900, anchorId: 'pdf-page-900' },
    });
  });
});
