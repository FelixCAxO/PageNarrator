import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

function createDom(text) {
  const dom = new JSDOM(`<body><p>${text}</p></body>`, { pretendToBeVisual: true, url: 'https://example.test/' });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  dom.window.scrollBy = () => {};
  dom.window.document.querySelector('p').getBoundingClientRect = () => ({
    top: 120,
    left: 80,
    right: 520,
    bottom: 180,
    width: 440,
    height: 60,
  });
  return dom;
}

function installHighlightCapture() {
  const highlighted = [];
  globalThis.Highlight = class TestHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
      this.range = ranges[0] || null;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        const ranges = highlight.ranges?.length ? highlight.ranges : [highlight.range].filter(Boolean);
        highlighted.push({ name, text: ranges.map((range) => range.toString()).join('') });
      },
      delete() {},
    },
  };
  return highlighted;
}

function getLatestWordHighlight(highlighted) {
  return [...highlighted].reverse().find((entry) => entry.name === 'pagenarrator-word-0') || null;
}

describe('page highlighter properties', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('keeps RAF word highlights within the active audio word window across rate and pause changes', () => {
    const tokenArbitrary = fc.array(fc.constantFrom('alpha', 'cafe', 'naive', '東京', 'مرحبا'), {
      minLength: 2,
      maxLength: 10,
    });
    const operationsArbitrary = fc.array(fc.record({
      deltaMs: fc.integer({ min: 0, max: 700 }),
      rate: fc.constantFrom(0.6, 0.85, 1, 1.4, 2),
      paused: fc.boolean(),
    }), { minLength: 2, maxLength: 16 });

    fc.assert(fc.property(tokenArbitrary, operationsArbitrary, (tokens, operations) => {
      vi.useFakeTimers();
      const words = tokens.map((token, index) => `${token}${index}`);
      const durationSeconds = 0.24;
      const dom = createDom(words.join(' '));
      const highlighted = installHighlightCapture();
      const frames = [];
      const canceled = new Set();
      let nextFrameId = 1;
      let wallMs = 1_000;
      let mediaTime = 0;
      let playbackRate = 1;
      let paused = false;

      vi.setSystemTime(wallMs);
      const highlighter = createPageHighlighter(dom.window.document);
      expect(highlighter.highlightChunk(words.join(' '))).toEqual({ ok: true });
      expect(highlighter.highlightWordPlan(words.map((_, index) => ({
        index,
        start: index * durationSeconds,
        end: (index + 1) * durationSeconds,
      })), {
        currentTime: mediaTime,
        playbackRate,
        leadSeconds: 0,
        requestFrame(callback) {
          const id = nextFrameId;
          nextFrameId += 1;
          frames.push({ id, callback });
          return id;
        },
        cancelFrame(id) {
          canceled.add(id);
        },
      })).toMatchObject({ ok: true });

      for (const operation of operations) {
        wallMs += operation.deltaMs;
        if (!paused) mediaTime += (operation.deltaMs / 1000) * playbackRate;
        mediaTime = Math.min(mediaTime, words.length * durationSeconds);
        playbackRate = operation.rate;
        paused = operation.paused;
        vi.setSystemTime(wallMs);

        highlighter.resyncWordPlan({
          currentTime: mediaTime,
          playbackRate,
          paused,
          sentAtEpochMs: wallMs,
        });

        const frameIndex = frames.findIndex((frame) => !canceled.has(frame.id));
        if (frameIndex !== -1) {
          const [frame] = frames.splice(frameIndex, 1);
          frame.callback();
        }
        if (paused) continue;

        const latest = getLatestWordHighlight(highlighted);
        if (!latest) continue;
        const highlightIndex = words.indexOf(latest.text);
        const audioChunkIndex = Math.min(words.length - 1, Math.floor(mediaTime / durationSeconds));
        const wordCount = 2;

        expect(highlightIndex).toBeGreaterThanOrEqual(0);
        expect(highlightIndex).toBeLessThanOrEqual(audioChunkIndex);
        expect(audioChunkIndex).toBeLessThan(highlightIndex + wordCount);
      }

      highlighter.clearHighlights();
    }), { numRuns: 30 });
  });
});
