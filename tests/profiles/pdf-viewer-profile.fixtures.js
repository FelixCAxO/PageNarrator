import { JSDOM } from 'jsdom';
import { vi } from "vitest";

export const extensionOrigin = 'chrome-extension://test';

export const trustedEngineSender = { id: 'test', url: `${extensionOrigin}/src/reader-engine.html?engine=1`, origin: extensionOrigin, frameId: 0 };

export const trustedWorkerSender = { id: 'test', url: `${extensionOrigin}/service-worker-loader.js`, origin: extensionOrigin };

export function installViewerDom({
  url = 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Flarge.pdf',
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

  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
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
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  Object.defineProperty(dom.window, 'localStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(dom.window, 'sessionStorage', {
    value: storage,
    configurable: true,
  });
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;

  return dom;
}

export function installChromeRuntime() {
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };
  return listeners;
}

export async function sendViewerMessage(listener, message) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  listener(message, trustedWorkerSender, resolveResponse);
  return responsePromise;
}

export function createFakePdfDocument(pageCount = 120) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber) => {
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
        getViewport({ scale }) {
          return {
            width: 600 * scale,
            height: 800 * scale,
            scale,
          };
        },
      };
    }),
  };
}

export function createTrackingRenderer() {
  const renderedPages = new Set();
  return {
    renderedPages,
    ensurePageRendered: vi.fn((_pdf, _pageEl, pageNumber) => {
      renderedPages.add(pageNumber);
      return Promise.resolve();
    }),
    unloadPageSoon: vi.fn(),
    unloadPage: vi.fn((pageNumber) => {
      renderedPages.delete(pageNumber);
    }),
    getRenderedPageNumbers: vi.fn(() => [...renderedPages]),
    setProtectedPageNumbers: vi.fn(),
    destroy: vi.fn(),
  };
}

export function getRenderedPageNumbers(renderer) {
  return [...renderer.renderedPages].sort((a, b) => a - b);
}

export function createVisibleEntry(target, {
  top = 64,
  bottom = 720,
  left = 0,
  right = 600,
} = {}) {
  return {
    target,
    isIntersecting: true,
    boundingClientRect: {
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
    },
    intersectionRect: {
      top: Math.max(0, top),
      bottom: Math.min(768, bottom),
      left: Math.max(0, left),
      right: Math.min(1024, right),
      width: right - left,
      height: Math.min(768, bottom) - Math.max(0, top),
    },
  };
}
