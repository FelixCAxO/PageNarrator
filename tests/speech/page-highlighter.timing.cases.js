import { createDom, makeVisible, makeTextRangeGeometry, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('builds word highlights from spoken words instead of punctuation-wrapped DOM tokens', () => {
    const dom = createDom(`
      <body>
        <p>Wait... "don't-stop," Artificial intelligence (AI) improves tasks[1] quickly.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('Wait... "don\'t-stop," Artificial intelligence (AI) improves tasks[1] quickly.')).toEqual({ ok: true });

    for (const index of [0, 1, 4, 5, 6, 7]) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
    }

    expect(
      highlighted
        .filter((entry) => entry.name === 'pagenarrator-word-0')
        .map((entry) => entry.text),
    ).toEqual([
      'Wait',
      "don't-stop",
      'AI',
      'improves',
      'tasks',
      'quickly',
    ]);
  });

  it('keeps anchored word indices in spoken-word space when raw anchors contain non-spoken markup', () => {
    const dom = createDom(`
      <body>
        <p data-pagenarrator-id="article-ai">Artificial intelligence (AI) improves tasks[1] quickly.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor(
      'article-ai',
      'Artificial intelligence (AI) improves tasks quickly.',
      { chunkText: 'Artificial intelligence (AI) improves tasks quickly.' },
    )).toEqual({ ok: true });

    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'AI',
    });
  });

  it('uses the webpage word trail length in PDF mode', () => {
    const dom = createDom(`
      <body>
        <section data-pagenarrator-id="pdf-page-1">one two three four five</section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document, {
      pdfMode: true,
      defaultWordTrailLength: 4,
    });

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });

    expect(new Set(
      highlighted
        .filter((entry) => entry.name.startsWith('pagenarrator-word-'))
        .map((entry) => entry.name),
    )).toEqual(new Set([
      'pagenarrator-word-0',
      'pagenarrator-word-1',
      'pagenarrator-word-2',
    ]));
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'three',
    });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-2')).toEqual({
      name: 'pagenarrator-word-2',
      text: 'one',
    });
  });

  it('schedules word marks ahead and fades the last word after its spoken end', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));

    const highlighted = [];
    const deleted = [];
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
        delete(name) {
          deleted.push(name);
        },
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

    vi.advanceTimersByTime(59);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    vi.advanceTimersByTime(240);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'two',
    });

    vi.advanceTimersByTime(240);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-1')).toEqual({
      name: 'pagenarrator-word-1',
      text: 'two',
    });

    vi.advanceTimersByTime(180);
    expect(deleted).toContain('pagenarrator-word-3');
  });

  it('records validated word-plan mappings immediately for deterministic flow checks', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    installHighlightCapture();
    const events = [];
    const highlighter = createPageHighlighter(document, {
      flowRecorder: { record: (event) => events.push(event) },
    });

    expect(highlighter.highlightChunk('one two three')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { chunkIndex: 4, speechIndex: 0, index: 0, start: 0.12, end: 0.24, text: 'one' },
      { chunkIndex: 4, speechIndex: 1, index: 1, start: 0.36, end: 0.48, text: 'two' },
    ], {
      currentTime: 0,
      playbackRate: 1,
      recordImmediately: true,
    })).toMatchObject({ ok: true });

    expect(events).toEqual([
      expect.objectContaining({ kind: 'word', chunkIndex: 4, wordIndex: 0, speechText: 'one', domToken: 'one' }),
      expect.objectContaining({ kind: 'word', chunkIndex: 4, wordIndex: 1, speechText: 'two', domToken: 'two' }),
    ]);

    vi.advanceTimersByTime(360);
    expect(events).toHaveLength(2);
  });

  it('anchors scheduled word marks to the audio clock after message latency', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two three four</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three four')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2 },
      { index: 1, start: 0.2, end: 0.4 },
      { index: 2, start: 0.4, end: 0.8 },
      { index: 3, start: 0.8, end: 1 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
      sentAtEpochMs: 1000,
      nowEpochMs: 1500,
    })).toEqual({ ok: true, scheduled: 2 });

    vi.advanceTimersByTime(0);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'three',
    });
  });

  it('keeps latency-delayed word marks visible until their adjusted end time', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <p>one two</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.1, highlightAt: 0.08, endAt: 0.18 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      fadeMs: 180,
    })).toEqual({ ok: true, scheduled: 1 });

    vi.advanceTimersByTime(80);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'one',
    });

    vi.advanceTimersByTime(99);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-1')).toBeNull();

    vi.advanceTimersByTime(46);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-1')).toEqual({
      name: 'pagenarrator-word-1',
      text: 'one',
    });
  });

  it('catches up to the current audio word when a scheduled mark fires late', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const dom = createDom(`
      <body>
        <p>one two three four</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();
    const timers = [];

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three four')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2 },
      { index: 1, start: 0.2, end: 0.4 },
      { index: 2, start: 0.4, end: 0.6 },
      { index: 3, start: 0.6, end: 0.8 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
      nowEpochMs: 1000,
      setTimer(callback, delayMs) {
        timers.push({ callback, delayMs });
        return timers.length;
      },
    })).toEqual({ ok: true, scheduled: 4 });

    vi.setSystemTime(1700);
    timers[0].callback();

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'four',
    });
  });

  it('drives scheduled word plans from one animation-frame loop and cancels it on clear', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const dom = createDom(`
      <body>
        <p>one two three four</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();
    const frames = [];
    const canceled = [];
    let nextFrameId = 1;

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three four')).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2 },
      { index: 1, start: 0.2, end: 0.4 },
      { index: 2, start: 0.4, end: 0.6 },
      { index: 3, start: 0.6, end: 0.8 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      requestFrame(callback) {
        const id = nextFrameId;
        nextFrameId += 1;
        frames.push({ id, callback });
        return id;
      },
      cancelFrame(id) {
        canceled.push(id);
      },
    })).toEqual({ ok: true, scheduled: 4 });

    expect(frames).toHaveLength(1);
    vi.setSystemTime(1500);
    frames.shift().callback();

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'three',
    });
    expect(frames).toHaveLength(1);

    highlighter.clearHighlights();
    expect(canceled).toEqual([2]);
  });

  it('uses timer fallbacks when animation-frame word plans are throttled', () => {
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
      { index: 1, start: 0.25, end: 0.5 },
    ], {
      currentTime: 0,
      playbackRate: 1,
      leadSeconds: 0,
      fadeMs: 180,
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame() {},
    })).toEqual({ ok: true, scheduled: 1 });

    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'two',
    });
  });

  it('draws a visible PDF word overlay for timed generated-audio marks', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Alpha beta gamma">
          <span data-pagenarrator-pdf-order="0">Alpha beta gamma</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    makeTextRangeGeometry(dom.window, {
      top: 120,
      left: 80,
      right: 130,
      bottom: 134,
      width: 50,
      height: 14,
    });
    installHighlightCapture();

    const highlighter = createPageHighlighter(document, { pdfMode: true });

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 0, start: 0, end: 0.2, text: 'Alpha' },
      { index: 1, start: 0.2, end: 0.4, text: 'beta' },
    ], {
      currentTime: 0.25,
      playbackRate: 1,
      leadSeconds: 0,
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: () => 1,
    })).toEqual({ ok: true, scheduled: 1 });

    const wordOverlay = document.querySelector('[data-pagenarrator-region="word"]');
    expect(wordOverlay).toBeTruthy();
    expect(wordOverlay.style.display).toBe('block');
    expect(wordOverlay.style.left).toBe('78px');
    expect(wordOverlay.style.top).toBe('118px');
  });
});
