import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getReadingOrderedTextItems } from '../../src/lib/pdf-extraction.js';

function pdfItem(str, x, y, originalIndex) {
  return {
    str,
    transform: [1, 0, 0, 1, x, y],
    height: 12,
    width: Math.max(12, String(str).length * 6),
    originalIndex,
  };
}

describe('PDF extraction invariants', () => {
  it('never loses or duplicates text items while ordering shuffled page content', () => {
    fc.assert(fc.property(
      fc.array(
        fc.record({
          str: fc.string({ minLength: 1, maxLength: 12 }).filter((value) => value.trim().length > 0),
          x: fc.integer({ min: 40, max: 520 }),
          y: fc.integer({ min: 40, max: 760 }),
        }),
        { minLength: 1, maxLength: 40 },
      ),
      (rawItems) => {
        const items = rawItems.map((item, index) => pdfItem(item.str, item.x, item.y, index));
        const ordered = getReadingOrderedTextItems(items);

        expect(ordered).toHaveLength(items.length);
        expect(ordered.map((item) => item.originalIndex).sort((a, b) => a - b)).toEqual(
          items.map((item) => item.originalIndex).sort((a, b) => a - b),
        );
      },
    ), { numRuns: 100 });
  });
});
