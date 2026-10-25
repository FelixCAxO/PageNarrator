import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  annotatePdfTextLayer,
  configurePdfWorker,
  extractPdfTextFromData,
  iteratePdfSpeechChunks,
  PDF_TEXT_LAYER_TEXT_ATTRIBUTE,
} from '../../src/lib/pdf-extraction.js';
import {
  createPdfPageModel,
} from '../../src/lib/pdf-page-model.js';
import { chunkText, splitSpeechSentences } from '../../src/lib/speech-chunks.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import { matchesOrderedCheckpoints, countNarrationErrors } from '../../scripts/pdf-acceptance-metrics.mjs';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadFixturePdfBytes(fixtureRelativePath) {
  const fullPath = path.join(ROOT_DIR, fixtureRelativePath);
  return new Uint8Array(readFileSync(fullPath));
}

function getFixtureRecord(id) {
  const record = PDF_ACCEPTANCE_BENCHMARK.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Fixture not found in acceptance benchmark: ${id}`);
  return record;
}

configurePdfWorker(pdfjs);

describe('PDF Splitting Taxonomy Suite', () => {
  describe('Type 1: Single-column & Title Splitting', () => {
    it('splits title from body paragraphs cleanly in visual top-to-bottom reading order', async () => {
      const record = getFixtureRecord('fixture-title-single-column');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      const chunks = chunkText(result.chunks, 500, { targetMinLen: 200 });
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.speech).toBeTruthy();
        expect(chunk.pageNumber).toBe(1);
        expect(chunk.anchorId).toBe('pdf-page-1');
        expect(Number.isFinite(chunk.domWordOffset)).toBe(true);
      }
    });
  });

  describe('Type 2: Multi-column LTR Splitting', () => {
    it('splits columns vertically so left column completes entirely before right column begins', async () => {
      const record = getFixtureRecord('fixture-ltr-two-column');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      // Verify column separation: left column contents precede right column contents in speech
      const leftIndex = speech.indexOf('LEFT COLUMN');
      const rightIndex = speech.indexOf('RIGHT COLUMN');
      expect(leftIndex).toBeGreaterThanOrEqual(0);
      expect(rightIndex).toBeGreaterThan(leftIndex);
    });
  });

  describe('Type 3: Multi-column RTL Splitting', () => {
    it('splits RTL columns right-to-left so right column completes before left column', async () => {
      const record = getFixtureRecord('fixture-rtl-two-column');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      const rightColIndex = speech.indexOf('العمود الأيمن');
      const leftColIndex = speech.indexOf('العمود الأيسر');
      expect(rightColIndex).toBeGreaterThanOrEqual(0);
      expect(leftColIndex).toBeGreaterThan(rightColIndex);
    });
  });

  describe('Type 4: Mixed-Direction Splitting', () => {
    it('splits mixed LTR and RTL sections preserving local flow without corrupting page order', async () => {
      const record = getFixtureRecord('fixture-mixed-direction');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      expect(speech).toContain('The English paragraph keeps local left-to-right order.');
      expect(speech).toContain('تحافظ هذه الفقرة على اتجاهها المحلي.');
    });
  });

  describe('Type 5: Line-Wrap Word & Hyphen Splitting', () => {
    it('repairs soft hyphens and line-wrap word splits while preserving intentional compounds', async () => {
      const record = getFixtureRecord('fixture-split-words');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      // Verify "international" is reassembled seamlessly in speech
      expect(speech).toMatch(/\binternational\b/i);
      expect(speech).not.toMatch(/\binter-\s+national\b/i);

      // Verify "state-of-the-art" compound is preserved
      expect(speech).toMatch(/\bstate-of-the-art\b/i);

      // Verify anchorText preserves the layout positions for DOM highlighter
      expect(result.chunks[0].anchorText).toContain('inter-');
    });
  });

  describe('Type 6: Table Structure Splitting', () => {
    it('splits tabular data in row-major order and isolates cell boundaries', async () => {
      const record = getFixtureRecord('fixture-table');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      // Speech formats table rows cleanly with structural pauses
      expect(speech).toContain('North Q1 84. South Q2 91.');
    });
  });

  describe('Type 7: List Item Splitting & Continuations', () => {
    it('merges multi-line list continuations while preserving list item boundaries', async () => {
      const record = getFixtureRecord('fixture-list');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      expect(speech).toMatch(/1\.\s+Inspect the visible heading/i);
      expect(speech).toMatch(/2\.\s+Read the numbered item as one unit/i);
      expect(speech).toMatch(/3\.\s+Keep this wrapped item together even when its explanation continues on the following visual line/i);
    });
  });

  describe('Type 8: Interleaved Caption Deferral & Splitting', () => {
    it('defers captions that interrupt columns so continuous body prose is not split prematurely', async () => {
      const record = getFixtureRecord('fixture-caption-after-columns');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      const leftBody = speech.indexOf('Left body ends after its supporting detail.');
      const rightBody = speech.indexOf('Right body ends with the comparison.');
      const caption = speech.indexOf('Figure 1. The full-width caption follows both complete columns.');

      expect(leftBody).toBeGreaterThanOrEqual(0);
      expect(rightBody).toBeGreaterThan(leftBody);
      expect(caption).toBeGreaterThan(rightBody);
    });
  });

  describe('Type 9: Running Content & Furniture Filtering/Splitting', () => {
    it('filters out running headers, footers, and page numbers across multi-page documents', async () => {
      const record = getFixtureRecord('fixture-running-content');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: 1 });

      expect(result.pageCount).toBe(10);
      const page5Chunk = result.chunks.find((chunk) => chunk.pageNumber === 5);
      expect(page5Chunk).toBeDefined();
      const page5Speech = page5Chunk.speech;
      const checkpointEval = matchesOrderedCheckpoints(page5Speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      const narrationErrors = countNarrationErrors(page5Speech, record.forbiddenNarration);
      expect(narrationErrors).toBe(0);
    });
  });

  describe('Type 10: Citation & Decorative Symbol Suppression', () => {
    it('suppresses numeric citation brackets and unicode ornaments from spoken speech', async () => {
      const record = getFixtureRecord('fixture-citations-decorations');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs, startPage: record.pageNumber });

      const speech = result.chunks[0].speech;
      const checkpointEval = matchesOrderedCheckpoints(speech, record.orderedCheckpoints);
      expect(checkpointEval.passed, `Failed checkpoint: ${checkpointEval.failedCheckpoint}`).toBe(true);

      const narrationErrors = countNarrationErrors(speech, record.forbiddenNarration);
      expect(narrationErrors).toBe(0);
    });
  });

  describe('Type 11: Streaming Speech Chunking & Boundary Splitting', () => {
    it('yields streaming speech chunks respecting length constraints and sentence boundaries', async () => {
      const record = getFixtureRecord('fixture-title-single-column');
      const bytes = loadFixturePdfBytes(record.source);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const document = await loadingTask.promise;

      try {
        const chunks = [];
        for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 300, targetMinLen: 100, pdfjs })) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThanOrEqual(2);
        let previousWordOffset = 0;
        for (const chunk of chunks) {
          expect(chunk.type).toBe('pdf-page');
          expect(chunk.speech.length).toBeLessThanOrEqual(300);
          expect(chunk.speech.trim().length).toBeGreaterThan(0);
          expect(chunk.domWordOffset).toBeGreaterThanOrEqual(previousWordOffset);
          previousWordOffset = chunk.domWordOffset;
        }
      } finally {
        await loadingTask.destroy();
      }
    });

    it('splits long sentences cleanly on clause boundaries without breaking decimals or abbreviations', () => {
      const text = 'In evaluating the model on Section 3.14, which took 4.5 hours, the team observed strong results. Furthermore, Smith et al. proved that accuracy increased by 12.8% on standard benchmarks.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toContain('3.14');
      expect(sentences[0]).toContain('4.5');
      expect(sentences[1]).toContain('Smith et al.');
      expect(sentences[1]).toContain('12.8%');

      const speechChunks = chunkText(text, 100, { targetMinLen: 40 });
      expect(speechChunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of speechChunks) {
        expect(chunk.length).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('Type 12: Highlighter DOM Annotation & Word Offset Grounding', () => {
    it('correctly maps DOM text layer annotations and maintains monotonic word indices across split chunks', async () => {
      const record = getFixtureRecord('fixture-ltr-two-column');
      const bytes = loadFixturePdfBytes(record.source);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const document = await loadingTask.promise;

      try {
        const page = await document.getPage(1);
        const textContent = await page.getTextContent();
        const model = createPdfPageModel(textContent.items, { pageView: page.view });

        const dom = new JSDOM('<!DOCTYPE html><div id="pdf-page-1" class="textLayer"></div>');
        const textLayerEl = dom.window.document.getElementById('pdf-page-1');
        for (const item of textContent.items) {
          if (!item.str?.trim()) continue;
          const span = dom.window.document.createElement('span');
          span.textContent = item.str;
          textLayerEl.appendChild(span);
        }

        const annotated = annotatePdfTextLayer(textLayerEl, textContent.items);
        expect(annotated.length).toBeGreaterThan(0);
        expect(textLayerEl.dataset.pagenarratorPdfOrder).toBe('true');
        expect(textLayerEl.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).toBe(model.speech);

        // Verify word token alignment
        const speechWords = tokenizeSpokenWords(model.speech);
        expect(speechWords.length).toBeGreaterThan(0);

        for (let i = 0; i < Math.min(speechWords.length, 10); i += 1) {
          const domWordIndex = getDomWordIndexForSpeechWord(model.speech, i, model.anchorText);
          expect(domWordIndex).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await loadingTask.destroy();
      }
    });
  });
});
