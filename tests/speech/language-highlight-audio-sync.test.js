import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { estimateWordTimings, pcmToWavBlob } from '../../src/lib/speech-audio.js';
import { chunkText } from '../../src/lib/speech-chunks.js';
import { startWordHighlightLoop } from '../../src/lib/speech-playback.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

const SUPPORTED_LANGUAGE_CODES = Object.freeze(['en', 'sv', 'de', 'fr', 'nl']);

const LANGUAGE_SYNC_FIXTURES = Object.freeze([
  {
    code: 'en',
    label: 'English',
    text: 'Aeon Essays examines attention while Vox explains policy and The Verge Tech follows newsroom tools.',
  },
  {
    code: 'sv',
    label: 'Swedish',
    text: 'SVT Nyheter rapporterar beslutet medan Dagens Nyheter granskar bakgrunden och Svenska Dagbladet beskriver foljderna.',
  },
  {
    code: 'de',
    label: 'German',
    text: 'DIE ZEIT ordnet die Debatte ein, waehrend die Sueddeutsche Zeitung Folgen beschreibt und DER SPIEGEL Aussagen prueft.',
  },
  {
    code: 'fr',
    label: 'French',
    text: 'Le Monde analyse la decision, Le Point revient sur les reactions et franceinfo suit les habitants concernes.',
  },
  {
    code: 'nl',
    label: 'Dutch',
    text: 'NOS Nieuws meldt het besluit, De Telegraaf beschrijft de druk en Omroep Brabant volgt de gevolgen.',
  },
]);

function createVisibleArticleDom(text) {
  const dom = new JSDOM(`<body><article><p>${text}</p></article></body>`, {
    pretendToBeVisual: true,
    url: 'https://example.test/',
  });
  const { document } = dom.window;
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  dom.window.scrollBy = () => {};

  for (const element of document.querySelectorAll('article, p')) {
    element.getBoundingClientRect = () => ({
      top: 120,
      left: 96,
      right: 640,
      bottom: 210,
      width: 544,
      height: 90,
    });
  }

  return dom;
}

function installHighlightCapture() {
  const captured = [];
  globalThis.Highlight = class TestHighlight {
    constructor(range) {
      this.range = range;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        captured.push({ name, text: highlight.range.toString() });
      },
      delete() {},
    },
  };
  return captured;
}

function createFrameScheduler() {
  const frames = [];
  let nextId = 1;

  return {
    requestFrame(callback) {
      frames.push(callback);
      nextId += 1;
      return nextId;
    },
    cancelFrame() {},
    flush() {
      const callback = frames.shift();
      if (callback) callback();
    },
  };
}

function getLatestWordHighlight(captured) {
  return [...captured].reverse().find((entry) => entry.name === 'pagenarrator-word-0') || null;
}

function createSyntheticMarkerAudio(tokens, secondsPerToken = 0.32) {
  const sampleRate = 8000;
  const durationSeconds = tokens.length * secondsPerToken;
  const audio = new Float32Array(Math.ceil(durationSeconds * sampleRate));
  const wordTimings = tokens.map((token, index) => {
    const start = index * secondsPerToken;
    const markerSample = Math.floor(start * sampleRate);
    audio[markerSample] = 0.95;
    return {
      start,
      end: start + secondsPerToken * 0.75,
      text: token.text,
    };
  });

  return {
    blob: pcmToWavBlob(audio, sampleRate),
    durationSeconds,
    wordTimings,
  };
}

describe('language highlight audio sync', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('keeps scheduled word marks ahead of speech after simulated message latency', () => {
    vi.useFakeTimers();
    const text = 'one two three';
    const dom = createVisibleArticleDom(text);
    const captured = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });
    expect(highlighter.highlightWordPlan([
      { index: 1, start: 0.2, end: 0.36 },
      { index: 2, start: 0.42, end: 0.58 },
    ], {
      currentTime: 0.05,
      playbackRate: 1,
      leadSeconds: 0.06,
      fadeMs: 180,
    })).toEqual({ ok: true, scheduled: 2 });

    vi.advanceTimersByTime(89);
    expect(getLatestWordHighlight(captured)).toBeNull();

    vi.advanceTimersByTime(1);
    expect(getLatestWordHighlight(captured)).toEqual({
      name: 'pagenarrator-word-0',
      text: 'two',
    });
  });

  it('keeps sync fixtures scoped to currently supported languages', () => {
    expect(LANGUAGE_SYNC_FIXTURES.map(({ code }) => code)).toEqual(SUPPORTED_LANGUAGE_CODES);
  });

  it('keeps long English timing units bounded and monotonic before page scheduling', () => {
    const samples = [
      [
        'Editors trace the policy change',
        'compare the agency memo',
        'quote the affected teams',
        'and keep the unresolved exception in view while the paragraph continues without a final stop',
      ].join(', '),
      Array.from({ length: 38 }, (_, index) => `plainword${index + 1}`).join(' '),
    ];

    for (const text of samples) {
      const chunks = chunkText(text, 110, { targetMinLen: 70 });
      expect(chunks.length, text).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 110), text).toBe(true);

      for (const chunk of chunks) {
        const timings = estimateWordTimings(chunk, Math.max(1.2, chunk.length / 24), { languageCode: 'en' });
        const tokens = tokenizeSpokenWords(chunk);
        expect(timings).toHaveLength(tokens.length);
        timings.forEach((timing) => {
          expect(timing.start).toBeGreaterThanOrEqual(0);
          expect(timing.end).toBeGreaterThan(timing.start);
          expect(timing.end).toBeLessThanOrEqual(timings.at(-1).end);
        });
        for (let index = 1; index < timings.length; index += 1) {
          expect(timings[index].start).toBeGreaterThanOrEqual(timings[index - 1].end);
        }
      }
    }
  });

  it.each(LANGUAGE_SYNC_FIXTURES)('moves the yellow word mark from the browser audio clock for $label', ({ code, text }) => {
    const dom = createVisibleArticleDom(text);
    const captured = installHighlightCapture();
    const scheduler = createFrameScheduler();
    const highlighter = createPageHighlighter(dom.window.document);
    const tokens = tokenizeSpokenWords(text);
    const timings = estimateWordTimings(text, 8, { languageCode: code });
    const audio = { currentTime: 0 };
    const indices = [0, 1, 2, 3].filter((index) => index < timings.length);

    expect(tokens.length).toBeGreaterThanOrEqual(indices.length);
    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });

    const stop = startWordHighlightLoop({
      wordTimings: timings,
      getCurrentTime: () => audio.currentTime,
      onHighlight: (index) => highlighter.highlightWord(index),
      leadSeconds: 0,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    try {
      for (const index of indices) {
        audio.currentTime = timings[index].start + 0.001;
        scheduler.flush();
        expect(getLatestWordHighlight(captured)).toEqual({
          name: 'pagenarrator-word-0',
          text: tokens[index].text,
        });
      }
    } finally {
      stop();
    }
  });

  it.each(LANGUAGE_SYNC_FIXTURES)('keeps yellow marks aligned to synthetic marker audio for $label', ({ text }) => {
    const dom = createVisibleArticleDom(text);
    const captured = installHighlightCapture();
    const scheduler = createFrameScheduler();
    const highlighter = createPageHighlighter(dom.window.document);
    const tokens = tokenizeSpokenWords(text).slice(0, 5);
    const synthetic = createSyntheticMarkerAudio(tokens);
    const audio = {
      currentTime: 0,
      duration: synthetic.durationSeconds,
      srcBlob: synthetic.blob,
    };

    expect(audio.srcBlob).toBeInstanceOf(Blob);
    expect(highlighter.highlightChunk(text)).toEqual({ ok: true });

    const stop = startWordHighlightLoop({
      wordTimings: synthetic.wordTimings,
      getCurrentTime: () => audio.currentTime,
      onHighlight: (index) => highlighter.highlightWord(index),
      leadSeconds: 0,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    try {
      synthetic.wordTimings.forEach((timing, index) => {
        audio.currentTime = timing.start + 0.001;
        scheduler.flush();
        expect(getLatestWordHighlight(captured)).toEqual({
          name: 'pagenarrator-word-0',
          text: tokens[index].text,
        });
      });
    } finally {
      stop();
    }
  });
});
