import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

describe('PDF narration with control characters in text mappings', () => {
  it('removes control-only decorations without losing the following heading or source geometry', () => {
    const source = [item('\u0007', 45, 700, 5), item('Results and Analysis', 60, 700, 180), item('The results support the conclusion.', 60, 680, 250)];
    const before = structuredClone(source), model = createPdfPageModel(source);
    expect(model.speech).toBe('Results and Analysis: The results support the conclusion.');
    expect(model.anchorText).toBe('Results and Analysis\n\nThe results support the conclusion.');
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([1, 2]);
    expect(source).toEqual(before);
  });

  it('keeps word boundaries and printable multilingual text when controls occur inside an item', () => {
    const source = [item('Alpha\u0000beta\u0007gamma\u007fdelta\u0085epsilon. Καλημέρα 中文 مرحبا.', 60, 680, 450)];
    const model = createPdfPageModel(source);
    expect(model.speech).toBe('Alpha beta gamma delta epsilon. Καλημέρα 中文 مرحبا.');
    expect(model.anchorText).not.toMatch(/\p{Cc}/u);
    expect(source[0].str).toContain('\u0000');
  });
});
