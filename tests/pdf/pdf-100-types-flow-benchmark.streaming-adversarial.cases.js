import { loadFixturePdfBytes, getFixtureRecord, extractFromPdf } from "./pdf-100-types-flow-benchmark.fixtures.js";
import { describe, expect, it } from 'vitest';

import { JSDOM } from 'jsdom';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { annotatePdfTextLayer, extractPdfTextFromData, iteratePdfSpeechChunks, PDF_TEXT_LAYER_ORDER_ATTRIBUTE, PDF_TEXT_LAYER_NARRATED_ATTRIBUTE, PDF_TEXT_LAYER_TEXT_ATTRIBUTE } from "../../src/lib/pdf-extraction.js";
import { chunkText } from "../../src/lib/speech-chunks.js";
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';

import { buildPdfBytes } from '../helpers/pdf-test-generator.js';

describe('100 PDF Types & Flow Naturalness Benchmark (Real PDF Binaries)', () => {
  describe('Family 7: Streaming & Highlighter Grounding', () => {
    it('Type 86: Multi-page streaming chunk iterator emits chunks sequentially from real PDF', async () => {
      const record = getFixtureRecord('fixture-running-content');
      const bytes = loadFixturePdfBytes(record.source);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const document = await loadingTask.promise;

      try {
        const chunks = [];
        for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 400, targetMinLen: 150, pdfjs })) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(5);
        expect(chunks.every((chunk) => chunk.type === 'pdf-page')).toBe(true);
      } finally {
        await loadingTask.destroy();
      }
    });

    it('Type 87: Single-page document yields immediately without waiting for sample buffer', async () => {
      const record = getFixtureRecord('fixture-title-single-column');
      const bytes = loadFixturePdfBytes(record.source);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const document = await loadingTask.promise;

      try {
        const chunks = [];
        for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 500, pdfjs })) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].pageNumber).toBe(1);
      } finally {
        await loadingTask.destroy();
      }
    });

    it('Type 88: Start reading from page N > 1 begins streaming at designated page', async () => {
      const record = getFixtureRecord('fixture-running-content');
      const bytes = loadFixturePdfBytes(record.source);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const document = await loadingTask.promise;

      try {
        const chunks = [];
        for await (const chunk of iteratePdfSpeechChunks(document, { startPage: 5, pdfjs })) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].pageNumber).toBe(5);
      } finally {
        await loadingTask.destroy();
      }
    });

    it('Type 89: Streaming chunk maxLen limit is strictly respected', () => {
      const longText = Array.from({ length: 30 }, (_, i) => `Sentence ${i + 1} explains a distinct concept with sufficient prose.`).join(' ');
      const chunks = chunkText([{
        type: 'pdf-page',
        speech: longText,
        text: longText,
        anchorText: longText,
        anchorId: 'pdf-page-1',
        speechPrefixWords: 0,
        pageNumber: 1,
      }], 300, { targetMinLen: 120 });

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.speech.length).toBeLessThanOrEqual(300);
      }
    });

    it('Type 90: Streaming chunk targetMinLen groups smaller sentences together', () => {
      const shortSentences = ['First short sentence.', 'Second short sentence.', 'Third short sentence.', 'Fourth short sentence.'];
      const text = shortSentences.join(' ');
      const chunks = chunkText(text, 300, { targetMinLen: 80 });
      expect(chunks.length).toBeLessThan(shortSentences.length);
    });

    it('Type 91: DOM text layer order attribute tagging sets data-pagenarrator-pdf-order', () => {
      const dom = new JSDOM('<!DOCTYPE html><div id="pdf-page-1" class="textLayer"><span>Hello</span><span>World</span></div>');
      const textLayerEl = dom.window.document.getElementById('pdf-page-1');
      const items = [
        { str: 'Hello', transform: [1, 0, 0, 1, 50, 700], width: 40, height: 12 },
        { str: 'World', transform: [1, 0, 0, 1, 100, 700], width: 40, height: 12 },
      ];

      const annotated = annotatePdfTextLayer(textLayerEl, items);
      expect(textLayerEl.dataset.pagenarratorPdfOrder).toBe('true');
      expect(annotated[0].span.getAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE)).toBe('0');
      expect(textLayerEl.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).toBe('Hello World.');
    });

    it('Type 92: DOM text layer narrated flag tagging marks content appropriately', () => {
      const dom = new JSDOM('<!DOCTYPE html><div id="pdf-page-1" class="textLayer"><span>Title</span></div>');
      const textLayerEl = dom.window.document.getElementById('pdf-page-1');
      const items = [{ str: 'Title', transform: [1, 0, 0, 1, 50, 700], width: 40, height: 12 }];

      const annotated = annotatePdfTextLayer(textLayerEl, items);
      expect(annotated.length).toBe(1);
      expect(annotated[0].span.getAttribute(PDF_TEXT_LAYER_NARRATED_ATTRIBUTE)).toBe('true');
    });

    it('Type 93: Speech chunk DOM anchor ID assignment anchors by page', () => {
      const chunks = chunkText([{
        type: 'pdf-page',
        speech: 'Page one content.',
        text: 'Page one content.',
        anchorText: 'Page one content.',
        anchorId: 'pdf-page-1',
        speechPrefixWords: 0,
        pageNumber: 1,
      }]);
      expect(chunks[0].anchorId).toBe('pdf-page-1');
    });

    it('Type 94: Monotonic domWordOffset across consecutive split speech chunks', () => {
      const longSpeech = Array.from({ length: 15 }, (_, i) => `Paragraph sentence number ${i + 1} contains important analytical details.`).join(' ');
      const chunks = chunkText([{
        type: 'pdf-page',
        speech: longSpeech,
        text: longSpeech,
        anchorText: longSpeech,
        anchorId: 'pdf-page-1',
        speechPrefixWords: 0,
        pageNumber: 1,
      }], 200, { targetMinLen: 80 });

      expect(chunks.length).toBeGreaterThan(1);
      let previousOffset = -1;
      for (const chunk of chunks) {
        expect(chunk.domWordOffset).toBeGreaterThan(previousOffset);
        previousOffset = chunk.domWordOffset;
      }
    });

    it('Type 95: Spoken word to DOM word index mapping maps accurately', () => {
      const speech = 'The rapid brown fox leaps over the sleeping dog.';
      const anchorText = 'The rapid brown fox leaps over the sleeping dog.';
      const speechWords = tokenizeSpokenWords(speech);

      for (let i = 0; i < speechWords.length; i += 1) {
        const domIndex = getDomWordIndexForSpeechWord(speech, i, anchorText);
        expect(domIndex).toBe(i);
      }
    });
  });

  describe('Family 8: Adversarial & Edge Cases', () => {
    it('Type 96: Scanned image-only PDF detection throws scanned_pdf_unsupported from generated raster PDF', async () => {
      const bytes = buildPdfBytes([], { isImageOnly: true });
      await expect(extractPdfTextFromData(bytes, { pdfjs })).rejects.toMatchObject({
        code: 'scanned_pdf_unsupported',
      });
    });

    it('Type 97: Vector graphics PDF without selectable text returns empty text without error', async () => {
      const bytes = loadFixturePdfBytes('tests/fixtures/pdfs/image-only/vector-control.pdf');
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.text).toBe('');
    });

    it('Type 98: Blank page PDF returns empty speech and clean model', async () => {
      const bytes = buildPdfBytes([]);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.text).toBe('');
      expect(result.chunks).toHaveLength(0);
    });

    it('Type 99: Oversized single word exceeding maxLen splits on character boundaries', () => {
      const hugeWord = 'A'.repeat(250);
      const chunks = chunkText(hugeWord, 100);
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(100);
      expect(chunks[1].length).toBe(100);
      expect(chunks[2].length).toBe(50);
    });

    it('Type 100: Compact fragment page (<= 5 items) preserves fragment text cleanly from real PDF', async () => {
      const result = await extractFromPdf([
        { text: 'Notice:', x: 54, y: 700, fontSize: 12 },
        { text: 'Maintenance underway.', x: 110, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Notice: Maintenance underway.');
    });
  });
});
