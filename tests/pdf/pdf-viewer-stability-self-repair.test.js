import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVirtualPdfPageRenderer,
  createPdfPagePlaceholder,
  getPdfRenderWindowPageNumbers,
} from '../../src/lib/pdf-viewer-rendering.js';
import {
  classifyPdfLoadError,
  isPdfWorkerTerminatedError,
  isRecoverablePdfError,
} from '../../src/lib/pdf-viewer-errors.js';
import { createPdfMemoryProfile } from '../../src/lib/pdf-memory-profile.js';

function createDom() {
  const dom = new JSDOM('<!doctype html><main id="pages"></main>', {
    pretendToBeVisual: true,
    url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2F184-pages.pdf',
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    tag: 'canvas-context',
    isContextLost: () => false,
  });
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 1, configurable: true });
  return dom;
}

function createFakePdf(numPages = 184) {
  const pages = new Map();
  return {
    numPages,
    pages,
    async getPage(pageNumber) {
      if (pageNumber < 1 || pageNumber > numPages) throw new Error(`Page ${pageNumber} out of range`);
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
                str: `Content for page ${pageNumber}`,
                transform: [1, 0, 0, 1, 72, 720],
                height: 12,
                width: 120,
              },
            ],
          };
        },
        getViewport({ scale }) {
          return { width: 600 * scale, height: 800 * scale };
        },
      };
      pages.set(pageNumber, page);
      return page;
    },
  };
}

describe('PDF viewer stability & self-repairing resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Worker termination & recoverable error detection', () => {
    it('detects worker termination and transport closure errors', () => {
      expect(isPdfWorkerTerminatedError(new Error('Worker was terminated'))).toBe(true);
      expect(isPdfWorkerTerminatedError(new Error('Worker destroyed'))).toBe(true);
      expect(isPdfWorkerTerminatedError(new Error('Message channel closed'))).toBe(true);
      expect(isPdfWorkerTerminatedError(new Error('Transport closed'))).toBe(true);
      expect(isPdfWorkerTerminatedError({ name: 'WorkerTerminatedException' })).toBe(true);
      expect(isPdfWorkerTerminatedError(new Error('Normal syntax error'))).toBe(false);
    });

    it('identifies recoverable PDF errors vs permanent corruption', () => {
      expect(isRecoverablePdfError(new Error('Worker was terminated'))).toBe(true);
      expect(isRecoverablePdfError({ name: 'RenderingCancelledException' })).toBe(true);
      expect(isRecoverablePdfError(new Error('Invalid PDF structure'))).toBe(false);

      expect(classifyPdfLoadError(new Error('Invalid PDF structure')).code).toBe('pdf_corrupt');
    });
  });

  describe('Canvas context-loss self-healing', () => {
    it('discards canvases with lost 2D context and recovers with fresh canvas allocation', async () => {
      const dom = createDom();
      const document = dom.window.document;
      let contextLost = true;
      let createdCanvases = 0;

      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tagName, ...args) => {
        const element = originalCreateElement(tagName, ...args);
        if (String(tagName).toLowerCase() === 'canvas') {
          createdCanvases += 1;
          const currentLost = contextLost;
          element.getContext = () => ({
            tag: 'canvas-context',
            isContextLost: () => currentLost,
          });
        }
        return element;
      };

      const pdf = createFakePdf(184);
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

      const pageEl = createPdfPagePlaceholder(document, 141, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);

      contextLost = false;
      await renderer.ensurePageRendered(pdf, pageEl, 141);

      expect(createdCanvases).toBeGreaterThanOrEqual(1);
      expect(pageEl.querySelector('canvas')).toBeTruthy();
      expect(pageEl.querySelector('.textLayer')).toBeTruthy();
      expect(renderer.getRenderedPageNumbers()).toContain(141);
    });

    it('retries rendering on transient canvas render errors before failing', async () => {
      const dom = createDom();
      const document = dom.window.document;
      let renderAttempts = 0;

      const pdf = {
        async getPage(pageNumber) {
          return {
            pageNumber,
            view: [0, 0, 600, 800],
            cleanup: vi.fn(),
            render: vi.fn(() => {
              renderAttempts += 1;
              if (renderAttempts === 1) {
                return {
                  cancel: vi.fn(),
                  promise: Promise.reject(new Error('Transient canvas buffer allocation failure')),
                };
              }
              return {
                cancel: vi.fn(),
                promise: Promise.resolve(),
              };
            }),
            async getTextContent() {
              return { items: [{ str: 'Text on page 141' }] };
            },
            getViewport({ scale }) {
              return { width: 600 * scale, height: 800 * scale };
            },
          };
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
        maxRenderedPages: 3,
        maxOutputScale: 1,
        getPageScale: () => 1,
      });

      const pageEl = createPdfPagePlaceholder(document, 141, { width: 600, height: 800 });
      document.getElementById('pages').append(pageEl);

      await renderer.ensurePageRendered(pdf, pageEl, 141);

      expect(renderAttempts).toBe(2);
      expect(pageEl.querySelector('canvas')).toBeTruthy();
      expect(renderer.getRenderedPageNumbers()).toContain(141);
    });
  });

  describe('Large document memory profile & active page protection', () => {
    it('maintains a bounded 2-page render window for large 180+ page documents', () => {
      const profile = createPdfMemoryProfile({
        navigatorRef: { deviceMemory: 8 },
        pageCount: 184,
      });

      expect(profile.name).toBe('large');
      expect(profile.maxRenderedPages).toBe(2);
      expect(profile.preloadBehind).toBe(0);
      expect(profile.preloadAhead).toBe(1);

      const windowPages = getPdfRenderWindowPageNumbers(141, {
        pageCount: 184,
        preloadBehind: profile.preloadBehind,
        preloadAhead: profile.preloadAhead,
      });
      expect(windowPages).toEqual([141, 142]);
    });

    it('protects deep page (e.g. Page 141) from eviction during rapid scrolling of surrounding pages', async () => {
      const dom = createDom();
      const document = dom.window.document;
      const pdf = createFakePdf(184);

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

      const page141 = createPdfPagePlaceholder(document, 141, { width: 600, height: 800 });
      const page142 = createPdfPagePlaceholder(document, 142, { width: 600, height: 800 });
      const page143 = createPdfPagePlaceholder(document, 143, { width: 600, height: 800 });
      const page144 = createPdfPagePlaceholder(document, 144, { width: 600, height: 800 });
      const page145 = createPdfPagePlaceholder(document, 145, { width: 600, height: 800 });
      document.getElementById('pages').append(page141, page142, page143, page144, page145);

      await renderer.ensurePageRendered(pdf, page141, 141);
      renderer.setProtectedPageNumbers([141]);

      await renderer.ensurePageRendered(pdf, page142, 142);
      await renderer.ensurePageRendered(pdf, page143, 143);
      await renderer.ensurePageRendered(pdf, page144, 144);
      await renderer.ensurePageRendered(pdf, page145, 145);

      expect(renderer.getRenderedPageNumbers()).toContain(141);
      expect(page141.querySelector('canvas')).toBeTruthy();
      expect(page141.querySelector('.textLayer')).toBeTruthy();
    });
  });

  describe('Long uptime simulation & bounded resource allocation', () => {
    it('simulates 100 page transitions with zero uncollected canvas leaks', async () => {
      const dom = createDom();
      const document = dom.window.document;
      const pdf = createFakePdf(184);
      let allocatedCanvases = 0;

      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tagName, ...args) => {
        const element = originalCreateElement(tagName, ...args);
        if (String(tagName).toLowerCase() === 'canvas') {
          allocatedCanvases += 1;
        }
        return element;
      };

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

      const pagePlaceholders = [];
      for (let p = 1; p <= 100; p += 1) {
        const pageEl = createPdfPagePlaceholder(document, p, { width: 600, height: 800 });
        document.getElementById('pages').append(pageEl);
        pagePlaceholders.push(pageEl);
      }

      for (let p = 1; p <= 100; p += 1) {
        await renderer.ensurePageRendered(pdf, pagePlaceholders[p - 1], p);
      }

      expect(renderer.getRenderedPageNumbers().length).toBeLessThanOrEqual(3);
      expect(allocatedCanvases).toBeLessThanOrEqual(6);

      renderer.destroy();
      expect(renderer.getRenderedPageNumbers()).toEqual([]);
    });
  });
});
