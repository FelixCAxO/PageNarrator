import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

function installViewerDom({
  url = 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fmixed.pdf',
} = {}) {
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
    url,
  });

  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ tag: 'canvas-context' });
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
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

  return dom;
}

function installChromeRuntime() {
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener() {},
      },
    },
  };
}

function createMixedSizePdfDocument() {
  const sizes = new Map([
    [1, { width: 600, height: 800 }],
    [2, { width: 400, height: 1000 }],
  ]);

  return {
    numPages: 2,
    async getPage(pageNumber) {
      const size = sizes.get(pageNumber);
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
          const rotated = rotation % 180 === 0
            ? size
            : { width: size.height, height: size.width };
          return {
            width: rotated.width * scale,
            height: rotated.height * scale,
            scale,
            rotation,
          };
        },
      };
    },
  };
}

function createUniformPdfDocument(pageCount = 1300) {
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

function pageSize(pageEl) {
  return {
    width: pageEl.style.width,
    height: pageEl.style.height,
  };
}

describe('PDF viewer fit layout stability', () => {
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
  });

  it.each([
    ['pdf-fit-page-btn', { width: '291px', height: '728px' }],
    ['pdf-fit-width-btn', { width: '984px', height: '2460px' }],
  ])('keeps %s dimensions stable when mouse scrolling renders mixed-size pages', async (buttonId, expectedSize) => {
    vi.resetModules();
    const dom = installViewerDom();
    installChromeRuntime();
    const observerCallbacks = [];

    globalThis.IntersectionObserver = class TestIntersectionObserver {
      constructor(callback) {
        observerCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    };

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(createMixedSizePdfDocument()) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(dom.window.document.querySelectorAll('[data-page-number]')).toHaveLength(2);
    });

    const pageTwo = dom.window.document.querySelector('[data-page-number="2"]');
    dom.window.document.getElementById(buttonId)?.click();

    await vi.waitFor(() => {
      expect(pageSize(pageTwo)).toEqual(expectedSize);
    });
    const sizeBeforeScrollRender = pageSize(pageTwo);

    observerCallbacks.at(-1)([{ target: pageTwo, isIntersecting: true }]);
    await vi.waitFor(() => {
      expect(pageTwo.querySelector('canvas')).toBeTruthy();
    });

    expect(pageSize(pageTwo)).toEqual(sizeBeforeScrollRender);
  });

  it('keeps the current page anchored when fit mode changes page heights', async () => {
    vi.resetModules();
    const dom = installViewerDom({
      url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Flarge.pdf#page=541',
    });
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
      getDocument: () => ({ promise: Promise.resolve(createUniformPdfDocument(1300)) }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await import('../../src/pdf-viewer.js');
    await vi.waitFor(() => {
      expect(dom.window.document.getElementById('pdf-page-input').value).toBe('541');
    });

    const page541 = observedPages.get(541);
    const page1212 = observedPages.get(1212);
    dom.window.document.getElementById('pdf-fit-page-btn')?.click();
    observerCallback([createVisibleEntry(page1212)]);

    await vi.waitFor(() => {
      expect(dom.window.document.getElementById('pdf-page-input').value).toBe('541');
    });
    expect(dom.window.location.hash).toBe('#page=541');
    expect(page541.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });
});
