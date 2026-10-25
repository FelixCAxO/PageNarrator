import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextLayer } from '../../src/pdf/pdf-engine.js';
import {
  MAX_OUTPUT_SCALE,
  applyPageViewportStyles,
  createPdfPagePlaceholder,
  createVirtualPdfPageRenderer,
  getPdfRenderWindowPageNumbers,
  getCappedOutputScale,
} from '../../src/lib/pdf-viewer-rendering.js';

function createDom() {
  const dom = new JSDOM('<!doctype html><main id="pages"></main>', {
    pretendToBeVisual: true,
    url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf',
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ tag: 'canvas-context' });
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2, configurable: true });
  return dom;
}

function createFakePdf() {
  const pages = new Map();
  return {
    pages,
    async getPage(pageNumber) {
      const page = {
        pageNumber,
        view: [0, 0, 600, 800],
        cleanup: vi.fn(),
        render: vi.fn(() => ({
          cancel: vi.fn(),
          promise: Promise.resolve(),
        })),
        async getTextContent() {
          return {
            items: [
              {
                str: `Page ${pageNumber}`,
                transform: [1, 0, 0, 1, 72, 720],
                height: 12,
                width: 48,
              },
            ],
          };
        },
        getViewport({ scale }) {
          return {
            width: 600 * scale,
            height: 800 * scale,
          };
        },
      };
      pages.set(pageNumber, page);
      return page;
    },
  };
}

describe('PDF viewer rendering virtualization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels an original selectable layer awaiting fonts when its page unloads', async () => {
    const dom = createDom(), document = dom.window.document, annotations = vi.fn(); let releaseFonts;
    const page = createRenderPage(1); page.ensureFonts = () => new Promise(resolve => { releaseFonts = resolve; });
    const renderer = createVirtualPdfPageRenderer({ documentRef: document, windowRef: dom.window, pdfjs: { TextLayer }, annotateTextLayer: annotations, getPageScale: () => 1 });
    const element = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 }); document.getElementById('pages').append(element);
    const rendering = renderer.ensurePageRendered({ getPage: async () => page }, element, 1);
    await vi.waitFor(() => expect(releaseFonts).toBeTypeOf('function')); renderer.unloadPage(1);
    releaseFonts(); await expect(rendering).resolves.toBeNull();
    expect(element.childElementCount).toBe(0); expect(annotations).not.toHaveBeenCalled(); expect(page.cleanup).toHaveBeenCalledTimes(1);
    renderer.destroy(); dom.window.close();
  });
  it('keeps a replacement page when an older cancelled text-layer promise finishes late', async () => {
    const dom = createDom(), document = dom.window.document, pages = [createRenderPage(1), createRenderPage(1)]; let releaseOld, count = 0;
    const renderer = createVirtualPdfPageRenderer({ documentRef: document, windowRef: dom.window, getPageScale: () => 1, pdfjs: {
      TextLayer: class {
        constructor({ container }) { this.container = container; }
        render() {
          if (++count === 1) return new Promise((_resolve, reject) => { releaseOld = () => { const error = new Error('cancelled'); error.name = 'RenderingCancelledException'; reject(error); }; });
          this.container.textContent = 'Replacement selectable layer'; return Promise.resolve();
        }
        cancel() {}
      }
    } });
    const element = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 }); document.getElementById('pages').append(element);
    const pdf = { getPage: async () => pages.shift() }, first = renderer.ensurePageRendered(pdf, element, 1);
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function')); renderer.unloadPage(1);
    await renderer.ensurePageRendered(pdf, element, 1); releaseOld(); await expect(first).resolves.toBeNull();
    expect(renderer.getRenderedPageNumbers()).toEqual([1]); expect(element.textContent).toBe('Replacement selectable layer');
    renderer.destroy(); dom.window.close();
  });

  it('creates fixed-size placeholders so scroll height does not require rendered canvases', () => {
    const dom = createDom();
    const pageEl = createPdfPagePlaceholder(dom.window.document, 12, {
      width: 612.8,
      height: 792.4,
    });

    expect(pageEl.tagName).toBe('SECTION');
    expect(pageEl.className).toBe('pdf-page');
    expect(pageEl.dataset.pageNumber).toBe('12');
    expect(pageEl.dataset.pagenarratorId).toBe('pdf-page-12');
    expect(pageEl.style.getPropertyValue('--total-scale-factor')).toBe('1');
    expect(pageEl.style.getPropertyValue('--scale-round-x')).toBe('1px');
    expect(pageEl.style.width).toBe('612px');
    expect(pageEl.style.height).toBe('792px');
    expect(pageEl.childElementCount).toBe(0);
  });

  it('caps canvas backing scale at the memory-saver default', () => {
    expect(MAX_OUTPUT_SCALE).toBe(1);
    expect(getCappedOutputScale(2)).toBe(1);
    expect(getCappedOutputScale(0.75)).toBe(0.75);
    expect(getCappedOutputScale(Number.NaN)).toBe(1);
  });

  it('builds a clamped deterministic render window around the current PDF page', () => {
    const profile = { preloadBehind: 2, preloadAhead: 2 };

    expect(getPdfRenderWindowPageNumbers(10, { pageCount: 100, ...profile })).toEqual([8, 9, 10, 11, 12]);
    expect(getPdfRenderWindowPageNumbers(11, { pageCount: 100, ...profile })).toEqual([9, 10, 11, 12, 13]);
    expect(getPdfRenderWindowPageNumbers(50, { pageCount: 100, ...profile })).toEqual([48, 49, 50, 51, 52]);
    expect(getPdfRenderWindowPageNumbers(1, { pageCount: 100, ...profile })).toEqual([1, 2, 3]);
    expect(getPdfRenderWindowPageNumbers(100, { pageCount: 100, ...profile })).toEqual([98, 99, 100]);
  });

  it('keeps only the newest rendered pages connected and cleans unloaded pages', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderedTextLayers = [];
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          constructor({ container }) {
            this.container = container;
          }

          async render() {
            renderedTextLayers.push(this.container);
          }
        },
      },
      maxRenderedPages: 2,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const first = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    const second = createPdfPagePlaceholder(document, 2, { width: 600, height: 800 });
    const third = createPdfPagePlaceholder(document, 3, { width: 600, height: 800 });
    document.getElementById('pages').append(first, second, third);

    await renderer.ensurePageRendered(pdf, first, 1);
    await renderer.ensurePageRendered(pdf, second, 2);
    await renderer.ensurePageRendered(pdf, third, 3);

    expect(renderer.getRenderedPageNumbers()).toEqual([2, 3]);
    expect(first.childElementCount).toBe(0);
    expect(second.querySelector('canvas')).toBeTruthy();
    expect(third.querySelector('canvas')).toBeTruthy();
    expect(third.style.getPropertyValue('--total-scale-factor')).toBe('1');
    expect(third.querySelector('canvas').width).toBe(600);
    expect(third.querySelector('canvas').height).toBe(800);
    expect(pdf.pages.get(1).cleanup).toHaveBeenCalledTimes(1);
    expect(renderedTextLayers).toHaveLength(3);
  });

  it('evicts the rendered page farthest from the requested page', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 3,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const pages = [1, 2, 3, 10].map((pageNumber) => {
      const pageEl = createPdfPagePlaceholder(document, pageNumber, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);
      return pageEl;
    });

    await renderer.ensurePageRendered(pdf, pages[0], 1);
    await renderer.ensurePageRendered(pdf, pages[1], 2);
    await renderer.ensurePageRendered(pdf, pages[3], 10);
    await renderer.ensurePageRendered(pdf, pages[2], 3);

    expect(renderer.getRenderedPageNumbers().sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(pages[3].childElementCount).toBe(0);
    expect(pdf.pages.get(10).cleanup).toHaveBeenCalledTimes(1);
    expect(pages[0].querySelector('canvas')).toBeTruthy();
    expect(pages[1].querySelector('canvas')).toBeTruthy();
    expect(pages[2].querySelector('canvas')).toBeTruthy();
  });

  it('keeps protected narrated pages rendered when scroll observation asks to unload them', async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 1,
      unloadDelayMs: 25,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const narratedPage = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    document.getElementById('pages').append(narratedPage);

    await renderer.ensurePageRendered(pdf, narratedPage, 1);
    expect(narratedPage.querySelector('canvas')).toBeTruthy();
    expect(typeof renderer.setProtectedPageNumbers).toBe('function');

    renderer.setProtectedPageNumbers([1]);
    renderer.unloadPageSoon(1);
    await vi.advanceTimersByTimeAsync(30);

    expect(renderer.getRenderedPageNumbers()).toEqual([1]);
    expect(narratedPage.querySelector('canvas')).toBeTruthy();
    expect(pdf.pages.get(1).cleanup).not.toHaveBeenCalled();
  });

  it('evicts unprotected pages before protected narrated pages under a one-page render budget', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 1,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const pages = [1, 2, 3].map((pageNumber) => {
      const pageEl = createPdfPagePlaceholder(document, pageNumber, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);
      return pageEl;
    });

    await renderer.ensurePageRendered(pdf, pages[0], 1);
    expect(typeof renderer.setProtectedPageNumbers).toBe('function');
    renderer.setProtectedPageNumbers([1]);

    await renderer.ensurePageRendered(pdf, pages[1], 2);
    expect(renderer.getRenderedPageNumbers().sort((a, b) => a - b)).toEqual([1, 2]);

    await renderer.ensurePageRendered(pdf, pages[2], 3);

    expect(renderer.getRenderedPageNumbers().sort((a, b) => a - b)).toEqual([1, 3]);
    expect(pages[0].querySelector('canvas')).toBeTruthy();
    expect(pages[1].childElementCount).toBe(0);
    expect(pages[2].querySelector('canvas')).toBeTruthy();
    expect(pdf.pages.get(1).cleanup).not.toHaveBeenCalled();
    expect(pdf.pages.get(2).cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not count protected narrated pages against the regular render-window budget', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 5,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const pageElements = [8, 9, 10, 11, 12, 50].map((pageNumber) => {
      const pageEl = createPdfPagePlaceholder(document, pageNumber, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);
      return [pageNumber, pageEl];
    });
    const pagesByNumber = new Map(pageElements);

    await renderer.ensurePageRendered(pdf, pagesByNumber.get(50), 50);
    renderer.setProtectedPageNumbers([50]);
    for (const pageNumber of [8, 9, 10, 11, 12]) {
      await renderer.ensurePageRendered(pdf, pagesByNumber.get(pageNumber), pageNumber);
    }

    expect(renderer.getRenderedPageNumbers().sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 50]);
    expect(pagesByNumber.get(50).querySelector('canvas')).toBeTruthy();
    expect(pdf.pages.get(50).cleanup).not.toHaveBeenCalled();
  });

  it('destroys every rendered PDF page and cancels delayed unloads when the viewer leaves', async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 3,
      unloadDelayMs: 25,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });

    const pages = [1, 2].map((pageNumber) => {
      const pageEl = createPdfPagePlaceholder(document, pageNumber, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);
      return pageEl;
    });

    await renderer.ensurePageRendered(pdf, pages[0], 1);
    await renderer.ensurePageRendered(pdf, pages[1], 2);
    renderer.setProtectedPageNumbers([1]);
    renderer.unloadPageSoon(2);

    expect(typeof renderer.destroy).toBe('function');
    renderer.destroy();
    await vi.advanceTimersByTimeAsync(30);

    expect(renderer.getRenderedPageNumbers()).toEqual([]);
    expect(pages[0].childElementCount).toBe(0);
    expect(pages[1].childElementCount).toBe(0);
    expect(pdf.pages.get(1).cleanup).toHaveBeenCalledTimes(1);
    expect(pdf.pages.get(2).cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([0, 90, 180, 270])('passes the source view and intrinsic %i-degree rotation to text-layer annotation', async (pageRotation) => {
    const dom = createDom();
    const pdf = createFakePdf();
    const getPage = pdf.getPage.bind(pdf);
    pdf.getPage = async number => Object.assign(await getPage(number), { rotate: pageRotation });
    const annotateTextLayer = vi.fn();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: dom.window.document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      getPageScale: () => 1,
      annotateTextLayer,
    });
    const pageEl = createPdfPagePlaceholder(dom.window.document, 1, { width: 600, height: 800 });
    dom.window.document.getElementById('pages').append(pageEl);

    await renderer.ensurePageRendered(pdf, pageEl, 1);

    expect(annotateTextLayer).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      { pageView: [0, 0, 600, 800], pageRotation },
    );
  });

  it('synchronously releases a PDF canvas backing store when a page unloads', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 1,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });
    const pageEl = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    document.getElementById('pages').append(pageEl);

    await renderer.ensurePageRendered(pdf, pageEl, 1);
    const canvas = pageEl.querySelector('canvas');
    const renderTask = pdf.pages.get(1).render.mock.results[0].value;

    renderer.unloadPage(1);

    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(pageEl.childElementCount).toBe(0);
    expect(renderTask.cancel).toHaveBeenCalledTimes(1);
    expect(pdf.pages.get(1).cleanup).toHaveBeenCalledTimes(1);
  });

  it('reuses released PDF render canvases instead of allocating one per page jump', async () => {
    const dom = createDom();
    const document = dom.window.document;
    const createdCanvases = [];
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = (tagName, ...args) => {
      const element = originalCreateElement(tagName, ...args);
      if (String(tagName).toLowerCase() === 'canvas') createdCanvases.push(element);
      return element;
    };
    const pdf = createFakePdf();
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 1,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });
    const first = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    const second = createPdfPagePlaceholder(document, 2, { width: 600, height: 800 });
    document.getElementById('pages').append(first, second);

    await renderer.ensurePageRendered(pdf, first, 1);
    const firstCanvas = first.querySelector('canvas');
    renderer.unloadPage(1);
    await renderer.ensurePageRendered(pdf, second, 2);

    expect(second.querySelector('canvas')).toBe(firstCanvas);
    expect(createdCanvases).toHaveLength(1);
  });

  it('keeps PDF.js text-layer CSS variables available for browser selection geometry', () => {
    const dom = createDom();
    const document = dom.window.document;
    const pageEl = createPdfPagePlaceholder(document, 1, {
      width: 750,
      height: 1000,
      scale: 1.25,
    });

    expect(pageEl.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    expect(pageEl.style.width).toBe('750px');
  });

  it('applies viewport dimensions through the shared viewport-style helper', () => {
    const dom = createDom();
    const pageEl = dom.window.document.createElement('section');

    applyPageViewportStyles(pageEl, { width: 612.8, height: 792.4, scale: 1.25 });

    expect(pageEl.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    expect(pageEl.style.getPropertyValue('--scale-round-x')).toBe('1px');
    expect(pageEl.style.width).toBe('612px');
    expect(pageEl.style.height).toBe('792px');
  });

  it('shares an in-flight render promise for duplicate render requests of the same page', async () => {
    let releaseGetPage;
    let getPageCalls = 0;
    const dom = createDom();
    const document = dom.window.document;
    const pdf = {
      async getPage(pageNumber) {
        getPageCalls += 1;
        await new Promise((resolve) => {
          releaseGetPage = resolve;
        });
        return createFakePdf().getPage(pageNumber);
      },
    };
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 2,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });
    const pageEl = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    document.getElementById('pages').append(pageEl);

    const first = renderer.ensurePageRendered(pdf, pageEl, 1);
    const second = renderer.ensurePageRendered(pdf, pageEl, 1);
    await vi.waitFor(() => {
      expect(releaseGetPage).toEqual(expect.any(Function));
    });
    expect(getPageCalls).toBe(1);
    releaseGetPage();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(getPageCalls).toBe(1);
  });

  it('does not render a page whose in-flight request was evicted before getPage resolved', async () => {
    let releaseFirstPage;
    const firstPageReady = new Promise((resolve) => {
      releaseFirstPage = resolve;
    });
    const cleanupCalls = [];
    const dom = createDom();
    const document = dom.window.document;
    const pages = {
      1: createRenderPage(1, cleanupCalls),
      2: createRenderPage(2, cleanupCalls),
    };
    const pdf = {
      async getPage(pageNumber) {
        if (pageNumber === 1) await firstPageReady;
        return pages[pageNumber];
      },
    };
    const renderer = createVirtualPdfPageRenderer({
      documentRef: document,
      windowRef: dom.window,
      pdfjs: {
        TextLayer: class TestTextLayer {
          async render() {}
        },
      },
      maxRenderedPages: 1,
      maxOutputScale: 1,
      getPageScale: () => 1,
    });
    const first = createPdfPagePlaceholder(document, 1, { width: 600, height: 800 });
    const second = createPdfPagePlaceholder(document, 2, { width: 600, height: 800 });
    document.getElementById('pages').append(first, second);

    const firstRender = renderer.ensurePageRendered(pdf, first, 1);
    await renderer.ensurePageRendered(pdf, second, 2);

    expect(renderer.getRenderedPageNumbers()).toEqual([2]);
    expect(first.childElementCount).toBe(0);
    expect(second.querySelector('canvas')).toBeTruthy();

    releaseFirstPage();
    await firstRender;

    expect(renderer.getRenderedPageNumbers()).toEqual([2]);
    expect(first.childElementCount).toBe(0);
    expect(cleanupCalls).toEqual([1]);
  });
});

function createRenderPage(pageNumber, cleanupCalls = []) {
  return {
    pageNumber,
    cleanup: vi.fn(() => cleanupCalls.push(pageNumber)),
    render: vi.fn(() => ({
      cancel: vi.fn(),
      promise: Promise.resolve(),
    })),
    async getTextContent() {
      return {
        items: [
          {
            str: `Page ${pageNumber}`,
            transform: [1, 0, 0, 1, 72, 720],
            height: 12,
            width: 48,
          },
        ],
      };
    },
    getViewport({ scale }) {
      return {
        width: 600 * scale,
        height: 800 * scale,
      };
    },
  };
}
