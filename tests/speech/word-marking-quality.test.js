import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HIGHLIGHT_CHUNK,
  HIGHLIGHT_WORD_TRAIL,
  createPageHighlighter,
} from '../../src/lib/page-highlighter.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

function createDom(html = '<main><p>Default passage for word marking.</p></main>') {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: 'https://example.test/',
  });
  const { document } = dom.window;
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 Chrome Test',
    configurable: true,
  });
  dom.window.scrollBy = () => {};

  for (const element of document.querySelectorAll('main, p, section, span, div, h1, h2, h3')) {
    element.getBoundingClientRect = () => ({
      top: 100,
      left: 60,
      right: 560,
      bottom: 180,
      width: 500,
      height: 80,
    });
  }

  return dom;
}

function installHighlightCapture() {
  const captured = [];
  globalThis.Highlight = class TestHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }

    values() {
      return this.ranges.values();
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        const ranges = highlight.ranges?.length
          ? highlight.ranges
          : (highlight.values ? [...highlight.values()] : []);
        captured.push({
          name,
          text: ranges.map((range) => range.toString()).join(''),
          ranges,
        });
      },
      delete(name) {
        captured.push({ name, text: null, deleted: true });
      },
    },
  };
  return captured;
}

function getLatestHighlight(captured, name) {
  return [...captured].reverse().find((entry) => entry.name === name && !entry.deleted) || null;
}

describe('Word marking quality and visual clarity', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('injects highlight styles without text-shadow on any word trail slot to prevent blurry duplicate text', () => {
    const dom = createDom('<body><p>Clean rendering test.</p></body>');
    const highlighter = createPageHighlighter(dom.window.document);
    highlighter.highlightChunk('Clean rendering test.');

    const style = dom.window.document.getElementById('pagenarrator-highlight-styles');
    expect(style).not.toBeNull();
    const cssText = style.textContent;

    // Verify all 4 trail highlight rules exist
    for (const slotName of HIGHLIGHT_WORD_TRAIL) {
      expect(cssText).toContain(`::highlight(${slotName})`);
    }

    // Crucial: No text-shadow anywhere in the highlight styles
    expect(cssText).not.toContain('text-shadow');

    // Verify clean color inheritance and background variables
    expect(cssText).toContain('color: inherit');
    expect(cssText).toContain('var(--pn-highlight-word-rgb)');
    expect(cssText).toContain('var(--pn-highlight-word-opacity-0)');
  });

  it('correctly sets and updates CSS variables for custom word highlight colors and opacities', () => {
    const dom = createDom('<body><p>Color styling test passage.</p></body>');
    const highlighter = createPageHighlighter(dom.window.document);

    highlighter.setHighlightSettings({
      area: { color: '#2563eb', opacity: 0.2 },
      word: { color: '#9333ea', opacity: 0.85 },
    });
    highlighter.highlightChunk('Color styling test passage.');

    const rootStyle = dom.window.document.documentElement.style;
    expect(rootStyle.getPropertyValue('--pn-highlight-word-rgb')).toBe('147, 51, 234');
    expect(rootStyle.getPropertyValue('--pn-highlight-word-opacity-0')).toBe('0.85');
    // Opacity tiers fade down smoothly
    const op0 = Number.parseFloat(rootStyle.getPropertyValue('--pn-highlight-word-opacity-0'));
    const op1 = Number.parseFloat(rootStyle.getPropertyValue('--pn-highlight-word-opacity-1'));
    const op2 = Number.parseFloat(rootStyle.getPropertyValue('--pn-highlight-word-opacity-2'));
    const op3 = Number.parseFloat(rootStyle.getPropertyValue('--pn-highlight-word-opacity-3'));

    expect(op0).toBeGreaterThan(op1);
    expect(op1).toBeGreaterThan(op2);
    expect(op2).toBeGreaterThan(op3);
  });

  it('marks each spoken word in sequence with the active highlight slot and advances the trail', () => {
    const dom = createDom('<body><p>First second third fourth fifth</p></body>');
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.highlightChunk('First second third fourth fifth')).toEqual({ ok: true });

    // Step through words 0 to 4
    for (let wordIndex = 0; wordIndex < 5; wordIndex += 1) {
      expect(highlighter.highlightWord(wordIndex, 4)).toEqual({ ok: true });
    }

    // At wordIndex 4 ("fifth"):
    // word-0 = fifth, word-1 = fourth, word-2 = third, word-3 = second
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('fifth');
    expect(getLatestHighlight(captured, 'pagenarrator-word-1')?.text).toBe('fourth');
    expect(getLatestHighlight(captured, 'pagenarrator-word-2')?.text).toBe('third');
    expect(getLatestHighlight(captured, 'pagenarrator-word-3')?.text).toBe('second');
  });

  it('accurately highlights words containing apostrophes, hyphens, and quotes without punctuation bleed', () => {
    const text = `The author's "state-of-the-art" method won't fail.`;
    const dom = createDom(`<body><p>${text}</p></body>`);
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });
    const tokens = tokenizeSpokenWords(text);

    for (let index = 0; index < tokens.length; index += 1) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      const marked = getLatestHighlight(captured, 'pagenarrator-word-0');
      expect(marked?.text).toBe(tokens[index].text);
    }
  });

  it('executes a scheduled word plan accurately across 2x playback speed', () => {
    vi.useFakeTimers();
    const text = 'Alpha Beta Gamma Delta';
    const dom = createDom(`<body><p>${text}</p></body>`);
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });

    // 4 words: each 0.4s long in nominal audio time. At 2x speed, each word is 0.2s wall time.
    const plan = [
      { index: 0, start: 0.0, end: 0.4 },
      { index: 1, start: 0.4, end: 0.8 },
      { index: 2, start: 0.8, end: 1.2 },
      { index: 3, start: 1.2, end: 1.6 },
    ];

    expect(highlighter.highlightWordPlan(plan, {
      currentTime: 0,
      playbackRate: 2,
      leadSeconds: 0.05,
      fadeMs: 150,
    })).toEqual({ ok: true, scheduled: 4 });

    // Initial word should be active immediately
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('Alpha');

    // Advance 200ms (0.4s audio time at 2x) -> Word 1 (Beta)
    vi.advanceTimersByTime(200);
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('Beta');
    expect(getLatestHighlight(captured, 'pagenarrator-word-1')?.text).toBe('Alpha');

    // Advance another 200ms -> Word 2 (Gamma)
    vi.advanceTimersByTime(200);
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('Gamma');

    // Advance another 200ms -> Word 3 (Delta)
    vi.advanceTimersByTime(200);
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('Delta');
  });

  it('resynchronizes word plan on pause and resume without drift', () => {
    vi.useFakeTimers();
    const text = 'One Two Three Four';
    const dom = createDom(`<body><p>${text}</p></body>`);
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });

    const plan = [
      { index: 0, start: 0.0, end: 0.5 },
      { index: 1, start: 0.5, end: 1.0 },
      { index: 2, start: 1.0, end: 1.5 },
      { index: 3, start: 1.5, end: 2.0 },
    ];

    highlighter.highlightWordPlan(plan, {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
    });

    vi.advanceTimersByTime(250);
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('One');

    // Pause playback
    expect(highlighter.resyncWordPlan({ paused: true, currentTime: 0.25 })).toEqual({
      ok: true,
      paused: true,
      scheduled: 0,
    });

    // Advance wall clock by 2 seconds while paused -> Should remain on 'One'
    vi.advanceTimersByTime(2000);
    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('One');

    // Resume playback at currentTime 0.75 (Word 1: Two)
    expect(highlighter.resyncWordPlan({ paused: false, currentTime: 0.75 })).toEqual({
      ok: true,
      paused: false,
      scheduled: 3,
    });

    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('Two');
  });

  it('cleans up word and trail highlights completely on clearHighlights', () => {
    const text = 'Clean up after reading.';
    const dom = createDom(`<body><p>${text}</p></body>`);
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    highlighter.highlightChunk(text);
    highlighter.highlightWord(0);
    highlighter.highlightWord(1);

    expect(getLatestHighlight(captured, 'pagenarrator-word-0')?.text).toBe('up');

    highlighter.clearHighlights();

    expect(captured.filter((entry) => entry.deleted).map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        HIGHLIGHT_CHUNK,
        'pagenarrator-word',
        ...HIGHLIGHT_WORD_TRAIL,
      ]),
    );
  });
});
