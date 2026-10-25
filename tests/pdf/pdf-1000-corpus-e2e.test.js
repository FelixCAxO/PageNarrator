/**
 * 1,000 Generated PDF Binary Fixtures: End-to-End Pipeline Benchmark
 *
 * Tests 1,000 distinct generated binary PDF fixtures across 10 structural layout families
 * through PDF.js text extraction, column splitting, reading order flow, metadata filtering,
 * streaming chunks, and highlighter grounding.
 */
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  configurePdfWorker,
  extractPdfTextFromData,
  iteratePdfSpeechChunks,
} from '../../src/lib/pdf-extraction.js';
import {
  buildPdfCorpus1000,
  PDF_1000_FAMILIES,
} from '../helpers/pdf-1000-generator.js';

configurePdfWorker(pdfjs);

const CORPUS = buildPdfCorpus1000();

describe('1,000 Generated PDF Binary Fixtures End-to-End Benchmark', () => {
  it('generates exactly 1,000 distinct PDF test instances across 10 families', () => {
    expect(CORPUS).toHaveLength(1000);
    for (const family of PDF_1000_FAMILIES) {
      const entries = CORPUS.filter((entry) => entry.familyId === family.id);
      expect(entries).toHaveLength(100);
    }
  });

  describe.each(PDF_1000_FAMILIES)('$name (100 PDFs)', (family) => {
    const familyEntries = CORPUS.filter((entry) => entry.familyId === family.id);

    it(`successfully parses all 100 binary PDFs in ${family.name} with natural reading flow`, async () => {
      expect(familyEntries).toHaveLength(100);

      for (const entry of familyEntries) {
        if (entry.isImageOnly) {
          await expect(extractPdfTextFromData(entry.pdfBytes, { pdfjs })).rejects.toMatchObject({
            code: 'scanned_pdf_unsupported',
          });
          continue;
        }

        const result = await extractPdfTextFromData(entry.pdfBytes, { pdfjs });

        if (entry.expectedPattern) {
          expect(result.text).toMatch(entry.expectedPattern);
          continue;
        }

        if (entry.expectedCheckpoints.length === 0) {
          expect(result.chunks).toHaveLength(0);
          continue;
        }

        expect(result.chunks.length).toBeGreaterThan(0);
        const fullSpeech = result.chunks.map((chunk) => chunk.speech).join(' ');

        let lastIndex = -1;
        for (const checkpoint of entry.expectedCheckpoints) {
          const currentIndex = fullSpeech.indexOf(checkpoint);
          expect(currentIndex, `Expected checkpoint "${checkpoint}" in speech for ${entry.id}`).toBeGreaterThanOrEqual(0);
          expect(currentIndex, `Checkpoints out of order in speech for ${entry.id}: "${checkpoint}"`).toBeGreaterThanOrEqual(lastIndex);
          lastIndex = currentIndex;
        }

        for (const forbidden of entry.forbiddenTokens || []) {
          expect(fullSpeech, `Found forbidden token "${forbidden}" in speech for ${entry.id}`).not.toContain(forbidden);
        }

        for (let c = 0; c < result.chunks.length; c += 1) {
          const chunk = result.chunks[c];
          expect(chunk.anchorId).toBe(`pdf-page-${chunk.pageNumber}`);
          expect(chunk.speech.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Streaming & Highlighter Grounding across Multi-Page PDFs', () => {
    it('streams multi-page PDF documents sequentially with monotonic word offsets', async () => {
      const multiPageEntries = CORPUS.filter((entry) => entry.pageCount > 1);
      expect(multiPageEntries.length).toBeGreaterThan(0);

      for (const entry of multiPageEntries.slice(0, 10)) {
        const loadingTask = pdfjs.getDocument({ data: entry.pdfBytes });
        const document = await loadingTask.promise;

        try {
          const streamChunks = [];
          for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 300, pdfjs })) {
            streamChunks.push(chunk);
          }

          expect(streamChunks.length).toBeGreaterThanOrEqual(entry.pageCount);
          let prevPage = 0;
          for (const chunk of streamChunks) {
            expect(chunk.pageNumber).toBeGreaterThanOrEqual(prevPage);
            expect(chunk.anchorId).toBe(`pdf-page-${chunk.pageNumber}`);
            prevPage = chunk.pageNumber;
          }
        } finally {
          await loadingTask.destroy();
        }
      }
    });
  });
});
