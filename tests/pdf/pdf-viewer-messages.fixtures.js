import { JSDOM } from 'jsdom';
import { expect, vi } from "vitest";

export const trustedSender = { id: 'test', url: 'chrome-extension://test/src/reader-engine.html', origin: 'chrome-extension://test', frameId: 0 };

let activeViewerFixture = null;

// Retain the owner until import and initial render settle; a timeout cannot replace its globals.
export async function loadViewer(importViewer = () => import('../../src/pdf-viewer.js')) {
  const fixture = activeViewerFixture;
  if (!fixture || fixture.closing || fixture.loading) throw new Error('Viewer fixture is unavailable or already loading.');
  fixture.loading = (async () => {
    await importViewer();
    const listener = fixture.listeners?.[0];
    if (!listener) throw new Error('Viewer fixture did not register its message handler.');
    const ready = await sendViewerMessage(listener, { type: 'getPdfStreamMetadata' });
    if (!ready?.ok) throw new Error(ready?.error || 'Viewer fixture initialization failed.');
  })();
  await fixture.loading;
  if (fixture.closing) throw new Error('Viewer fixture was closed while loading.');
}

export async function cleanupViewerDom() {
  const fixture = activeViewerFixture;
  if (!fixture) return;
  if (fixture.cleanup) return fixture.cleanup;
  fixture.closing = true;
  fixture.cleanup = (async () => {
    let failure;
    try { await fixture.loading; } catch (error) { failure = error; }
    try { fixture.dom.window.dispatchEvent(new fixture.dom.window.Event('pagehide')); } catch (error) { failure ||= error; }
    try { fixture.dom.window.close(); } catch (error) { failure ||= error; }
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
    if (activeViewerFixture === fixture) activeViewerFixture = null;
    if (failure) throw failure;
  })();
  return fixture.cleanup;
}

export async function installViewerDom() {
  await cleanupViewerDom();
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

  activeViewerFixture = { dom, loading: null, listeners: null, closing: false, cleanup: null };
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

export function installChromeRuntime() {
  if (!activeViewerFixture || activeViewerFixture.closing) throw new Error('Install a viewer DOM before the runtime.');
  const listeners = [];
  activeViewerFixture.listeners = listeners;
  const sendMessage = vi.fn(() => Promise.resolve());
  globalThis.chrome = {
    runtime: {
      id: 'test',
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage,
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };
  return { listeners, sendMessage };
}

export function createFakePdfDocument(pages = ['', '', '']) {
  return {
    numPages: pages.length,
    async getPage(pageNumber) {
      const text = pages[pageNumber - 1] || '';
      return {
        cleanup: vi.fn(),
        getViewport({ scale }) {
          return {
            width: 600 * scale,
            height: 800 * scale,
            scale,
          };
        },
        async getTextContent() {
          return {
            items: textToItems(text),
          };
        },
      };
    },
    async getOutline() {
      return [];
    },
  };
}

export function textToItems(text) {
  let x = 72;
  return String(text || '').split(/\s+/).filter(Boolean).map((word) => {
    const width = word.length * 7;
    const item = {
      str: word,
      transform: [12, 0, 0, 12, x, 720],
      height: 12,
      width,
    };
    x += width + 4;
    return item;
  });
}

export function appendTextLayer(document, pageNumber, text) {
  const pageEl = document.querySelector(`[data-page-number="${pageNumber}"]`);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.setAttribute('data-pagenarrator-pdf-text', text);
  const span = document.createElement('span');
  span.setAttribute('data-pagenarrator-pdf-order', '0');
  span.textContent = text;
  layer.append(span);
  pageEl.append(layer);
  return span.firstChild;
}

export function createVisibleEntry(target, {
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

export function selectRange(dom, startNode, startOffset, endNode, endOffset) {
  const range = dom.window.document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

export async function sendViewerMessage(listener, message) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const handledAsync = listener(message, trustedSender, resolveResponse);
  expect(handledAsync).toBe(true);
  return responsePromise;
}
