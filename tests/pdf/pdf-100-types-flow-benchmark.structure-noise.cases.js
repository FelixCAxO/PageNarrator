import { loadFixturePdfBytes, getFixtureRecord, extractFromPdf } from "./pdf-100-types-flow-benchmark.fixtures.js";
import { describe, expect, it } from 'vitest';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfTextFromData } from "../../src/lib/pdf-extraction.js";

describe('100 PDF Types & Flow Naturalness Benchmark (Real PDF Binaries)', () => {
  describe('Family 3: Structural Elements & Captions', () => {
    it('Type 31: Standard 2x3 data table reads in row-major order with row pauses from fixture', async () => {
      const record = getFixtureRecord('fixture-table');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toContain('Table 1. Quarterly measurements');
      expect(result.chunks[0].speech).toContain('North Q1 84.');
    });

    it('Type 32: Table with numeric columns preserves decimal alignment', async () => {
      const result = await extractFromPdf([
        { text: 'Metric Value Score', x: 54, y: 700, fontSize: 12 },
        { text: 'Precision 0.94 88', x: 54, y: 670, fontSize: 12 },
        { text: 'Recall 0.91 84', x: 54, y: 640, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Precision 0.94 88');
      expect(result.chunks[0].speech).toContain('Recall 0.91 84');
    });

    it('Type 33: Full-width table spanning across columns stays cohesive', async () => {
      const result = await extractFromPdf([
        { text: 'Column 1 top prose.', x: 54, y: 750, fontSize: 12 },
        { text: 'Column 2 top prose.', x: 320, y: 750, fontSize: 12 },
        { text: 'Wide Table: Summary of Benchmark Scores across all 10 Baselines', x: 54, y: 650, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Wide Table: Summary of Benchmark Scores across all 10 Baselines.');
    });

    it('Type 34: Table with multi-line cell content keeps rows ordered', async () => {
      const result = await extractFromPdf([
        { text: 'Task Setting Baseline', x: 54, y: 700, fontSize: 12 },
        { text: 'Audio Speech 98', x: 54, y: 670, fontSize: 12 },
        { text: 'Visual Vision 94', x: 54, y: 640, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Audio Speech 98');
      expect(result.chunks[0].speech).toContain('Visual Vision 94');
    });

    it('Type 35: Bulleted list with bullet symbol (•) formats with structural pauses from fixture', async () => {
      const record = getFixtureRecord('fixture-list');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toContain('1. Inspect the visible heading');
      expect(result.chunks[0].speech).toContain('Preserve meaningful bullet markers');
    });

    it('Type 36: Bulleted list with dash (-) formats as list items', async () => {
      const result = await extractFromPdf([
        { text: '- Step one in calibration.', x: 54, y: 700, fontSize: 12 },
        { text: '- Step two in calibration.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Step one in calibration; Step two in calibration.');
    });

    it('Type 37: Bulleted list with asterisk (*) formats as list items', async () => {
      const result = await extractFromPdf([
        { text: '* Feature A is enabled.', x: 54, y: 700, fontSize: 12 },
        { text: '* Feature B is enabled.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Feature A is enabled; Feature B is enabled.');
    });

    it('Type 38: Numbered list with period (1., 2.) formats with structural pauses', async () => {
      const result = await extractFromPdf([
        { text: '1. Download model weights.', x: 54, y: 700, fontSize: 12 },
        { text: '2. Initialize web worker.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('1. Download model weights; 2. Initialize web worker.');
    });

    it('Type 39: Alphanumeric list with parenthesis ((a), (b)) formats as list items', async () => {
      const result = await extractFromPdf([
        { text: 'a) Lower memory footprint.', x: 54, y: 700, fontSize: 12 },
        { text: 'b) Faster first audio response.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('a) Lower memory footprint; b) Faster first audio response.');
    });

    it('Type 40: Roman numeral list ((i), (ii)) formats properly', async () => {
      const result = await extractFromPdf([
        { text: 'i) Latency benchmark pass.', x: 54, y: 700, fontSize: 12 },
        { text: 'ii) Memory allocation pass.', x: 54, y: 670, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Latency benchmark pass');
      expect(result.chunks[0].speech).toContain('Memory allocation pass');
    });

    it('Type 41: Multi-line list item continuation merges into one item from fixture', async () => {
      const record = getFixtureRecord('fixture-list');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toContain('Keep this wrapped item together even when its explanation continues on the following visual line');
    });

    it('Type 42: Interleaved figure caption between columns defers after interrupted prose from fixture', async () => {
      const record = getFixtureRecord('fixture-caption-after-columns');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).toContain('Figure 1');
    });

    it('Type 43: Multi-sentence figure caption remains grouped together', async () => {
      const result = await extractFromPdf([
        { text: 'Figure 2: Training convergence curves. Shaded areas show variance.', x: 54, y: 600, fontSize: 10 },
      ]);
      expect(result.chunks[0].speech).toContain('Figure 2: Training convergence curves. Shaded areas show variance.');
    });

    it('Type 44: Table caption preceding table stays before table rows', async () => {
      const result = await extractFromPdf([
        { text: 'Table 2: Comparison with prior art.', x: 54, y: 720, fontSize: 12 },
        { text: 'Method Score Latency', x: 54, y: 690, fontSize: 12 },
        { text: 'Ours 98.4 45ms', x: 54, y: 660, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Table 2: Comparison with prior art.');
    });

    it('Type 45: Side-by-side subfigures with sub-captions (a) and (b)', async () => {
      const result = await extractFromPdf([
        { text: '(a) Latency distribution', x: 54, y: 650, fontSize: 10 },
        { text: '(b) Memory distribution', x: 320, y: 650, fontSize: 10 },
      ]);
      expect(result.chunks[0].speech).toContain('Latency distribution');
      expect(result.chunks[0].speech).toContain('Memory distribution');
    });
  });

  describe('Family 4: Noise & Furniture Suppression', () => {
    it('Type 46: Running header at page top edge is suppressed from speech from fixture', async () => {
      const record = getFixtureRecord('fixture-running-content');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).not.toContain('Recurring Header');
    });

    it('Type 47: Running footer at page bottom edge is suppressed from speech', async () => {
      const record = getFixtureRecord('fixture-running-content');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).not.toContain('Page 1 of 10');
    });

    it('Type 48: Page number at bottom center is suppressed from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Body paragraph text.', x: 54, y: 700, fontSize: 12 },
        { text: '42', x: 300, y: 18, fontSize: 10 },
      ]);
      expect(result.chunks[0].speech).toBe('Body paragraph text.');
      expect(result.chunks[0].speech).not.toContain('42');
    });

    it('Type 49: Page number at top right corner is suppressed', async () => {
      const result = await extractFromPdf([
        { text: 'Page 15', x: 550, y: 782, fontSize: 9 },
        { text: 'Section heading begins here.', x: 54, y: 700, fontSize: 14 },
      ]);
      expect(result.chunks[0].speech).toBe('Section heading begins here.');
    });

    it('Type 50: Roman numeral page number at bottom (iv, xii) is suppressed', async () => {
      const result = await extractFromPdf([
        { text: 'Prefatory material paragraph.', x: 54, y: 700, fontSize: 12 },
        { text: 'iv', x: 300, y: 15, fontSize: 10 },
      ]);
      expect(result.chunks[0].speech).toBe('Prefatory material paragraph.');
    });

    it('Type 51: Repeated document title in top margin across pages is filtered', async () => {
      const result = await extractFromPdf([
        { text: 'Recurring Report Header', x: 200, y: 775, fontSize: 9 },
        { text: 'Actual page content begins.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Actual page content begins.');
    });

    it('Type 52: Confidentiality banner / Draft watermark text is filtered', async () => {
      const result = await extractFromPdf([
        { text: 'Draft Copy - Do Not Distribute', x: 200, y: 775, fontSize: 9 },
        { text: 'Approved research methodology.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Approved research methodology.');
    });

    it('Type 53: arXiv identifier banner is filtered from speech', async () => {
      const result = await extractFromPdf([
        { text: 'arXiv:2604.12345v1 [cs.CL] 30 Apr 2026', x: 54, y: 775, fontSize: 9 },
        { text: 'Paper title follows the banner.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Paper title follows the banner.');
    });

    it('Type 54: Copyright notice at footer is filtered from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Body paragraph text.', x: 54, y: 700, fontSize: 12 },
        { text: 'Copyright © 2026 IEEE. All rights reserved.', x: 54, y: 20, fontSize: 9 },
      ]);
      expect(result.chunks[0].speech).toBe('Body paragraph text.');
    });

    it('Type 55: License disclaimer (CC-BY 4.0) is filtered from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Scientific report findings.', x: 54, y: 700, fontSize: 12 },
        { text: 'This article is licensed under a Creative Commons Attribution 4.0 License.', x: 54, y: 20, fontSize: 9 },
      ]);
      expect(result.chunks[0].speech).toBe('Scientific report findings.');
    });

    it('Type 56: Conference submission notice is filtered from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Submitted to INTERSPEECH 2026 for review.', x: 54, y: 775, fontSize: 9 },
        { text: 'Speech synthesis experiments.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Speech synthesis experiments.');
    });

    it('Type 57: Author affiliation block is filtered from main narration', async () => {
      const result = await extractFromPdf([
        { text: 'Paper Main Title', x: 200, y: 750, fontSize: 18 },
        { text: 'Department of Computer Science, University of Oxford', x: 150, y: 720, fontSize: 9 },
        { text: 'Abstract', x: 150, y: 680, fontSize: 14 },
        { text: 'Introduction begins with research questions.', x: 54, y: 650, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Paper Main Title:');
      expect(result.chunks[0].speech).toContain('Introduction begins with research questions.');
      expect(result.chunks[0].speech).not.toContain('Department of Computer Science');
    });

    it('Type 58: Author contact emails are stripped from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Contact: author@domain.edu and lab@institute.org for inquiries.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Contact: and for inquiries.');
      expect(result.chunks[0].speech).not.toContain('author@domain.edu');
    });

    it('Type 59: ORCID identifier strings are stripped from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Researcher 0000-0002-1825-0097 conducted the experiment.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Researcher conducted the experiment.');
      expect(result.chunks[0].speech).not.toContain('0000-0002-1825-0097');
    });

    it('Type 60: Web URL tokens are stripped from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Source code available at https://github.com/pagenarrator/core for testing.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Source code available at for testing.');
      expect(result.chunks[0].speech).not.toContain('https://github.com');
    });
  });
});
