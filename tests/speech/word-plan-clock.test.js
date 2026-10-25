import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  vi.useFakeTimers();
  const dom = new JSDOM('<section data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="One two three"><span data-pagenarrator-pdf-order="0">One two three</span></section>', { pretendToBeVisual: true });
  dom.window.scrollBy = () => {};
  dom.window.document.querySelector('section').getBoundingClientRect = () => ({ width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50 });
  const highlights = new Map();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', class { constructor(...ranges) { this.ranges = ranges; } });
  const highlighter = createPageHighlighter(dom.window.document, { pdfMode: true });
  highlighter.highlightChunkByAnchor('pdf-page-1');
  const word = () => highlights.get('pagenarrator-word-0')?.ranges.map((range) => range.toString()).join('') || '';
  return { highlighter, word, dom };
}

it.each([0.5, 1, 3])('does not resurrect an expired word during an acoustic pause at %sx', (playbackRate) => {
  const { highlighter, word } = setup();
  let frame;
  highlighter.highlightWordPlan([{ index: 0, start: 0, end: 0.2 }, { index: 1, start: 2, end: 2.4 }], {
    leadSeconds: 0, playbackRate, requestFrame: (callback) => { frame = callback; return 1; }, cancelFrame: () => {},
  });
  expect(word()).toBe('One');
  vi.advanceTimersByTime(0.2 / playbackRate * 1000 + 200);
  expect(word()).toBe('');
  frame();
  expect(word()).toBe('');
  highlighter.dispose();
});

it.each([0.5, 1, 3])('expires a word when an audio resync interrupts its fade at %sx', (playbackRate) => {
  const { highlighter, word } = setup();
  highlighter.highlightWordPlan([{ index: 0, start: 0, end: 0.2 }, { index: 1, start: 2, end: 2.4 }], {
    leadSeconds: 0, playbackRate,
  });
  vi.advanceTimersByTime(0.2 / playbackRate * 1000 + 10);
  highlighter.resyncWordPlan({ currentTime: 0.2 + 0.01 * playbackRate });
  vi.advanceTimersByTime(200);
  expect(word()).toBe('');
  highlighter.dispose();
});

it('freezes the current clock when pausing without an explicit audio timestamp', () => {
  const { highlighter, word } = setup();
  highlighter.highlightWordPlan([0, 1, 2].map((index) => ({ index, start: index, end: index + 1 })), { leadSeconds: 0 });
  vi.advanceTimersByTime(1200);
  expect(word()).toBe('two');
  highlighter.setPaused(true);
  vi.advanceTimersByTime(5000);
  highlighter.setPaused(false);
  expect(word()).toBe('two');
  vi.advanceTimersByTime(800);
  expect(word()).toBe('three');
  highlighter.dispose();
});

it('uses word starts when a caller omits an explicit highlight offset', () => {
  const { highlighter, word } = setup();
  highlighter.highlightWordPlan([0, 1, 2].map((index) => ({ index, start: index, end: index + 1 })));
  expect(word()).toBe('One');
  vi.advanceTimersByTime(1200);
  expect(word()).toBe('two');
  highlighter.dispose();
});

it.each([false, true])('rebinds a PDF word plan to replaced text nodes, paused=%s', (paused) => {
  const { highlighter, word, dom } = setup();
  highlighter.highlightWordPlan([0, 1, 2].map((index) => ({ index, start: index, end: index + 1 })), { leadSeconds: 0 });
  vi.advanceTimersByTime(1200);
  if (paused) highlighter.resyncWordPlan({ currentTime: 1.2, paused });
  dom.window.document.querySelector('span').replaceWith(dom.window.document.querySelector('span').cloneNode(true));
  highlighter.highlightChunkByAnchor('pdf-page-1', null, { preserveWordPlan: true });
  expect(word()).toBe('two');
  const range = globalThis.CSS.highlights.get('pagenarrator-word-0').ranges[0];
  expect(range.startContainer.parentElement.tagName).toBe('SPAN');
  vi.advanceTimersByTime(800);
  expect(word()).toBe(paused ? 'two' : 'three');
  // A new reading section must still discard the old plan.
  highlighter.highlightChunkByAnchor('pdf-page-1');
  expect(highlighter.resyncWordPlan({ currentTime: 2 })).toEqual({ ok: false });
  highlighter.dispose();
});
