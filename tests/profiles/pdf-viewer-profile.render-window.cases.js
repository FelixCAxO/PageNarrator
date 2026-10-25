import { trustedEngineSender, installViewerDom, installChromeRuntime, sendViewerMessage, createFakePdfDocument, createTrackingRenderer, getRenderedPageNumbers, createVisibleEntry } from "./pdf-viewer-profile.fixtures.js";

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

  it('uses the large-document profile for a bounded startup render window and word highlighting', async () => {
    vi.resetModules();
    const dom = installViewerDom({
      url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Flarge.pdf#page=10',
    });
    const listeners = installChromeRuntime();
    const observerOptions = [];
    const rendererOptions = [];
    const highlighterOptions = [];
    const highlighterDisposes = [];
    const highlightWordCalls = [];
    const highlightWordPlanCalls = [];
    const resyncWordPlanCalls = [];
    const pdfDocument = createFakePdfDocument(120);
    const renderer = createTrackingRenderer();

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor(_callback, options) {
        observerOptions.push(options);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdfDocument) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));
    vi.doMock('../../src/lib/pdf-viewer-rendering.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createVirtualPdfPageRenderer(options) {
          rendererOptions.push(options);
          return renderer;
        },
      };
    });
    vi.doMock('../../src/lib/page-highlighter.js', () => ({
      createPageHighlighter(_document, options) {
        highlighterOptions.push(options);
        return {
          highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightQueuedChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightWord(index, trailLength) {
            highlightWordCalls.push([index, trailLength]);
            return { ok: true };
          },
          highlightWordPlan(plan, options) {
            highlightWordPlanCalls.push([plan, options]);
            return { ok: true, scheduled: plan.length };
          },
          resyncWordPlan(options) {
            resyncWordPlanCalls.push(options);
            return { ok: true, scheduled: 1 };
          },
          highlightSyntheticSpeech: vi.fn(() => ({ ok: true })),
          setHighlightSettings: vi.fn(() => ({})),
          setPaused: vi.fn(() => ({ ok: true })),
          cancelPendingScroll: vi.fn(),
          clearHighlights: vi.fn(),
          dispose: vi.fn(() => highlighterDisposes.push(options)),
        };
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(getRenderedPageNumbers(renderer)).toEqual([10, 11]);
    });

    expect(pdfDocument.getPage).toHaveBeenCalledTimes(1);
    expect(pdfDocument.getPage).toHaveBeenCalledWith(10);
    expect(dom.window.document.querySelector('[data-page-number="10"]')).toBeTruthy();
    expect(rendererOptions.at(-1).maxRenderedPages).toBe(2);
    expect(rendererOptions.at(-1).unloadDelayMs).toBe(150);
    expect(observerOptions.at(-1)).toEqual({
      rootMargin: '0px 0px',
      threshold: Array.from({ length: 21 }, (_, index) => index / 20),
    });
    expect(highlighterDisposes).toHaveLength(1);
    expect(highlighterOptions.at(-1)).toMatchObject({
      pdfMode: true,
      defaultWordTrailLength: 4,
      showQueuedRegion: false,
      preferCssOnlyRegion: true,
    });

    let response = null;
    const handledAsync = listeners[0]({ type: 'highlightWord', index: 4 }, trustedEngineSender, (value) => {
      response = value;
    });

    expect(handledAsync).toBe(false);
    expect(response).toEqual({ ok: true });
    expect(highlightWordCalls).toEqual([[4, 4]]);

    response = null;
    const handledPlan = listeners[0]({
      type: 'highlightWordPlan',
      plan: [{ index: 4, start: 0.12, end: 0.3 }],
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0.06,
    }, trustedEngineSender, (value) => {
      response = value;
    });

    expect(handledPlan).toBe(false);
    expect(response).toEqual({ ok: true, scheduled: 1 });
    expect(highlightWordPlanCalls).toEqual([[
      [{ index: 4, start: 0.12, end: 0.3 }],
      expect.objectContaining({
        currentTime: 0,
        playbackRate: 1,
        leadSeconds: 0.06,
        trailLength: 4,
      }),
    ]]);

    response = null;
    const handledResync = listeners[0]({
      type: 'highlightPlanResync',
      currentTime: 0.22,
      playbackRate: 1.5,
      paused: false,
    }, trustedEngineSender, (value) => {
      response = value;
    });

    expect(handledResync).toBe(false);
    expect(response).toEqual({ ok: true, scheduled: 1 });
    expect(resyncWordPlanCalls).toEqual([expect.objectContaining({
      currentTime: 0.22,
      playbackRate: 1.5,
      paused: false,
    })]);
  });

  it('slides, jumps, and protects the deterministic PDF render window', async () => {
    vi.resetModules();
    const dom = installViewerDom({
      url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Flarge.pdf#page=10',
    });
    const listeners = installChromeRuntime();
    const pdfDocument = createFakePdfDocument(120);
    const renderer = createTrackingRenderer();
    const observedPages = new Map();
    let observerCallback = null;

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
      getDocument: () => ({ promise: Promise.resolve(pdfDocument) }),
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
          cancelPendingScroll: vi.fn(),
          highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightQueuedChunkByAnchor: vi.fn(() => ({ ok: true })),
          highlightWord: vi.fn(() => ({ ok: true })),
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
      expect(getRenderedPageNumbers(renderer)).toEqual([10, 11]);
    });

    await sendViewerMessage(listeners[0], {
      type: 'highlightChunk',
      anchorId: 'pdf-page-50',
      text: 'Protected narration page',
      chunkText: 'Protected narration page',
    });

    // The viewer follows narration to its page (follow reading), so the window moves to 50.
    await vi.waitFor(() => {
      expect(getRenderedPageNumbers(renderer)).toEqual([50, 51]);
    });
    expect(dom.window.document.getElementById('pdf-page-input').value).toBe('50');
    expect(renderer.setProtectedPageNumbers).toHaveBeenLastCalledWith([50]);

    renderer.ensurePageRendered.mockClear();
    renderer.unloadPage.mockClear();
    observerCallback([createVisibleEntry(observedPages.get(11))]);

    // A manual scroll away keeps the narrated page rendered alongside the visible window.
    await vi.waitFor(() => {
      expect(getRenderedPageNumbers(renderer)).toEqual([11, 12, 50]);
    });
    expect(renderer.ensurePageRendered).toHaveBeenCalledWith(
      expect.any(Object),
      observedPages.get(12),
      12,
    );
    expect(renderer.unloadPage).toHaveBeenCalledWith(51);
    expect(renderer.unloadPage).not.toHaveBeenCalledWith(50, expect.anything());

    renderer.ensurePageRendered.mockClear();
    renderer.unloadPage.mockClear();
    const pageInput = dom.window.document.getElementById('pdf-page-input');
    pageInput.value = '50';
    pageInput.dispatchEvent(new dom.window.Event('change'));

    await vi.waitFor(() => {
      expect(getRenderedPageNumbers(renderer)).toEqual([50, 51]);
    });
    expect(renderer.ensurePageRendered.mock.calls.map((call) => call[2]).sort((a, b) => a - b)).toEqual([50, 51]);
    expect(renderer.unloadPage.mock.calls.map((call) => call[0]).sort((a, b) => a - b)).toEqual([11, 12]);
  });
});
