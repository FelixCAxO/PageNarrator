/**
 * Real Wild PDF Fixtures Acceptance Suite
 *
 * Validates PageNarrator's PDF extraction pipeline against 10 deterministic
 * binary PDF fixtures representing pathological, real-world layout and typography artifacts:
 * 1. Spanning Abstracts & 2-Column Body Layouts
 * 2. Fragmented Kerning Streams
 * 3. Typographic Unicode Ligatures
 * 4. Display Equations with Isolated Right Labels
 * 5. Multi-Line Table Cells
 * 6. Cross-Page Column Sentence Continuity
 * 7. Mixed Landscape & Portrait Viewports
 * 8. Superscript Footnotes and Bottom Annotations
 * 9. Quotation Mark Drop Caps
 * 10. OCR Baseline Jitter and Tolerance Bands
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  configurePdfWorker,
  extractPdfTextFromData,
  iteratePdfSpeechChunks,
} from '../../src/lib/pdf-extraction.js';
import {
  WILD_PDF_MANIFEST,
  writeAllWildPdfFixtures,
} from '../helpers/wild-pdf-fixtures-generator.js';

configurePdfWorker(pdfjs);

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/pdfs/wild');

// Ensure fixtures exist on disk
writeAllWildPdfFixtures();

function loadWildFixtureBytes(fileName) {
  const fullPath = path.join(FIXTURES_DIR, fileName);
  return new Uint8Array(readFileSync(fullPath));
}

describe('Real Wild PDF Acceptance Benchmark', () => {
  it('freezes exactly 10 pathological wild PDF fixtures', () => {
    expect(WILD_PDF_MANIFEST).toHaveLength(10);
  });

  describe.each(WILD_PDF_MANIFEST)('$name ($fileName)', (fixture) => {
    it(`extracts natural reading speech and respects layout bounds for ${fixture.name}`, async () => {
      const pdfBytes = loadWildFixtureBytes(fixture.fileName);
      const result = await extractPdfTextFromData(pdfBytes, { pdfjs });

      expect(result.chunks.length).toBeGreaterThan(0);
      const fullSpeech = result.chunks.map((chunk) => chunk.speech).join(' ');

      let lastIndex = -1;
      for (const checkpoint of fixture.expectedCheckpoints) {
        const currentIndex = fullSpeech.indexOf(checkpoint);
        expect(currentIndex, `Missing checkpoint "${checkpoint}" in speech for ${fixture.name}: ${fullSpeech}`).toBeGreaterThanOrEqual(0);
        expect(currentIndex, `Checkpoint out of order "${checkpoint}" in speech for ${fixture.name}`).toBeGreaterThanOrEqual(lastIndex);
        lastIndex = currentIndex;
      }

      for (const forbidden of fixture.forbiddenTokens || []) {
        expect(fullSpeech, `Found forbidden token "${forbidden}" in speech for ${fixture.name}`).not.toContain(forbidden);
      }

      for (const chunk of result.chunks) {
        expect(chunk.anchorId).toBe(`pdf-page-${chunk.pageNumber}`);
        expect(chunk.anchorText.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Wild Cross-Page Streaming Continuity', () => {
    it('seamlessly streams multi-page sentences across page boundaries', async () => {
      const pdfBytes = loadWildFixtureBytes('wild-cross-page-column-wrap.pdf');
      const loadingTask = pdfjs.getDocument({ data: pdfBytes });
      const document = await loadingTask.promise;

      try {
        const chunks = [];
        for await (const chunk of iteratePdfSpeechChunks(document, { maxLen: 400, pdfjs })) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks[0].pageNumber).toBe(1);
        expect(chunks.at(-1).pageNumber).toBe(2);
      } finally {
        await loadingTask.destroy();
      }
    });
  });
});
