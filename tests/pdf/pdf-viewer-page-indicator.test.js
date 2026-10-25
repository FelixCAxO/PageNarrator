import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

function installViewerDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <header class="viewer-header">
      <p id="pdf-status">Loading document...</p>
      <div id="pdf-toolbar">
        <input id="pdf-page-input" type="number">
        <span id="pdf-page-count"></span>
        <button id="pdf-zoom-out-btn" type="button"></button>
        <span id="pdf-zoom-label"></span>
        <button id="pdf-zoom-in-btn" type="button"></button>
        <button id="pdf-rotate-left-btn" type="button"></button>
        <button id="pdf-rotate-right-btn" type="button"></button>
        <button id="pdf-fit-width-btn" type="button"></button>
        <button id="pdf-fit-page-btn" type="button"></button>
      </div>
    </header>
    <main id="pdf-pages" class="pdf-pages" aria-label="PDF pages"></main>
  `, {
    pretendToBeVisual: true,
    url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf',
  });

  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ tag: 'canvas-context' });
  Object.defineProperty(dom.window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 768, configurable: true });
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 1, configurable: true });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.Node = dom.window.Node;
  globalThis.Range = dom.window.Range;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 0;
  };
  globalThis.IntersectionObserver = class TestIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  return dom;
}

function installChromeRuntime() {
  globalThis.chrome = {
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
      onMessage: {
        addListener() {},
      },
    },
  };
}

function createFakePdfDocument(pageCount = 3) {
  return {
    numPages: pageCount,
    async getPage(pageNumber) {
      return {
        pageNumber,
        cleanup: vi.fn(),
        render: vi.fn(() => ({
          cancel: vi.fn(),
          promise: Promise.resolve(),
        })),
        async getTextContent() {
          return { items: [] };
        },
        getViewport({ scale, rotation = 0 }) {
          const base = rotation % 180 === 0
            ? { width: 600, height: 800 }
            : { width: 800, height: 600 };
          return {
            width: base.width * scale,
            height: base.height * scale,
            scale,
            rotation,
          };
        },
      };
    },
  };
}

function createVisibleEntry(target, {
  top = 80,
  bottom = 760,
  left = 0,
  right = 600,
} = {}) {
  return {
    target,
    isIntersecting: true,
    boundingClientRect: {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
    },
    intersectionRect: {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
    },
  };
}

describe('PDF viewer page indicator', () => {
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  });

  it('preserves a focused page edit while scrolling updates the current page', async () => {
    vi.resetModules();
    const dom = installViewerDom();
    installChromeRuntime();
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
      getDocument: () => ({ promise: Promise.resolve(createFakePdfDocument()) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="3"]')).toBeTruthy();
    });

    const pageInput = dom.window.document.getElementById('pdf-page-input');
    for (const pageEl of dom.window.document.querySelectorAll('[data-page-number]')) {
      pageEl.getBoundingClientRect = () => {
        throw new Error('current page detection should use observer geometry instead of scanning all pages');
      };
    }

    pageInput.focus();
    pageInput.value = '1000';
    observerCallback([createVisibleEntry(observedPages.get(2))]);

    expect(pageInput.value).toBe('1000');
    expect(dom.window.location.hash).toBe('#page=2');
    expect(pageInput.getAttribute('aria-label')).toBe('Page 2 of 3');
    pageInput.blur();
    observerCallback([
      { target: observedPages.get(2), isIntersecting: false, intersectionRect: {}, boundingClientRect: {} },
      createVisibleEntry(observedPages.get(3)),
    ]);
    expect(pageInput.value).toBe('3');
  });

  it('keeps the page that fills the view current, and reading starts there, when the next page peeks in', async () => {
    vi.resetModules();
    const dom = installViewerDom();
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        id: 'test',
        getURL: (path) => `chrome-extension://test/${path}`,
        getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
        onMessage: { addListener: (listener) => listeners.push(listener) },
      },
    };
    const observedPages = new Map();
    const observerOptions = [];
    let observerCallback = null;

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor(callback, options) {
        observerCallback = callback;
        observerOptions.push(options);
      }

      observe(target) {
        observedPages.set(Number(target.dataset.pageNumber), target);
      }

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

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(observedPages.get(3)).toBeTruthy();
    });

    // Visible shares are reported as they change, not only when a page enters or leaves.
    expect(observerOptions.at(-1).threshold).toEqual(expect.arrayContaining([0, 0.05, 0.5, 0.95, 1]));

    const pageInput = dom.window.document.getElementById('pdf-page-input');
    observerCallback([
      createVisibleEntry(observedPages.get(1), { top: 0, bottom: 700 }),
      createVisibleEntry(observedPages.get(2), { top: 716, bottom: 768 }),
    ]);
    expect(pageInput.value).toBe('1');

    observerCallback([
      createVisibleEntry(observedPages.get(1), { top: 0, bottom: 100 }),
      createVisibleEntry(observedPages.get(2), { top: 116, bottom: 768 }),
    ]);
    expect(pageInput.value).toBe('2');

    // Page 2 still fills the view without crossing a threshold while page 1 leaves and page 3 peeks in.
    observerCallback([
      { target: observedPages.get(1), isIntersecting: false, intersectionRect: { width: 0, height: 0 }, boundingClientRect: {} },
      createVisibleEntry(observedPages.get(3), { top: 740, bottom: 768 }),
    ]);

    expect(pageInput.value).toBe('2');
    expect(dom.window.location.hash).toBe('#page=2');
    const response = await new Promise((resolve) => {
      expect(listeners[0]({ type: 'getReadingStart' }, {
        id: 'test',
        url: 'chrome-extension://test/src/reader-engine.html',
        origin: 'chrome-extension://test',
        frameId: 0,
      }, resolve)).toBe(true);
    });
    expect(response).toEqual({
      ok: true,
      startPosition: { source: 'viewport', pageNumber: 2, anchorId: 'pdf-page-2' },
    });
  });
});
