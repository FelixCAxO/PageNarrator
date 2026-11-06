import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupViewerDom,
  createFakePdfDocument,
  installChromeRuntime,
  installViewerDom,
  sendViewerMessage,
} from './pdf-viewer-messages.fixtures.js';

// Model a slow page without depending on the test machine's CPU or GPU speed.
const PAGE_MS = 5000;
let dom;
let started;
let painted;
let cancelled;
let failures;

async function openViewer({ hash = '' } = {}) {
  vi.resetModules();
  dom = await installViewerDom();
  dom.window.location.hash = hash;
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ isContextLost: () => false });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { listeners } = installChromeRuntime();
  started = []; painted = []; cancelled = []; failures = new Set();
  const pdf = createFakePdfDocument(Array.from({ length: 20 }, (_, i) => `Page ${i + 1} readable text.`));
  const getPage = pdf.getPage;
  pdf.getPage = async number => {
    const page = await getPage(number);
    page.pageNumber = number;
    page.render = () => {
      started.push(number);
      let timer, rejectRender;
      const promise = new Promise((resolve, reject) => {
        rejectRender = reject;
        timer = setTimeout(() => {
          if (failures.has(number)) {
            reject(Object.assign(new Error('Unreadable page'), { code: 'pdf_corrupt' }));
          } else {
            painted.push({ number, time: Date.now() });
            resolve();
          }
        }, PAGE_MS);
      });
      return { promise, cancel() {
        clearTimeout(timer);
        cancelled.push(number);
        rejectRender(Object.assign(new Error('Cancelled'), { name: 'RenderingCancelledException' }));
      } };
    };
    return page;
  };
  vi.doMock('../../src/pdf/pdf-engine.js', () => ({
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({ promise: Promise.resolve(pdf) }),
    TextLayer: class {
      constructor({ container, textContentSource }) {
        this.container = container;
        this.text = textContentSource.items.map(item => item.str).join(' ');
      }
      async render() { this.container.textContent = this.text; }
    },
  }));
  vi.useFakeTimers();
  await import('../../src/pdf-viewer.js');
  return listeners[0];
}

function jump(number) {
  const input = dom.window.document.getElementById('pdf-page-input');
  input.value = String(number);
  input.dispatchEvent(new dom.window.Event('change'));
}

function pageText(number) {
  return dom.window.document.querySelector(`[data-page-number="${number}"] .textLayer`)?.textContent;
}

afterEach(async () => {
  await cleanupViewerDom();
  vi.doUnmock('../../src/lib/page-highlighter.js');
  vi.useRealTimers();
});

describe('PDF navigation under slow page rendering', () => {
  it('shows a cold requested page within one page render instead of waiting for neighbors', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    const start = Date.now();
    jump(6);
    await vi.advanceTimersByTimeAsync(25000);
    const latency = painted.find(page => page.number === 6).time - start;
    console.log(JSON.stringify({ scenario: 'cold-jump', pageMs: PAGE_MS, latencyMs: latency }));
    expect(pageText(6)).toContain('Page 6');
    expect(latency).toBeLessThanOrEqual(PAGE_MS);
  });

  it('shows the latest jump without draining obsolete render windows', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    started.length = 0;
    jump(6);
    await vi.advanceTimersByTimeAsync(1000);
    const start = Date.now();
    jump(10);
    await vi.advanceTimersByTimeAsync(45000);
    const latency = painted.find(page => page.number === 10).time - start;
    console.log(JSON.stringify({ scenario: 'superseded-jump', pageMs: PAGE_MS, latencyMs: latency, started }));
    expect(pageText(10)).toContain('Page 10');
    expect(latency).toBeLessThanOrEqual(PAGE_MS);
    expect(started).not.toContain(5);
    expect(started).not.toContain(7);
  });

  it('makes a deep-link page and stream metadata ready before speculative neighbors finish', async () => {
    const listener = await openViewer({ hash: '#page=10' });
    let metadata;
    const ready = sendViewerMessage(listener, { type: 'getPdfStreamMetadata' }).then(value => { metadata = value; });
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(10)).toContain('Page 10');
    expect(metadata?.ok).toBe(true);
    await ready;
  });

  it('reuses a prefetched next page without a second paint', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    expect(pageText(2)).toContain('Page 2');
    jump(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(pageText(2)).toContain('Page 2');
    expect(started.filter(number => number === 2)).toHaveLength(1);
  });

  it('preserves an in-flight page shared by consecutive render windows', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    jump(6);
    await vi.advanceTimersByTimeAsync(1000);
    jump(7);
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(6)).toContain('Page 6');
    expect(pageText(7)).toContain('Page 7');
    expect(started.filter(number => number === 6)).toHaveLength(1);
    expect(cancelled).not.toContain(6);
    await vi.advanceTimersByTimeAsync(25000);
    const rendered = [...dom.window.document.querySelectorAll('.pdf-page:has(canvas)')]
      .map(element => Number(element.dataset.pageNumber));
    expect(rendered).toEqual([5, 6, 7, 8, 9]);
  });

  it('continues prefetch after a corrupt neighbor and allows navigation past it', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    failures.add(7);
    jump(6);
    await vi.advanceTimersByTimeAsync(25000);
    expect(pageText(6)).toContain('Page 6');
    expect(pageText(5)).toContain('Page 5');
    expect(pageText(8)).toContain('Page 8');
    jump(10);
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(10)).toContain('Page 10');
  });

  it('cancels active work and starts no more prefetch after the viewer closes', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    jump(10);
    await vi.advanceTimersByTimeAsync(1000);
    const startsBeforeClose = [...started];
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await vi.advanceTimersByTimeAsync(25000);
    expect(started).toEqual(startsBeforeClose);
    expect(cancelled).toContain(10);
    expect(dom.window.document.querySelectorAll('.pdf-page')).toHaveLength(0);
  });

  it('replaces an active paint at the new zoom and keeps the requested page anchored', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    jump(10);
    await vi.advanceTimersByTimeAsync(1000);
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(10)).toContain('Page 10');
    expect(cancelled).toContain(10);
    const page = dom.window.document.querySelector('[data-page-number="10"]');
    expect(page.querySelector('canvas').style.width).toBe(page.style.width);
    expect(dom.window.document.getElementById('pdf-page-input').value).toBe('10');
    expect(dom.window.location.hash).toBe('#page=10');
  });

  it('does not restore an obsolete zoom anchor after a newer page jump', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    await vi.advanceTimersByTimeAsync(1000);
    jump(10);
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(10)).toContain('Page 10');
    expect(dom.window.document.getElementById('pdf-page-input').value).toBe('10');
    expect(dom.window.location.hash).toBe('#page=10');
  });

  it('coalesces queued zoom refreshes around the latest requested page', async () => {
    await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    await vi.advanceTimersByTimeAsync(1000);
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    jump(10);
    await vi.advanceTimersByTimeAsync(PAGE_MS);
    expect(pageText(10)).toContain('Page 10');
    expect(dom.window.document.getElementById('pdf-page-input').value).toBe('10');
    await vi.advanceTimersByTimeAsync(25000);
    expect(pageText(10)).toContain('Page 10');
    expect(started.filter(number => number === 1)).toHaveLength(2);
  });

  it('restores narration on a protected page after its background zoom repaint', async () => {
    let highlightCount = 0;
    // Observe highlight ownership on the actual replaceable text-layer node.
    // Geometry is a browser boundary; the real viewer and renderer stay in use.
    vi.doMock('../../src/lib/page-highlighter.js', () => ({
      createPageHighlighter: () => ({
        cancelPendingScroll() {}, dispose() {}, clearHighlights() {},
        highlightChunkByAnchor(anchorId) {
          const layer = dom.window.document.querySelector(`[data-pagenarrator-id="${anchorId}"] .textLayer`);
          if (!layer?.textContent) return { ok: false };
          highlightCount += 1;
          layer.dataset.activeNarration = 'true';
          return { ok: true };
        },
      }),
    }));
    const listener = await openViewer();
    await vi.advanceTimersByTimeAsync(25000);
    const response = sendViewerMessage(listener, {
      type: 'highlightChunk', anchorId: 'pdf-page-1', text: 'Page 1', chunkText: 'Page 1',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await response).toEqual({ ok: true });
    jump(10);
    await vi.advanceTimersByTimeAsync(25000);
    // Browsing away must not replay a highlight on a layer that never changed:
    // the highlighter can scroll that passage back into view.
    expect(highlightCount).toBe(1);
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    await vi.advanceTimersByTimeAsync(35000);
    const layer = dom.window.document.querySelector('[data-page-number="1"] .textLayer');
    expect(layer.textContent).toContain('Page 1');
    expect(layer.dataset.activeNarration).toBe('true');

    // A newer window can share the protected page's unfinished repaint.
    dom.window.document.getElementById('pdf-zoom-in-btn').click();
    await vi.advanceTimersByTimeAsync(26000);
    jump(11);
    await vi.advanceTimersByTimeAsync(35000);
    const sharedLayer = dom.window.document.querySelector('[data-page-number="1"] .textLayer');
    expect(sharedLayer.textContent).toContain('Page 1');
    expect(sharedLayer.dataset.activeNarration).toBe('true');
  });
});
