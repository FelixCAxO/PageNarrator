import { readReaderEngineSourceSurface } from "./reader-engine-view.fixtures.js";
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { createReadingQueueWindow, createResumePrompt, getChunkWordCounts } from "../../src/lib/reader-engine-view.js";

describe('toolbar player view model', () => {
  it('builds a reading queue with current and completed chunk state', () => {
    const queue = createReadingQueueWindow(['Intro text', 'Middle text', 'Final text'], 1).items;

    expect(queue).toEqual([
      { number: 1, text: 'Intro text', state: 'done' },
      { number: 2, text: 'Middle text', state: 'current' },
      { number: 3, text: 'Final text', state: 'upcoming' },
    ]);
  });

  it('creates a bounded queue window around the active section for long PDFs', () => {
    const chunks = Array.from({ length: 100 }, (_, index) => ({
      speech: `Section ${index + 1} text.`,
      pageNumber: Math.floor(index / 2) + 1,
    }));
    const queue = createReadingQueueWindow(chunks, 49, { windowSize: 10 });

    expect(queue.items).toHaveLength(10);
    expect(queue.items.map((item) => item.number)).toEqual([46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
    expect(queue.items.find((item) => item.number === 50)).toMatchObject({
      number: 50,
      state: 'current',
      text: 'Page 25 · Section 50 text.',
      pageNumber: 25,
    });
    expect(queue.totalCount).toBe(100);
    expect(queue.visibleCount).toBe(10);
    expect(queue.startNumber).toBe(46);
    expect(queue.endNumber).toBe(55);
    expect(queue.isLimited).toBe(true);
    expect(queue.countLabel).toBe('100 sections · 46-55 shown');
  });

  it('filters large PDF queues by transcript text or page number', () => {
    const chunks = Array.from({ length: 100 }, (_, index) => ({
      speech: `Section ${index + 1} text about ${index === 72 ? 'billing evidence' : 'general notes'}.`,
      pageNumber: Math.floor(index / 2) + 1,
    }));

    const textMatches = createReadingQueueWindow(chunks, 0, { query: 'billing evidence' });
    expect(textMatches.items.map((item) => item.number)).toEqual([73]);
    expect(textMatches.countLabel).toBe('1 match of 100 sections');

    const pageMatches = createReadingQueueWindow(chunks, 0, { query: 'page 25' });
    expect(pageMatches.items.map((item) => item.number)).toEqual([49, 50]);
    expect(pageMatches.countLabel).toBe('2 matches of 100 sections');
  });

  it('caches repeated queue searches for the same chunk list and query', () => {
    let speechReads = 0;
    const chunks = Array.from({ length: 80 }, (_, index) => {
      const chunk = { pageNumber: index + 1 };
      Object.defineProperty(chunk, 'speech', {
        configurable: true,
        get() {
          speechReads += 1;
          return `Section ${index + 1} general notes.`;
        },
      });
      return chunk;
    });

    const first = createReadingQueueWindow(chunks, 0, { query: 'missing phrase' });
    const readsAfterFirstSearch = speechReads;
    const second = createReadingQueueWindow(chunks, 12, { query: 'missing phrase' });

    expect(first.items).toEqual([]);
    expect(second.items).toEqual([]);
    expect(readsAfterFirstSearch).toBeGreaterThan(0);
    expect(speechReads).toBe(readsAfterFirstSearch);
  });

  it('evicts old queue-search cache entries for one chunk list after 100 unique queries', () => {
    let speechReads = 0;
    const chunks = [
      {
        get speech() {
          speechReads += 1;
          return 'Alpha beta gamma searchable section.';
        },
        pageNumber: 1,
      },
    ];

    createReadingQueueWindow(chunks, 0, { query: 'alpha' });
    expect(speechReads).toBeGreaterThan(0);

    speechReads = 0;
    createReadingQueueWindow(chunks, 0, { query: 'alpha' });
    expect(speechReads).toBe(0);

    for (let index = 0; index < 100; index += 1) {
      createReadingQueueWindow(chunks, 0, { query: `missing-${index}` });
    }

    createReadingQueueWindow(chunks, 0, { query: 'alpha' });
    expect(speechReads).toBeGreaterThan(0);
  });

  it('creates a compact resume prompt from saved progress', () => {
    expect(createResumePrompt({
      progressPercent: 42,
      chunk: 8,
      totalChunks: 20,
      title: 'Long article',
      excerpt: 'This is the sentence near the saved listening position.',
    })).toEqual({
      visible: true,
      title: 'Resume at 42%',
      detail: 'Long article · Section 9 of 20',
      excerpt: 'This is the sentence near the saved listening position.',
    });

    expect(createResumePrompt(null).visible).toBe(false);
  });

  it('keeps bounded queue windows stable near the start and end of a book', () => {
    const chunks = Array.from({ length: 15 }, (_, index) => `Section ${index + 1} text.`);

    expect(createReadingQueueWindow(chunks, 0, { windowSize: 10 }).items.map((item) => item.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(createReadingQueueWindow(chunks, 14, { windowSize: 10 }).items.map((item) => item.number)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(createReadingQueueWindow(['Only one'], 0, { windowSize: 10 })).toMatchObject({
      totalCount: 1,
      visibleCount: 1,
      startNumber: 1,
      endNumber: 1,
      isLimited: false,
      countLabel: '1 section',
    });
  });

  it('adds PDF page wayfinding to queue items without dropping chunk order', () => {
    const queue = createReadingQueueWindow([
      { speech: 'Opening page text.', pageNumber: 1 },
      { speech: 'More page text.', pageNumber: 1 },
      { speech: 'Next page text.', pageNumber: 2 },
    ], 2).items;

    expect(queue).toEqual([
      { number: 1, text: 'Page 1 · Opening page text.', state: 'done', pageNumber: 1 },
      { number: 2, text: 'Page 1 · More page text.', state: 'done', pageNumber: 1 },
      { number: 3, text: 'Page 2 · Next page text.', state: 'current', pageNumber: 2 },
    ]);
  });

  it('uses compact PDF chunk metadata for queue text and progress', () => {
    const chunks = [
      {
        compact: true,
        preview: 'A compact PDF history preview.',
        wordCount: 88,
        pageNumber: 12,
        anchorId: 'pdf-page-12',
      },
      {
        speech: 'Current full PDF speech.',
        pageNumber: 13,
        anchorId: 'pdf-page-13',
      },
    ];

    expect(getChunkWordCounts(chunks)).toEqual([88, 4]);
    expect(createReadingQueueWindow(chunks, 1).items).toEqual([
      {
        number: 1,
        text: 'Page 12 · A compact PDF history preview.',
        state: 'done',
        pageNumber: 12,
      },
      {
        number: 2,
        text: 'Page 13 · Current full PDF speech.',
        state: 'current',
        pageNumber: 13,
      },
    ]);
  });

  it('keeps queue items keyboard reachable and visibly focused', () => {
    const html = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../src/reader-engine.css', import.meta.url), 'utf8');
    const js = readReaderEngineSourceSurface();

    expect(js).toContain("node.setAttribute('role', 'button')");
    expect(js).toContain('node.tabIndex = 0');
    expect(js).toContain("node.addEventListener('click'");
    expect(js).toContain("node.addEventListener('keydown'");
    expect(js).toContain('createReadingQueueWindow(chunks, activeIndex');
    expect(html).toContain('id="queue-search-input"');
    expect(js).toContain('queueSearchInput');
    expect(js).toContain('queueSearchQuery');
    expect(js).toContain("on(els.queueFirst, 'click', actions.jumpToFirstChunk)");
    expect(js).toContain("on(els.pdfPageFirst, 'click', actions.jumpToFirstPdfPage)");
    expect(js).toContain("on(els.pdfPageSkip, 'click', actions.skipCurrentPdfPage)");
    expect(js).toContain("on(els.pdfPageJump, 'click', actions.jumpToEnteredPdfPage)");
    expect(js).toContain("on(els.queueJumpInput, 'keydown'");
    expect(js).toContain("on(els.pdfPageJumpInput, 'keydown'");
    expect(js).toContain('createTranscriptWindow(text');
    expect(js).toContain('renderPdfPageControls()');
    expect(js).toContain('readOrchestrator.compactPdfChunkHistory');
    expect(css).toContain('.reading-queue li:focus-visible');
    expect(css).toContain('.queue-nav');
    expect(css).toContain('.pdf-page-nav');
    expect(html).toContain('id="prev-btn"');
    expect(html).toContain('id="read-selected-btn"');
    expect(html).toContain('id="queue-jump-input"');
  });
});
