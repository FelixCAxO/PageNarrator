import { loadFixturePdfBytes, getFixtureRecord, extractFromPdf } from "./pdf-100-types-flow-benchmark.fixtures.js";
import { describe, expect, it } from 'vitest';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfTextFromData } from "../../src/lib/pdf-extraction.js";
import { chunkText, splitSpeechSentences } from '../../src/lib/speech-chunks.js';

describe('100 PDF Types & Flow Naturalness Benchmark (Real PDF Binaries)', () => {
  describe('Family 5: Academic Citations & Metadata', () => {
    it('Type 61: Single numeric citation bracket [1] is stripped from speech from fixture', async () => {
      const record = getFixtureRecord('fixture-citations-decorations');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).not.toContain('[1]');
    });

    it('Type 62: Multi-bracket citation [1, 2, 3] is stripped from speech from fixture', async () => {
      const record = getFixtureRecord('fixture-citations-decorations');
      const bytes = loadFixturePdfBytes(record.source);
      const result = await extractPdfTextFromData(bytes, { pdfjs });
      expect(result.chunks[0].speech).not.toContain('[1, 2, 3]');
    });

    it('Type 63: Numeric citation range [1-5] is stripped from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Several studies [1-5] verified these findings.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Several studies verified these findings.');
    });

    it('Type 64: Author-year in-text citation (Smith et al., 2024) is stripped', async () => {
      const result = await extractFromPdf([
        { text: 'As demonstrated in (Smith et al., 2024), latency remains key.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('As demonstrated in, latency remains key.');
    });

    it('Type 65: Bare author-year citation is stripped from speech', async () => {
      const result = await extractFromPdf([
        { text: 'Following Vaswani et al., 2017 we use self-attention.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Following we use self-attention.');
    });

    it('Type 66: Parenthetical year citation Smith et al. (2024) is handled cleanly', async () => {
      const result = await extractFromPdf([
        { text: 'Smith et al. (2024) presented a lightweight streaming reader.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('presented a lightweight streaming reader.');
    });

    it('Type 67: Multi-author citation (Bengio and LeCun, 2020) is stripped', async () => {
      const result = await extractFromPdf([
        { text: 'Deep architectures (Bengio and LeCun, 2020) scale efficiently.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Deep architectures scale efficiently.');
    });

    it('Type 68: Month-year publication date is preserved in speech', async () => {
      const result = await extractFromPdf([
        { text: 'The benchmark was conducted in January 2025.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('The benchmark was conducted in January 2025.');
    });

    it('Type 69: Section heading with numbering (1. Introduction) is formatted with colon pause', async () => {
      const result = await extractFromPdf([
        { text: '1. Introduction', x: 54, y: 750, fontSize: 16 },
        { text: 'Automatic speech recognition is vital.', x: 54, y: 710, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('1. Introduction');
      expect(result.chunks[0].speech).toContain('Automatic speech recognition is vital.');
    });

    it('Type 70: Deep subsection heading (3.2.1 Data Collection Protocol) is preserved', async () => {
      const result = await extractFromPdf([
        { text: '3.2.1 Data Collection Protocol', x: 54, y: 750, fontSize: 14 },
        { text: 'Audio recordings were sampled at 24kHz.', x: 54, y: 710, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('3.2.1 Data Collection Protocol');
      expect(result.chunks[0].speech).toContain('Audio recordings were sampled at 24kHz.');
    });

    it('Type 71: Abstract heading and block formats cleanly', async () => {
      const result = await extractFromPdf([
        { text: 'Abstract', x: 54, y: 750, fontSize: 14 },
        { text: 'This paper presents an on-device TTS engine for browsers.', x: 54, y: 720, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Abstract');
      expect(result.chunks[0].speech).toContain('This paper presents an on-device TTS engine for browsers.');
    });

    it('Type 72: Keywords / Index Terms block formats properly', async () => {
      const result = await extractFromPdf([
        { text: 'Index Terms: Speech synthesis, WebAssembly, Kokoro, Chrome extension.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Index Terms: Speech synthesis, WebAssembly, Kokoro, Chrome extension.');
    });

    it('Type 73: Footnote text at bottom margin is classified as footnote', async () => {
      const result = await extractFromPdf([
        { text: 'Main body text referencing footnote.', x: 54, y: 700, fontSize: 12 },
        { text: '1 Code and models will be released upon acceptance.', x: 54, y: 60, fontSize: 8 },
      ]);
      expect(result.chunks[0].speech).toContain('Main body text referencing footnote.');
    });

    it('Type 74: Acknowledgments section header and content', async () => {
      const result = await extractFromPdf([
        { text: 'Acknowledgments', x: 54, y: 750, fontSize: 14 },
        { text: 'We thank the open-source AI community for valuable feedback.', x: 54, y: 710, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('Acknowledgments');
      expect(result.chunks[0].speech).toContain('We thank the open-source AI community for valuable feedback.');
    });

    it('Type 75: References section header formats as title', async () => {
      const result = await extractFromPdf([
        { text: 'References', x: 54, y: 750, fontSize: 16 },
        { text: '1. Smith, J. On-device neural speech. 2024.', x: 54, y: 710, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('References');
    });
  });

  describe('Family 6: Speech Flow & Naturalness', () => {
    it('Type 76: Title structural pause with colon separates title from body in audio', async () => {
      const result = await extractFromPdf([
        { text: 'PageNarrator Architecture', x: 150, y: 750, fontSize: 20 },
        { text: 'PageNarrator runs on-device without cloud dependencies.', x: 54, y: 700, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('PageNarrator Architecture: PageNarrator runs on-device without cloud dependencies.');
    });

    it('Type 77: List items separate with semicolons for distinct audio cadence', async () => {
      const result = await extractFromPdf([
        { text: '- Item Alpha.', x: 54, y: 700, fontSize: 12 },
        { text: '- Item Beta.', x: 54, y: 670, fontSize: 12 },
        { text: '- Item Gamma.', x: 54, y: 640, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toBe('Item Alpha; Item Beta; Item Gamma.');
    });

    it('Type 78: Table rows end with periods for distinct audio pauses between rows', async () => {
      const result = await extractFromPdf([
        { text: 'ColA ColB ColC', x: 54, y: 700, fontSize: 12 },
        { text: 'R1A 12 34', x: 54, y: 670, fontSize: 12 },
        { text: 'R2A 56 78', x: 54, y: 640, fontSize: 12 },
      ]);
      expect(result.chunks[0].speech).toContain('ColA ColB ColC.');
    });

    it('Type 79: Decimal numbers (3.14159) do not trigger false sentence splitting', () => {
      const text = 'The constant pi equals approximately 3.14159 in mathematical analysis.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('3.14159');
    });

    it('Type 80: Percentage numbers (99.9%, 0.05%) remain unbroken in sentence splitting', () => {
      const text = 'The precision reached 99.9% while the error rate dropped below 0.05% during evaluation.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('99.9%');
      expect(sentences[0]).toContain('0.05%');
    });

    it('Type 81: Time expressions (10:30 AM, 14:00 UTC) remain intact in sentence splitting', () => {
      const text = 'The test started at 10:30 AM and concluded at 14:00 UTC with zero errors.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('10:30 AM');
    });

    it('Type 82: Academic abbreviation protection (et al., e.g., i.e.) prevents mid-sentence fragmentation', () => {
      const text = 'As shown by Smith et al. in recent work, e.g. on transformers, latency is critical, i.e. under 50ms.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('et al.');
      expect(sentences[0]).toContain('e.g.');
      expect(sentences[0]).toContain('i.e.');
    });

    it('Type 83: Honorific abbreviation protection (Dr., Prof., Mr., Ms.) prevents false breaks', () => {
      const text = 'Dr. Watson and Prof. Moriarty conducted the mathematical analysis.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('Dr.');
      expect(sentences[0]).toContain('Prof.');
    });

    it('Type 84: Citation label abbreviation protection (Fig. 1, Tab. 2, Eq. 4, Sec. 3) keeps sentence intact', () => {
      const text = 'As illustrated in Fig. 1 and computed in Eq. 4, the throughput matches Sec. 3.';
      const sentences = splitSpeechSentences(text);
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('Fig. 1');
      expect(sentences[0]).toContain('Eq. 4');
      expect(sentences[0]).toContain('Sec. 3');
    });

    it('Type 85: Clause-boundary splitting cleanly splits long compound sentences under maxLen', () => {
      const text = 'While the initial latency was measured at 120ms, the optimized cache reduced playback startup to 45ms, and the memory footprint remained stable across long documents.';
      const chunks = chunkText(text, 90, { targetMinLen: 40 });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(90);
      }
    });
  });
});
