import { describe, expect, it } from 'vitest';
import { extractPdfTextFromDocument } from '../../src/lib/pdf-extraction.js';
import { createFakePdfDocument, textItem } from './pdf-extraction.fixtures.js';

describe('distinct chapter openings are not interchangeable running furniture', () => {
  it.each([
    ['Chapter', ['2', '3', '4']],
    ['Section', ['2.1', '2.2', '2.3']],
    ['Part', ['1', '2', '3']],
    ['Chapter', ['II', 'III', 'IV']],
  ])('retains distinct %s numbers and their repeated substantive introduction', async (label, numbers) => {
    const intro = 'These solutions explain the exercises from the earlier section.';
    const pages = numbers.map((number, index) => [
      textItem(`${label} ${number}`, 77, 679.5, { width: 110, height: 21 }),
      textItem(intro, 77, 648.75, { width: 420, height: 15 }),
      textItem(`1. The original answer number ${index} remains available.`, 92, 614.25, { width: 350, height: 15 }),
    ]);
    const before = structuredClone(pages), article = await extractPdfTextFromDocument(createFakePdfDocument(pages));
    expect(article.chunks).toHaveLength(3);
    for (const [index, chunk] of article.chunks.entries()) {
      expect(chunk.speech).toContain(`${label} ${numbers[index]}`);
      expect(chunk.speech).toContain(intro);
      expect(chunk.pdfNarration.narratedItemOrders).toEqual([0, 1, 2]);
    }
    expect(pages).toEqual(before);
  });

  it.each(['Chapter 4 — Page', 'Chapter IV — Page', 'Page'])('still suppresses recurring structural header %s with changing printed page numbers', async prefix => {
    const pages = Array.from({ length: 3 }, (_, index) => [
      textItem(`${prefix} ${index + 11}${prefix === 'Page' ? ' — Section 2.1' : ''}`, 77, 770, { width: 180, height: 9 }),
      textItem(`Page ${index + 1}`, 300, 26, { width: 40, height: 9 }),
      textItem(`Distinct original answer ${index} remains available.`, 77, 680, { width: 320, height: 12 }),
    ]);
    const article = await extractPdfTextFromDocument(createFakePdfDocument(pages));
    expect(article.chunks).toHaveLength(3);
    for (const chunk of article.chunks) {
      expect(chunk.speech).not.toMatch(/Chapter (?:4|IV)|Section 2\.1/u);
      expect(chunk.speech).not.toMatch(/Page \d/u);
      expect(chunk.pdfNarration.narratedItemOrders).toHaveLength(1);
    }
  });
});
