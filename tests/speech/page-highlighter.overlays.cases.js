import { createDom, makeVisible, makeTextRangeGeometry, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('repositions the existing active overlay instead of removing it between chunks', () => {
    const dom = createDom(`
      <body>
        <p id="first">First chunk text.</p>
        <p id="second">Second chunk text.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('#first'), {
      top: 100,
      left: 50,
      right: 250,
      bottom: 130,
      width: 200,
      height: 30,
    });
    makeVisible(document.querySelector('#second'), {
      top: 180,
      left: 70,
      right: 330,
      bottom: 210,
      width: 260,
      height: 30,
    });

    const removed = [];
    const originalRemove = dom.window.HTMLElement.prototype.remove;
    dom.window.HTMLElement.prototype.remove = function remove() {
      if (this.hasAttribute?.('data-pagenarrator-region')) removed.push(this.getAttribute('data-pagenarrator-region'));
      return originalRemove.call(this);
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('First chunk text.')).toEqual({ ok: true });
    const overlay = document.querySelector('[data-pagenarrator-region="active"]');

    expect(highlighter.highlightChunk('Second chunk text.')).toEqual({ ok: true });

    expect(document.querySelector('[data-pagenarrator-region="active"]')).toBe(overlay);
    expect(removed).toEqual([]);
    expect(overlay.style.left).toBe('66px');
    expect(overlay.style.top).toBe('176px');
  });

  it('pins active overlays to scroll and resize geometry changes', () => {
    const dom = createDom(`
      <body>
        <p data-pagenarrator-id="story">Pinned text changes position.</p>
      </body>
    `);
    const { document } = dom.window;
    let top = 100;
    makeVisible(document.querySelector('p'), {
      top,
      left: 50,
      right: 250,
      bottom: top + 30,
      width: 200,
      height: 30,
    });
    document.querySelector('p').getBoundingClientRect = () => ({
      top,
      left: 50,
      right: 250,
      bottom: top + 30,
      width: 200,
      height: 30,
    });

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('story', null)).toEqual({ ok: true });
    const overlay = document.querySelector('[data-pagenarrator-region="active"]');
    expect(overlay.style.top).toBe('96px');

    top = 160;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));

    expect(overlay.style.top).toBe('156px');
  });

  it('disposes pinned overlay listeners and ResizeObserver state', () => {
    const dom = createDom(`
      <body>
        <p data-pagenarrator-id="story">Pinned text changes position.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'), {
      top: 100,
      left: 50,
      right: 250,
      bottom: 130,
      width: 200,
      height: 30,
    });

    const listeners = new Map();
    const addEventListener = dom.window.addEventListener.bind(dom.window);
    const removeEventListener = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = (type, listener, options) => {
      listeners.set(type, listener);
      addEventListener(type, listener, options);
    };
    dom.window.removeEventListener = (type, listener, options) => {
      if (listeners.get(type) === listener) listeners.delete(type);
      removeEventListener(type, listener, options);
    };
    const disconnect = vi.fn();
    dom.window.ResizeObserver = class TestResizeObserver {
      observe = vi.fn();
      disconnect = disconnect;
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('story', null)).toEqual({ ok: true });
    expect(listeners.has('scroll')).toBe(true);
    expect(listeners.has('resize')).toBe(true);
    expect(document.querySelector('[data-pagenarrator-region="active"]')).toBeTruthy();

    highlighter.dispose();

    expect(listeners.has('scroll')).toBe(false);
    expect(listeners.has('resize')).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-pagenarrator-region="active"]')).toBeNull();
  });

  it('draws a dim queued chunk overlay without replacing the active chunk', () => {
    const dom = createDom(`
      <body>
        <p data-pagenarrator-id="active">Active chunk text.</p>
        <p data-pagenarrator-id="queued">Queued chunk text.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('[data-pagenarrator-id="active"]'), {
      top: 100,
      left: 50,
      right: 250,
      bottom: 130,
      width: 200,
      height: 30,
    });
    makeVisible(document.querySelector('[data-pagenarrator-id="queued"]'), {
      top: 180,
      left: 70,
      right: 330,
      bottom: 210,
      width: 260,
      height: 30,
    });

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('active', null)).toEqual({ ok: true });
    expect(highlighter.highlightQueuedChunkByAnchor('queued', null)).toEqual({ ok: true });

    expect(document.querySelector('[data-pagenarrator-region="active"]').style.top).toBe('96px');
    expect(document.querySelector('[data-pagenarrator-region="next"]').style.top).toBe('176px');
    expect(document.querySelector('[data-pagenarrator-id="active"]').classList.contains('pagenarrator-current-block')).toBe(true);
  });

  it('does not draw queued region overlays when disabled for PDF mode', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="active">Active PDF chunk text.</section>
        <section data-pagenarrator-id="queued">Queued PDF chunk text.</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('[data-pagenarrator-id="active"]'));
    makeVisible(document.querySelector('[data-pagenarrator-id="queued"]'));

    const highlighter = createPageHighlighter(document, {
      pdfMode: true,
      showQueuedRegion: false,
    });

    expect(highlighter.highlightChunkByAnchor('active', null)).toEqual({ ok: true });
    expect(highlighter.highlightQueuedChunkByAnchor('queued', null)).toEqual({ ok: true });

    expect(document.querySelector('[data-pagenarrator-region="active"]')).not.toBeNull();
    expect(document.querySelector('[data-pagenarrator-region="next"]')).toBeNull();
  });

  it('prefers CSS-only chunk highlighting for PDF text ranges', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="pdf-page-1">Small PDF text should use the CSS range.</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 300,
      bottom: 132,
      width: 220,
      height: 12,
    });
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document, {
      pdfMode: true,
      preferCssOnlyRegion: true,
    });

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null, {
      chunkText: 'Small PDF text should use the CSS range.',
    })).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')).toEqual({
      name: 'pagenarrator-chunk',
      text: 'Small PDF text should use the CSS range.',
    });
    expect(document.querySelector('[data-pagenarrator-region="active"]')).toBeNull();
  });

  it('reports an exact anchored range as grounded', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="pdf-page-1">Opening words before the exact grounded passage and closing words.</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 300,
      bottom: 132,
      width: 220,
      height: 12,
    });
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document, {
      pdfMode: true,
      preferCssOnlyRegion: true,
    });

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null, {
      chunkText: 'the exact grounded passage',
      reportGrounding: true,
    })).toEqual({ ok: true, grounded: true, fallback: false });
    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')).toEqual({
      name: 'pagenarrator-chunk',
      text: 'the exact grounded passage',
    });
  });

  it('reports an anchored element fallback as ungrounded when the chunk text is missing', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="pdf-page-1">The anchored page contains different words.</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 300,
      bottom: 132,
      width: 220,
      height: 12,
    });
    const highlighter = createPageHighlighter(document, { pdfMode: true });

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null, {
      chunkText: 'This requested chunk does not exist.',
      reportGrounding: true,
    })).toEqual({ ok: true, grounded: false, fallback: true });
  });

  it('reports a successful global text recovery for a missing anchor as fallback', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="other-page">The requested passage exists elsewhere.</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 300,
      bottom: 132,
      width: 220,
      height: 12,
    });
    const highlighter = createPageHighlighter(document, { pdfMode: true });

    expect(highlighter.highlightChunkByAnchor('missing-page', 'The requested passage exists elsewhere.', {
      reportGrounding: true,
    })).toEqual({ ok: true, grounded: false, fallback: true });
  });

  it('uses smaller overlay padding for tiny PDF rects', () => {
    const dom = createDom(`
      <body>
        <main>
          <span>Tiny PDF text now.</span>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('main'));
    makeVisible(document.querySelector('span'));
    makeTextRangeGeometry(dom.window, {
      top: 140,
      left: 90,
      right: 190,
      bottom: 147,
      width: 100,
      height: 7,
    });

    const highlighter = createPageHighlighter(document, { pdfMode: true });

    expect(highlighter.highlightChunk('Tiny PDF text now.')).toEqual({ ok: true });

    const overlay = document.querySelector('[data-pagenarrator-region="active"]');
    expect(overlay.style.left).toBe('88px');
    expect(overlay.style.top).toBe('138px');
    expect(overlay.style.width).toBe('104px');
    expect(overlay.style.height).toBe('11px');
  });

  it('filters unusable tiny PDF rects before drawing overlay fragments', () => {
    const dom = createDom(`
      <body>
        <main>
          <span>Tiny PDF text spans one usable fragment.</span>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('main'));
    makeVisible(document.querySelector('span'));
    makeTextRangeGeometry(dom.window, [
      {
        top: 100,
        left: 80,
        right: 81,
        bottom: 101,
        width: 1,
        height: 1,
      },
      {
        top: 140,
        left: 90,
        right: 210,
        bottom: 147,
        width: 120,
        height: 7,
      },
    ]);

    const highlighter = createPageHighlighter(document, { pdfMode: true });

    expect(highlighter.highlightChunk('Tiny PDF text spans one usable fragment.')).toEqual({ ok: true });

    const overlays = [...document.querySelectorAll('[data-pagenarrator-region="active"]')];
    expect(overlays).toHaveLength(1);
    expect(overlays[0].style.left).toBe('88px');
  });

  it('renders synthetic prefix words as a dim active-block trail mark', () => {
    const dom = createDom(`
      <body>
        <h2 data-pagenarrator-id="heading">Why structure matters</h2>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('h2'));

    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(range) {
        this.range = range;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({ name, text: highlight.range.toString() });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('heading', null)).toEqual({ ok: true });
    expect(highlighter.highlightSyntheticSpeech()).toEqual({ ok: true });

    expect(highlighted.at(-1)).toEqual({
      name: 'pagenarrator-word-3',
      text: 'Why structure matters',
    });
  });

  it('keeps the previous visible region for synthetic narration chunks without DOM text', () => {
    const dom = createDom(`
      <body>
        <p>Install the extension</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 260,
      bottom: 150,
      width: 180,
      height: 30,
    });

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Install the extension')).toEqual({ ok: true });
    const overlay = document.querySelector('[data-pagenarrator-region="active"]');
    expect(highlighter.highlightChunk(null)).toEqual({ ok: true, retained: true });
    expect(document.querySelector('[data-pagenarrator-region="active"]')).toBe(overlay);
    expect(overlay.style.display).toBe('block');
  });
});
