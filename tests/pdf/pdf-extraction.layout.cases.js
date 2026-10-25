import { describe, expect, it } from "vitest";
import { JSDOM } from 'jsdom';

import { PDF_TEXT_LAYER_ORDER_ATTRIBUTE, PDF_TEXT_LAYER_NARRATED_ATTRIBUTE, PDF_TEXT_LAYER_TEXT_ATTRIBUTE, annotatePdfTextLayer, getReadingOrderedTextItems, renderTextItems } from "../../src/lib/pdf-extraction.js";

describe('PDF extraction', () => {
  it('orders two-column PDF text top-to-bottom inside each column instead of interleaving lines', () => {
    const text = renderTextItems([
      { str: 'Left column first line', transform: [1, 0, 0, 1, 72, 720], height: 12, width: 120 },
      { str: 'Right column first line', transform: [1, 0, 0, 1, 320, 720], height: 12, width: 130 },
      { str: 'Left column second line', transform: [1, 0, 0, 1, 72, 700], height: 12, width: 130 },
      { str: 'Right column second line', transform: [1, 0, 0, 1, 320, 700], height: 12, width: 140 },
    ]);

    expect(text).toBe([
      'Left column first line',
      'Left column second line',
      'Right column first line',
      'Right column second line',
    ].join('\n\n'));
  });

  it('keeps dense two-column PDF rows in column order when the gutter is narrow', () => {
    const text = renderTextItems([
      { str: 'Left first clause', transform: [1, 0, 0, 1, 50, 720], height: 10, width: 82 },
      { str: 'continues near gutter', transform: [1, 0, 0, 1, 142, 720], height: 10, width: 145 },
      { str: 'Right first line', transform: [1, 0, 0, 1, 309, 720], height: 10, width: 236 },
      { str: 'Left second line', transform: [1, 0, 0, 1, 50, 700], height: 10, width: 236 },
      { str: 'Right second line', transform: [1, 0, 0, 1, 309, 700], height: 10, width: 236 },
    ]);

    expect(text).toBe([
      'Left first clause continues near gutter',
      'Left second line',
      'Right first line',
      'Right second line',
    ].join('\n\n'));
  });

  it('keeps narrow-gutter PDF columns in column order when PDF.js emits wide text items', () => {
    const text = renderTextItems([
      { str: 'Left tall first line', transform: [1, 0, 0, 1, 72, 720], height: 24, width: 260 },
      { str: 'Right tall first line', transform: [1, 0, 0, 1, 360, 720], height: 24, width: 220 },
      { str: 'Left tall second line', transform: [1, 0, 0, 1, 72, 700], height: 24, width: 260 },
      { str: 'Right tall second line', transform: [1, 0, 0, 1, 360, 700], height: 24, width: 220 },
    ]);

    expect(text).toBe([
      'Left tall first line',
      'Left tall second line',
      'Right tall first line',
      'Right tall second line',
    ].join('\n\n'));
  });

  it('does not let full-width PDF title lines bridge two body columns', () => {
    const text = renderTextItems([
      { str: 'Full width paper title', transform: [1, 0, 0, 1, 132, 697], height: 14, width: 350 },
      { str: 'Authors spanning both columns', transform: [1, 0, 0, 1, 73, 639], height: 12, width: 468 },
      { str: 'ABSTRACT', transform: [1, 0, 0, 1, 54, 593], height: 11, width: 58 },
      { str: 'Right column first line', transform: [1, 0, 0, 1, 318, 593], height: 9, width: 241 },
      { str: 'Left column first line', transform: [1, 0, 0, 1, 54, 580], height: 9, width: 240 },
      { str: 'Right column second line', transform: [1, 0, 0, 1, 318, 582], height: 9, width: 240 },
      { str: 'Left column second line', transform: [1, 0, 0, 1, 54, 569], height: 9, width: 240 },
      { str: 'Right column third line', transform: [1, 0, 0, 1, 318, 571], height: 9, width: 240 },
      { str: 'DAB | 21 Mar 2026', transform: [0, 20, -20, 0, 32, 560], height: 20, width: 527 },
    ]);

    expect(text).toBe([
      'Full width paper title',
      'Authors spanning both columns',
      'ABSTRACT',
      'Left column first line',
      'Left column second line',
      'Right column first line',
      'Right column second line',
      'Right column third line',
    ].join('\n\n'));
  });

  it('orders two-page spread text by the left page before the right page', () => {
    const text = renderTextItems([
      { str: 'Left page heading', transform: [1, 0, 0, 1, 56, 720], height: 12, width: 110 },
      { str: 'Right page heading', transform: [1, 0, 0, 1, 360, 720], height: 12, width: 120 },
      { str: 'Left page paragraph', transform: [1, 0, 0, 1, 56, 700], height: 12, width: 128 },
      { str: 'Right page paragraph', transform: [1, 0, 0, 1, 360, 700], height: 12, width: 136 },
    ]);

    expect(text).toBe([
      'Left page heading',
      'Left page paragraph',
      'Right page heading',
      'Right page paragraph',
    ].join('\n\n'));
  });

  it('keeps a centered heading before the two-column body it introduces', () => {
    const text = renderTextItems([
      { str: 'Chapter Heading', transform: [1, 0, 0, 1, 220, 742], height: 18, width: 180 },
      { str: 'Left column first line', transform: [1, 0, 0, 1, 72, 710], height: 12, width: 120 },
      { str: 'Right column first line', transform: [1, 0, 0, 1, 330, 710], height: 12, width: 130 },
      { str: 'Left column second line', transform: [1, 0, 0, 1, 72, 690], height: 12, width: 130 },
      { str: 'Right column second line', transform: [1, 0, 0, 1, 330, 690], height: 12, width: 140 },
    ]);

    expect(text).toBe([
      'Chapter Heading',
      'Left column first line',
      'Left column second line',
      'Right column first line',
      'Right column second line',
    ].join('\n\n'));
  });

  it('orders RTL two-column PDF text from the right column first', () => {
    const text = renderTextItems([
      { str: 'שמאל כותרת', transform: [1, 0, 0, 1, 72, 720], height: 12, width: 75 },
      { str: 'ימין כותרת', transform: [1, 0, 0, 1, 360, 720], height: 12, width: 75 },
      { str: 'שמאל שורה', transform: [1, 0, 0, 1, 72, 700], height: 12, width: 70 },
      { str: 'ימין שורה', transform: [1, 0, 0, 1, 360, 700], height: 12, width: 70 },
    ]);

    expect(text).toBe([
      'ימין כותרת',
      'ימין שורה',
      'שמאל כותרת',
      'שמאל שורה',
    ].join('\n\n'));
  });

  it('orders RTL fragments within a line from right to left', () => {
    const text = renderTextItems([
      { str: 'שני', transform: [1, 0, 0, 1, 360, 720], height: 12, width: 28 },
      { str: 'ראשון', transform: [1, 0, 0, 1, 420, 720], height: 12, width: 42 },
      { str: 'רביעי', transform: [1, 0, 0, 1, 360, 700], height: 12, width: 35 },
      { str: 'שלישי', transform: [1, 0, 0, 1, 420, 700], height: 12, width: 42 },
    ]);

    expect(text).toBe([
      'ראשון שני',
      'שלישי רביעי',
    ].join('\n\n'));
  });

  it('annotates PDF text-layer spans with the same reading order used for extraction', () => {
    const rawItems = [
      { str: 'Right first', transform: [1, 0, 0, 1, 320, 720], height: 12, width: 80 },
      { str: 'Left first', transform: [1, 0, 0, 1, 72, 720], height: 12, width: 70 },
      { str: 'Right second', transform: [1, 0, 0, 1, 320, 700], height: 12, width: 90 },
      { str: 'Left second', transform: [1, 0, 0, 1, 72, 700], height: 12, width: 80 },
    ];
    const dom = new JSDOM(`
      <div class="textLayer">
        <span>Right first</span>
        <span>Left first</span>
        <span>Right second</span>
        <span>Left second</span>
      </div>
    `);
    const layer = dom.window.document.querySelector('.textLayer');

    expect(getReadingOrderedTextItems(rawItems).map((item) => item.originalIndex)).toEqual([1, 3, 0, 2]);

    annotatePdfTextLayer(layer, rawItems);

    expect([...layer.querySelectorAll('span')].map((span) => span.getAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE))).toEqual([
      '2',
      '0',
      '3',
      '1',
    ]);
    expect(layer.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).toBe(
      'Left first. Left second. Right first. Right second.',
    );
  });

  it('stores narrated PDF text for word alignment while keeping visible spans ordered', () => {
    const rawItems = [
      { str: 'Evidence [7] supports the result', transform: [1, 0, 0, 1, 72, 700], height: 12, width: 190 },
    ];
    const dom = new JSDOM('<div class="textLayer"><span>Evidence [7] supports the result</span></div>');
    const layer = dom.window.document.querySelector('.textLayer');

    annotatePdfTextLayer(layer, rawItems);

    expect(layer.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).toBe('Evidence supports the result.');
  });

  it('marks numeric-only lines omitted from speech as non-narrated', () => {
    const items = [
      { str: 'We are document-', ocrLine: 0, transform: [1, 0, 0, 1, 72, 700], height: 12, width: 150 },
      { str: '20', ocrLine: 1, transform: [1, 0, 0, 1, 20, 690], height: 200, width: 20 },
      { str: 'ing scenarios.', ocrLine: 2, transform: [1, 0, 0, 1, 72, 680], height: 12, width: 150 },
    ];
    const dom = new JSDOM('<div class="textLayer"><span>We are document-</span><span>20</span><span>ing scenarios.</span></div>');
    const layer = dom.window.document.querySelector('.textLayer');
    annotatePdfTextLayer(layer, items);
    expect(layer.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).toContain('documenting');
    expect([...layer.querySelectorAll('span')].map(span => span.getAttribute(PDF_TEXT_LAYER_NARRATED_ATTRIBUTE))).toEqual(['true', 'false', 'true']);
    dom.window.close();
  });

  it('marks dense figure labels as visible but non-narrated text-layer spans', () => {
    const rawItems = [
      { str: 'Meaningful body prose.', transform: [1, 0, 0, 1, 54, 680], height: 12, width: 180 },
      { str: 'plot_label_1 plot_label_2', transform: [1, 0, 0, 1, 326, 600], height: 5, width: 110 },
      { str: 'Figure 1: Evaluation overview.', transform: [1, 0, 0, 1, 326, 580], height: 10, width: 190 },
    ];
    const dom = new JSDOM('<div class="textLayer"><span>Meaningful body prose.</span><span>plot_label_1 plot_label_2</span><span>Figure 1: Evaluation overview.</span></div>');
    const layer = dom.window.document.querySelector('.textLayer');

    annotatePdfTextLayer(layer, rawItems);

    expect([...layer.querySelectorAll('span')].map((span) => (
      span.getAttribute(PDF_TEXT_LAYER_NARRATED_ATTRIBUTE)
    ))).toEqual(['true', 'false', 'true']);
    expect(layer.textContent).toContain('plot_label_1 plot_label_2');
    expect(layer.getAttribute(PDF_TEXT_LAYER_TEXT_ATTRIBUTE)).not.toContain('plot_label');
  });

  it('dehyphenates soft line breaks inside a PDF column', () => {
    const text = renderTextItems([
      { str: 'The paragraph has a hyphen-', transform: [1, 0, 0, 1, 72, 720], height: 12, width: 150 },
      { str: 'ated line break.', transform: [1, 0, 0, 1, 72, 700], height: 12, width: 120 },
    ]);

    expect(text).toBe('The paragraph has a hyphenated line break.');
  });
});
