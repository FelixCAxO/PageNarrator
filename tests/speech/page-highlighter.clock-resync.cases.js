import { createDom, makeVisible, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('pauses and re-anchors a word timing plan from audio-clock resync messages', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));

    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(...ranges) {
        this.ranges = ranges;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({
            name,
            text: highlight.ranges.map((range) => range.toString()).join(''),
          });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0.12, end: 0.24 },
      { index: 1, start: 0.36, end: 0.48 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0.06,
      fadeMs: 180,
    })).toEqual({ ok: true, scheduled: 2 });

    vi.advanceTimersByTime(60);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    expect(highlighter.resyncWordPlan({
      currentTime: 0.1,
      playbackRate: 1,
      paused: true,
    })).toEqual({ ok: true, paused: true, scheduled: 0 });

    vi.advanceTimersByTime(1000);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    expect(highlighter.resyncWordPlan({
      currentTime: 0.1,
      playbackRate: 1,
      paused: false,
    })).toEqual({ ok: true, paused: false, scheduled: 2 });

    vi.advanceTimersByTime(199);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    vi.advanceTimersByTime(1);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'two',
    });
  });

  it('compensates resync messages for transit time before re-anchoring timers', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2 },
      { index: 1, start: 0.2, end: 0.4 },
      { index: 2, start: 0.6, end: 0.9 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
      sentAtEpochMs: 1000,
      nowEpochMs: 1000,
    })).toEqual({ ok: true, scheduled: 3 });

    vi.advanceTimersByTime(0);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    expect(highlighter.resyncWordPlan({
      currentTime: 0.1,
      playbackRate: 1,
      paused: false,
      sentAtEpochMs: 2000,
      nowEpochMs: 2600,
    })).toEqual({ ok: true, paused: false, scheduled: 1 });

    vi.advanceTimersByTime(0);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'three',
    });
  });

  it('applies resynced media time immediately instead of waiting for a local frame clock', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();
    const frames = [];

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2 },
      { index: 1, start: 0.2, end: 0.4 },
      { index: 2, start: 0.4, end: 0.6 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame() {},
    })).toEqual({ ok: true, scheduled: 3 });

    expect(highlighter.resyncWordPlan({
      currentTime: 0.45,
      playbackRate: 1,
      paused: false,
    })).toEqual({ ok: true, paused: false, scheduled: 1 });

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'three',
    });
  });

  it('throws for invalid word plan indices by default in test-like documents', () => {
    const dom = createDom(`
      <body>
        <p>one two</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two')).toEqual({ ok: true });

    expect(() => highlighter.highlightWordPlan([
      { index: 4, start: 0, end: 0.1 },
    ], {
      currentTime: 0,
      setTimer() {
        return 1;
      },
    })).toThrow(/Word highlight index 4 is outside 2 DOM word ranges/);
  });

  it('clears stale word ranges when the next chunk cannot be matched', () => {
    const dom = createDom(`
      <body>
        <p>First chunk text.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));

    const highlighted = [];
    const deleted = [];
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
        delete(name) {
          deleted.push(name);
        },
      },
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('First chunk text.')).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(highlighted.at(-1)).toEqual({ name: 'pagenarrator-word-0', text: 'chunk' });

    expect(highlighter.highlightChunk('Missing second chunk.')).toEqual({ ok: false });

    expect(highlighter.highlightWord(0)).toEqual({ ok: false });
    expect(document.querySelector('p').classList.contains('pagenarrator-current-block')).toBe(false);
    expect(deleted).toContain('pagenarrator-chunk');
    expect(deleted).toContain('pagenarrator-word-0');
  });

  it('cancels scheduled word-plan timers when activating a different chunk', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
        <p>alpha beta gamma</p>
      </body>
    `);
    const { document } = dom.window;
    for (const paragraph of document.querySelectorAll('p')) makeVisible(paragraph);
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 1, start: 0.5, end: 0.7 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
    })).toEqual({ ok: true, scheduled: 1 });

    expect(highlighter.highlightChunk('alpha beta gamma')).toEqual({ ok: true });
    vi.advanceTimersByTime(500);

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toBeNull();
  });
});
