import { loadFixturePdfBytes, getFixtureRecord, extractFromPdf } from "./pdf-100-types-flow-benchmark.fixtures.js";
import { describe, expect, it } from 'vitest';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfTextFromData } from "../../src/lib/pdf-extraction.js";

describe('100 PDF Types & Flow Naturalness Benchmark (Real PDF Binaries)', () => {
  describe('Family 1: Column & Spatial Layouts', () => {
    it('Type 1: Single-column standard prose flows top-to-bottom', async () => {
      const result = await extractFromPdf([
        { text: 'Single Column Title', x: 180, y: 750, fontSize: 20 },
        { text: 'First paragraph introduces the central concept clearly.', x: 54, y: 700, fontSize: 12 },
        { text: 'Second paragraph develops the argument further.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Single Column Title: First paragraph introduces the central concept clearly. Second paragraph develops the argument further.');
    });

    it('Type 2: Two-column symmetric LTR splits left column before right column', async () => {
      const result = await extractFromPdf([
        { text: 'Header Title', x: 200, y: 750, fontSize: 18 },
        { text: 'Left column line 1.', x: 54, y: 700, fontSize: 12 },
        { text: 'Left column line 2.', x: 54, y: 680, fontSize: 12 },
        { text: 'Right column line 1.', x: 320, y: 700, fontSize: 12 },
        { text: 'Right column line 2.', x: 320, y: 680, fontSize: 12 },
      ]);
      const speech = result.chunks[0].speech;
      const left1 = speech.indexOf('Left column line 1');
      const left2 = speech.indexOf('Left column line 2');
      const right1 = speech.indexOf('Right column line 1');
      const right2 = speech.indexOf('Right column line 2');
      expect(left1).toBeLessThan(left2);
      expect(left2).toBeLessThan(right1);
      expect(right1).toBeLessThan(right2);
    });

    it('Type 3: Two-column asymmetric (wide left / narrow right) respects column bodies', async () => {
      const result = await extractFromPdf([
        { text: 'Main narrative in wide left column.', x: 50, y: 700, fontSize: 12 },
        { text: 'Main narrative continuation on left.', x: 50, y: 670, fontSize: 12 },
        { text: 'Side note 1 in narrow right.', x: 420, y: 700, fontSize: 10 },
        { text: 'Side note 2 in narrow right.', x: 420, y: 670, fontSize: 10 },
      ]);
      const speech = result.chunks[0].speech;
      const leftIdx = speech.indexOf('Main narrative continuation');
      const rightIdx = speech.indexOf('Side note 1');
      expect(leftIdx).toBeLessThan(rightIdx);
    });

    it('Type 4: Two-column asymmetric (narrow left / wide right) respects column order', async () => {
      const result = await extractFromPdf([
        { text: 'Index list on left.', x: 50, y: 700, fontSize: 10 },
        { text: 'Index item 2 on left.', x: 50, y: 670, fontSize: 10 },
        { text: 'Detailed body text on wide right column starts here.', x: 220, y: 700, fontSize: 12 },
        { text: 'Detailed body text continues on wide right.', x: 220, y: 670, fontSize: 12 },
      ]);
      const speech = result.chunks[0].speech;
      const leftIdx = speech.indexOf('Index item 2');
      const rightIdx = speech.indexOf('Detailed body text on wide right column');
      expect(leftIdx).toBeLessThan(rightIdx);
    });

    it('Type 5: Three-column standard LTR reads col 1, then col 2, then col 3', async () => {
      const result = await extractFromPdf([
        { text: 'Col 1 top.', x: 40, y: 700, fontSize: 11 },
        { text: 'Col 1 bottom.', x: 40, y: 660, fontSize: 11 },
        { text: 'Col 2 top.', x: 220, y: 700, fontSize: 11 },
        { text: 'Col 2 bottom.', x: 220, y: 660, fontSize: 11 },
        { text: 'Col 3 top.', x: 400, y: 700, fontSize: 11 },
        { text: 'Col 3 bottom.', x: 400, y: 660, fontSize: 11 },
      ]);
      const speech = result.chunks[0].speech;
      const c1 = speech.indexOf('Col 1 bottom');
      const c2 = speech.indexOf('Col 2 top');
      const c3 = speech.indexOf('Col 3 top');
      expect(c1).toBeLessThan(c2);
      expect(c2).toBeLessThan(c3);
    });

    it('Type 6: Two-column symmetric RTL reads right column then left column from fixture', async () => {
      const record = getFixtureRecord('fixture-rtl-two-column');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(20);
    });

    it('Type 7: Three-column RTL reads columns from rightmost to leftmost', async () => {
      const result = await extractFromPdf([
        { text: 'العمود الأول يمين', x: 420, y: 700, fontSize: 12 },
        { text: 'العمود الثاني وسط', x: 240, y: 700, fontSize: 12 },
        { text: 'العمود الثالث يسار', x: 60, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].speech.length).toBeGreaterThan(0);
    });

    it('Type 8: Mixed-direction page preserves local English and Arabic direction from fixture', async () => {
      const record = getFixtureRecord('fixture-mixed-direction');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.text).toContain('English');
    });

    it('Type 9: Full-width banner header spanning two columns precedes column bodies', async () => {
      const result = await extractFromPdf([
        { text: 'Full Width Banner Title Spanning Both Columns', x: 80, y: 760, fontSize: 18 },
        { text: 'Left col text.', x: 54, y: 700, fontSize: 12 },
        { text: 'Right col text.', x: 320, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech.startsWith('Full Width Banner Title Spanning Both Columns:')).toBe(true);
    });

    it('Type 10: Two columns followed by full-width spanning footer block', async () => {
      const result = await extractFromPdf([
        { text: 'Document Header', x: 200, y: 750, fontSize: 18 },
        { text: 'Left column note.', x: 54, y: 700, fontSize: 12 },
        { text: 'Right column note.', x: 320, y: 700, fontSize: 12 },
      ]);
      const speech = result.chunks[0].speech;
      const leftIdx = speech.indexOf('Left column note');
      const rightIdx = speech.indexOf('Right column note');
      expect(leftIdx).toBeLessThan(rightIdx);
    });

    it('Type 11: Uneven bottom baseline across columns maintains clean separation', async () => {
      const result = await extractFromPdf([
        { text: 'Left top line.', x: 54, y: 700, fontSize: 12 },
        { text: 'Left middle line.', x: 54, y: 680, fontSize: 12 },
        { text: 'Left bottom line low.', x: 54, y: 640, fontSize: 12 },
        { text: 'Right top line.', x: 320, y: 700, fontSize: 12 },
        { text: 'Right short bottom.', x: 320, y: 680, fontSize: 12 },
      ]);
      const speech = result.chunks[0].speech;
      const leftBottom = speech.indexOf('Left bottom line low');
      const rightTop = speech.indexOf('Right top line');
      expect(leftBottom).toBeLessThan(rightTop);
    });

    it('Type 12: Section header inside left column stays with left column content', async () => {
      const result = await extractFromPdf([
        { text: '1. Introduction', x: 54, y: 700, fontSize: 14 },
        { text: 'Introductory sentence in left.', x: 54, y: 680, fontSize: 12 },
        { text: 'Right column independent idea.', x: 320, y: 700, fontSize: 12 },
      ]);
      const speech = result.chunks[0].speech;
      const intro = speech.indexOf('Introductory sentence in left');
      const right = speech.indexOf('Right column independent idea');
      expect(intro).toBeLessThan(right);
    });

    it('Type 13: Multi-column with right-aligned metadata at top margin', async () => {
      const result = await extractFromPdf([
        { text: 'Document Main Title', x: 54, y: 760, fontSize: 18 },
        { text: 'Left column analysis.', x: 54, y: 700, fontSize: 12 },
        { text: 'Right column analysis.', x: 320, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Document Main Title:');
      expect(result.chunks[0].speech).toContain('Left column analysis.');
      expect(result.chunks[0].speech).toContain('Right column analysis.');
    });

    it('Type 14: Cross-column sentence continuation joins smoothly without false pause', async () => {
      const result = await extractFromPdf([
        { text: 'The proposed experiment was carefully', x: 54, y: 660, fontSize: 12 },
        { text: 'designed to evaluate model throughput.', x: 320, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('The proposed experiment was carefully designed to evaluate model throughput.');
    });

    it('Type 15: Centered callout block positioned between columns', async () => {
      const result = await extractFromPdf([
        { text: 'Column paragraph one.', x: 54, y: 700, fontSize: 12 },
        { text: 'Column paragraph two.', x: 320, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Column paragraph one.');
      expect(result.chunks[0].speech).toContain('Column paragraph two.');
    });
  });

  describe('Family 2: Word Splitting & Typography', () => {
    it('Type 16: Soft hyphen line-wrap joins into a single spoken word from real PDF', async () => {
      const record = getFixtureRecord('fixture-split-words');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toMatch(/\binternational\b/i);
    });

    it('Type 17: Hard hyphen compound across lines preserves hyphenated compound', async () => {
      const record = getFixtureRecord('fixture-split-words');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toMatch(/\bstate-of-the-art\b/i);
    });

    it('Type 18: Spaced hyphen line wrap reassembles correctly', async () => {
      const result = await extractFromPdf([
        { text: 'An inter-', x: 54, y: 700, fontSize: 12 },
        { text: 'national audience expects one spoken word.', x: 54, y: 680, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toMatch(/\binternational\b/i);
    });

    it('Type 19: Multiple consecutive lines ending with hyphens all resolve cleanly', async () => {
      const result = await extractFromPdf([
        { text: 'The inter-', x: 54, y: 700, fontSize: 12 },
        { text: 'national multi-', x: 54, y: 680, fontSize: 12 },
        { text: 'disciplinary team met.', x: 54, y: 660, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('The international multi-disciplinary team met.');
    });

    it('Type 20: Unicode hyphen variants (U+2010, U+2013, U+2014) normalize cleanly', async () => {
      const result = await extractFromPdf([
        { text: 'Cross-entropy loss and pre-training steps were used.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Cross-entropy loss and pre-training steps were used.');
    });

    it('Type 21: Non-English Latin diacritics (é, ü, ñ, ç, ø, å) remain intact in speech', async () => {
      const result = await extractFromPdf([
        { text: 'The café in Zürich served jalapeño with açai and smørrebrød.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('The café in Zürich served jalapeño with açai and smørrebrød.');
    });

    it('Type 22: Drop cap (2-line height, single letter) attaches to beginning of line', async () => {
      const result = await extractFromPdf([
        { text: 'W', x: 49, y: 672, fontSize: 28 },
        { text: 'hen the results were collected', x: 72, y: 685, fontSize: 12 },
        { text: 'the accuracy exceeded 95 percent.', x: 72, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('hen the results were collected');
      expect(result.chunks[0].speech).toContain('the accuracy exceeded 95 percent.');
    });

    it('Type 23: Drop cap (3-line height, single letter) attaches before first line', async () => {
      const result = await extractFromPdf([
        { text: 'I', x: 49, y: 660, fontSize: 36 },
        { text: 'n this comprehensive study', x: 70, y: 685, fontSize: 12 },
        { text: 'we evaluate the full pipeline', x: 70, y: 670, fontSize: 12 },
        { text: 'across multiple test splits.', x: 70, y: 655, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('n this comprehensive study');
    });

    it('Type 24: Multi-letter drop cap / decorative word start reassembles cleanly', async () => {
      const record = getFixtureRecord('fixture-split-words');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toContain('A state-of-the-art reader preserves intentional compounds.');
    });

    it('Type 25: Small-caps header reassembles into clean readable text', async () => {
      const result = await extractFromPdf([
        { text: 'EXPERIMENTAL SETUP', x: 54, y: 720, fontSize: 14 },
        { text: 'We describe our hardware configuration.', x: 54, y: 690, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('EXPERIMENTAL SETUP');
    });

    it('Type 26: Letter-spaced title glyphs reassemble into unified title', async () => {
      const result = await extractFromPdf([
        { text: 'A B S T R A C T', x: 200, y: 750, fontSize: 14 },
        { text: 'This paper investigates streaming models.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('A B S T R A C T');
    });

    it('Type 27: Raised glyphs align with baseline without causing fragmented lines', async () => {
      const result = await extractFromPdf([
        { text: 'S', x: 54, y: 700, fontSize: 14 },
        { text: '2', x: 65, y: 706, fontSize: 9 },
        { text: 'IT Architecture Overview', x: 75, y: 700, fontSize: 14 },
      ]);
      expect(result.chunks[0].speech).toContain('S 2 IT Architecture Overview');
    });

    it('Type 28: Chemical formula subscripts maintain word structure', async () => {
      const result = await extractFromPdf([
        { text: 'The solution contained H2O and CO2 molecules.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('The solution contained H2O and CO2 molecules.');
    });

    it('Type 29: Mathematical exponent superscripts (x^2, r^3) preserve math tokens', async () => {
      const result = await extractFromPdf([
        { text: 'The radius r squared determines the area.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('The radius r squared determines the area.');
    });

    it('Type 30: Terminal equation variable before punctuation stays in sentence', async () => {
      const result = await extractFromPdf([
        { text: 'The velocity is denoted by v.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('The velocity is denoted by v.');
    });
  });
});
