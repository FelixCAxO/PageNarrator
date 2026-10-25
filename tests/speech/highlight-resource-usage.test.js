import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([0.5, 1, 3].flatMap((rate) => [false, true].map((pdfMode) => [rate, pdfMode])))
('avoids unchanged word paints at %sx, PDF=%s', (playbackRate, pdfMode) => {
  vi.useFakeTimers();
  const dom = new JSDOM('<section data-pagenarrator-id="section"><span>One two</span></section>', { pretendToBeVisual: true, url: 'https://example.test/' });
  const rect = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  dom.window.scrollBy = () => {};
  dom.window.document.querySelector('section').getBoundingClientRect = () => rect;
  const readRects = vi.fn(() => [rect]);
  dom.window.Range.prototype.getClientRects = readRects;
  const highlights = new Map();
  const paints = vi.spyOn(highlights, 'set');
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', class { constructor(...ranges) { this.ranges = ranges; } });
  let currentTime = 0;
  let frame;
  const highlighter = createPageHighlighter(dom.window.document, { pdfMode, mediaClock: { currentTime: () => currentTime } });
  try {
    highlighter.highlightChunkByAnchor('section');
    highlighter.highlightWordPlan([{ index: 0, start: 0, end: 1 }, { index: 1, start: 1, end: 2 }], {
      leadSeconds: 0, playbackRate,
      requestFrame: (callback) => { frame = callback; return 1; }, cancelFrame() {},
    });
    const firstHighlight = highlights.get('pagenarrator-word-0');
    paints.mockClear();
    readRects.mockClear();
    for (let index = 1; index <= 120; index += 1) {
      currentTime = index / 150 / playbackRate;
      frame();
    }
    console.info(JSON.stringify({ playbackRate, pdfMode, frames: 120, duplicatePaints: paints.mock.calls.length, repeatedGeometryReads: readRects.mock.calls.length }));
    expect(highlights.get('pagenarrator-word-0')).toBe(firstHighlight);
    expect(paints).not.toHaveBeenCalled();
    expect(readRects).not.toHaveBeenCalled();
    currentTime = 1.1 / playbackRate;
    frame();
    expect(highlights.get('pagenarrator-word-0').ranges[0].toString()).toBe('two');
    const readsBeforeScroll = readRects.mock.calls.length;
    if (pdfMode) {
      dom.window.dispatchEvent(new dom.window.Event('scroll'));
      expect(readRects.mock.calls.length).toBeGreaterThan(readsBeforeScroll);
    }
  } finally { highlighter.dispose(); dom.window.close(); }
});
