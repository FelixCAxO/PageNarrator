// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createPageHighlighter, HIGHLIGHT_WORD_TRAIL } from '../../src/lib/page-highlighter.js';
import { annotatePdfTextLayer } from '../../src/lib/pdf-extraction.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import { chunkText } from '../../src/lib/speech-chunks.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item as pdfItem } from './pdf-page-model.fixtures.js';

const driver = readFileSync(new URL('../../scripts/run-pdf-acceptance.mjs', import.meta.url), 'utf8');
// Exercise the existing private driver functions with their real DOM/highlighting dependencies.
// This follows the reporting-test convention without opening PDFs, importing the CLI or exporting test hooks.
function driverHelpers(extractPdfTextFromData) {
  const functions = driver.slice(driver.indexOf('async function getProductionPageText('),
    driver.indexOf('\nasync function evaluateImageOnlyFixtures('));
  const normalization = driver.slice(driver.indexOf('\nfunction normalizeText('), driver.indexOf('\nfunction sha256('));
  return new Function('dependencies', `
    const { JSDOM, createPageHighlighter, HIGHLIGHT_WORD_TRAIL, annotatePdfTextLayer,
      getDomWordIndexForSpeechWord, chunkText, tokenizeSpokenWords, createPdfPageModel,
      extractPdfTextFromData } = dependencies;
    ${functions}
    ${normalization}
    return { getProductionPageText, evaluateGrounding };
  `)({ JSDOM, createPageHighlighter, HIGHLIGHT_WORD_TRAIL, annotatePdfTextLayer,
    getDomWordIndexForSpeechWord, chunkText, tokenizeSpokenWords, createPdfPageModel,
    extractPdfTextFromData });
}

const speech = 'Report explains this result.';
const item = (str, y) => ({ str, transform: [10, 0, 0, 10, 40, y], width: str.length * 5,
  height: 10, fontName: 'authored-unit-font', hasEOL: true });
const page = () => ({ items: [item('Report', 700), item(speech, 680), item('Report', 660)],
  pageCount: 2, pageView: [0, 0, 612, 792] });
const record = { id: 'fixture-running-content', pageNumber: 2 };

describe('PDF acceptance uses the production narration metadata contract', () => {
  afterEach(() => { delete globalThis.CSS; delete globalThis.Highlight; });

  // Same repeated-header/body distinction as page-highlighter.pdf-order.cases.js.
  // These are authored text items, not corpus gold or a raster/geometry acceptance fixture.
  it.each([false, true])('keeps document narration metadata when present: %s', async (withMetadata) => {
    const pdfNarration = { speech, narratedItemOrders: [1] };
    const pageChunk = { pageNumber: 2, anchorText: `Report ${speech} Report`, speech,
      ...(withMetadata ? { pdfNarration } : {}) };
    const extract = vi.fn(async () => ({ chunks: [pageChunk] }));
    const helpers = driverHelpers(extract);
    const pageText = await helpers.getProductionPageText(new Uint8Array([0]), record, page(), {});
    expect(pageText.pdfNarration).toBe(withMetadata ? pdfNarration : undefined);
    const result = helpers.evaluateGrounding(record, page(), pageText);
    expect(result.chunks).toHaveLength(1);
    expect(result.words).toHaveLength(4);
    if (withMetadata) {
      expect(result.words.every(word => word.aligned)).toBe(true);
    } else {
      // Page-local narration includes the repeated words. Do not invent a document-level filter.
      expect(result.words.some(word => !word.aligned)).toBe(true);
    }
  });

  it('retains page-local word alignment when no document filter is needed', async () => {
    const extract = vi.fn();
    const helpers = driverHelpers(extract);
    const local = { items: [item(speech, 680)], pageCount: 1, pageView: [0, 0, 612, 792] };
    const localRecord = { id: 'authored-page-local-control', pageNumber: 1 };
    const pageText = await helpers.getProductionPageText(new Uint8Array([0]), localRecord, local, {});
    const result = helpers.evaluateGrounding(localRecord, local, pageText);
    expect(extract).not.toHaveBeenCalled();
    expect(result.words).toHaveLength(4);
    expect(result.words.every(word => word.aligned)).toBe(true);
  });

  it.each([[true, 1], [false, 2]])('preserves deferred caption word ranges for a page-local model (EOL=%s, pages=%s)', async (hasEOL, pageCount) => {
    const extract = vi.fn();
    const helpers = driverHelpers(extract);
    // Reuse the original four-item cross-column control from pdf-page-model.figures.cases.js.
    const local = { items: [
      pdfItem('The example crosses a column bound-', 50, 100, 220, 9, { fontName: 'Body', hasEOL: true }),
      pdfItem('Figure 1: A sample diagram.', 310, 450, 190, 9, { fontName: 'Body', hasEOL: false }),
      pdfItem('ary.', 310, 268, 30, 9, { fontName: 'Body', hasEOL }),
      pdfItem('Following body paragraph.', 320, 254, 130, 9, { fontName: 'BodyBold', hasEOL: false }),
    ], pageCount, pageView: [0, 0, 600, 840] };
    const localRecord = { id: 'authored-deferred-caption-control', pageNumber: 1 };
    const pageText = await helpers.getProductionPageText(new Uint8Array([0]), localRecord, local, {});
    const expected = 'The example crosses a column boundary. Figure 1: A sample diagram. Following body paragraph.';
    expect(pageText.speech).toBe(expected);
    const result = helpers.evaluateGrounding(localRecord, local, pageText);
    expect(extract).not.toHaveBeenCalled();
    expect(result.words.filter(word => !word.aligned)).toEqual([]);
    expect(pageText.pdfNarration?.speech).toBe(expected);
  });
});
