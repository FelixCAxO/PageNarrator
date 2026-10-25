import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import {
  buildReadingModel,
  getDomWordIndexForSpeechWord,
  renderReadingModelForSpeechChunks,
} from '../../src/lib/reading-model.js';
import { chunkText } from '../../src/lib/speech-chunks.js';
import { createProgressiveSegmentChunk } from '../../src/lib/reader-engine-chunks.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

function createTableDocument(caption = '<caption>Quarterly plan prices</caption>') {
  const dom = new JSDOM(`
    <title>Pricing</title>
    <main>
      <p>Compare the plans below before you upgrade your account.</p>
      <table>
        ${caption}
        <tr><th>Plan name</th><th>Monthly price</th><th>Seats</th></tr>
        <tr><td>Starter team</td><td>$5</td><td>3</td></tr>
        <tr><td>Growth</td><td></td><td>25 seats</td></tr>
      </table>
    </main>
  `, { pretendToBeVisual: true, url: 'https://example.test/pricing' });
  dom.window.scrollBy = () => {};
  return dom.window.document;
}

let highlighted = [];

beforeEach(() => {
  highlighted = [];
  globalThis.Highlight = class TestHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        highlighted.push({ name, text: highlight.ranges.map((range) => range.toString()).join('') });
      },
      delete() {},
    },
  };
});

afterEach(() => {
  delete globalThis.Highlight;
  delete globalThis.CSS;
});

// Drives the real page highlighter: activates the chunk's anchor, then highlights the page word
// each spoken word maps to. Returns [spokenWord, highlightedPageWord] pairs.
function highlightedPairs(document, chunk) {
  const highlighter = createPageHighlighter(document);
  expect(highlighter.highlightChunkByAnchor(chunk.anchorId, chunk.anchorText, { chunkText: chunk.anchorText }).ok).toBe(true);
  return tokenizeSpokenWords(chunk.speech).flatMap((token, index) => {
    const domIndex = getDomWordIndexForSpeechWord(chunk, index);
    if (domIndex < 0) return [];
    highlighted = [];
    highlighter.highlightWord(domIndex, 1);
    const word = highlighted.find((entry) => entry.name === 'pagenarrator-word-0')?.text || '';
    return [[token.text.toLowerCase(), word.replace(/^\$/, '').toLowerCase()]];
  });
}

function tableChunks(document) {
  return renderReadingModelForSpeechChunks(buildReadingModel(document))
    .filter((chunk) => chunk.type === 'table' || chunk.type === 'table-row');
}

describe('table word highlight sync', () => {
  it('maps grouped headers, merged rows, and reordered ARIA cells to the words actually present', () => {
    for (const html of [
      `<table><thead><tr><th rowspan="2">Task</th><th colspan="2">Dates</th></tr><tr><th>Submission</th><th>Feedback</th></tr></thead>
        <tbody><tr><td rowspan="2">Alpha</td><td>Monday</td><td>Friday</td></tr><tr><td>Tuesday</td><td>Saturday</td></tr></tbody></table>`,
      `<div role="table"><div role="row"><span role="columnheader">Task</span><span role="columnheader">Due</span></div>
        <div role="row"><span role="cell" aria-colindex="2">Monday</span><span role="cell" aria-colindex="1">Alpha</span></div></div>`,
      `<table><tfoot><tr><td>Total</td><td>Three</td></tr></tfoot><thead><tr><th>Task</th><th>Count</th></tr></thead>
        <tbody><tr><td>Alpha</td><td>Two</td></tr><tr><td>Beta</td><td>One</td></tr></tbody></table>`,
    ]) {
      const document = new JSDOM(`<main>${html}</main>`, { pretendToBeVisual: true }).window.document;
      document.defaultView.scrollBy = () => {};
      for (const chunk of tableChunks(document)) {
        const pairs = highlightedPairs(document, chunk);
        expect(pairs.length).toBeGreaterThan(0);
        expect(pairs.every(([spoken, page]) => spoken === page), JSON.stringify(pairs)).toBe(true);
      }
    }
  });

  it('highlights the caption and column words the table title actually speaks', () => {
    const document = createTableDocument();
    const [title] = tableChunks(document);

    expect(title.speech).toBe('Table: Quarterly plan prices. 3 columns: Plan name, Monthly price, and Seats.');
    const pairs = highlightedPairs(document, title);
    expect(pairs.every(([spoken, page]) => spoken === page)).toBe(true);
    expect(pairs.map(([spoken]) => spoken)).toEqual([
      'quarterly', 'plan', 'prices', 'plan', 'name', 'monthly', 'price', 'seats',
    ]);
    // "Table", "3", "columns" and "and" exist only in speech, so they don't move the highlight.
    expect(getDomWordIndexForSpeechWord(title, 0)).toBe(-1);
  });

  it('keeps the title in sync when the table has no caption', () => {
    const document = createTableDocument('');
    const [title] = tableChunks(document);

    expect(title.speech).toBe('Table. 3 columns: Plan name, Monthly price, and Seats.');
    const pairs = highlightedPairs(document, title);
    expect(pairs.length).toBe(5);
    expect(pairs.every(([spoken, page]) => spoken === page)).toBe(true);
  });

  it('skips spoken header labels and empty cells in table rows', () => {
    const document = createTableDocument();
    const rows = tableChunks(document).filter((chunk) => chunk.type === 'table-row');

    expect(rows.map((row) => row.speech)).toEqual([
      'Plan name, Starter team - Monthly price, $5 - Seats, 3.',
      'Plan name, Growth - Seats, 25 seats.',
    ]);
    for (const row of rows) {
      const pairs = highlightedPairs(document, row);
      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.every(([spoken, page]) => spoken === page)).toBe(true);
    }
  });

  it('keeps the word map aligned when a long table title is split into speech chunks', () => {
    const document = createTableDocument();
    const [title] = tableChunks(document);
    const pieces = chunkText([title], 40, { targetMinLen: 0 });

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((piece) => piece.speech).join(' ')).toBe(title.speech);
    const pairs = pieces.flatMap((piece) => highlightedPairs(document, piece));
    expect(pairs.map(([spoken]) => spoken)).toEqual([
      'quarterly', 'plan', 'prices', 'plan', 'name', 'monthly', 'price', 'seats',
    ]);
    expect(pairs.every(([spoken, page]) => spoken === page)).toBe(true);
  });

  it('keeps the word map aligned for progressive playback segments', () => {
    const document = createTableDocument();
    const [title] = tableChunks(document);
    const words = tokenizeSpokenWords(title.speech);
    const segment = createProgressiveSegmentChunk(title, {
      text: title.speech.slice(words[5].start),
      speechWordOffset: 5,
    });

    const pairs = highlightedPairs(document, segment);
    expect(pairs.map(([spoken]) => spoken)).toEqual(['plan', 'name', 'monthly', 'price', 'seats']);
    expect(pairs.every(([spoken, page]) => spoken === page)).toBe(true);
  });
});
