import { item } from './pdf-page-model.fixtures.js';
import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from "../../src/lib/pdf-page-model.js";

describe('PDF page model', () => {
  it.each(['air-source', 'star-forming', 'carbon-rich'])('uses the page own printed %s compound when repairing spaces and line wraps', compound => {
    const [left, right] = compound.split('-');
    const model = createPdfPageModel([
      item(`The ${compound} system is described here.`, 54, 700, 300),
      item(`A typical ${left}- ${right} system remains.`, 54, 674, 300),
      item(`Another ${left}-`, 54, 648, 300),
      item(`${right} system follows on this line.`, 54, 632, 300),
    ]);
    expect(model.speech).toContain(`A typical ${compound} system remains.`);
    expect(model.speech).toContain(`Another ${compound} system follows on this line.`);
    expect(model.anchorText).toContain(`${left}- ${right}`);
  });

  it('does not infer a new compound when the page prints both closed and hyphenated forms', () => {
    const model = createPdfPageModel([
      item('A worker may resign or re-sign a contract.', 54, 700, 300),
      item('Other workers may re-', 54, 674, 300),
      item('sign tomorrow.', 54, 658, 300),
    ]);
    expect(model.speech).toContain('Other workers may resign tomorrow.');
  });

  it('preserves spaced letters, explicit whitespace, raised letters and separate labels', () => {
    for (const parts of [
      [item('I', 100, 300, 5), item('a', 109, 300, 5)],
      [item('I ', 100, 300, 5), item('a', 106, 300, 5)],
      [item('I', 100, 300, 5), item(' a', 106, 300, 5)],
      [item('I', 100, 300, 5), item('a', 106, 303, 5)],
      [item('I', 100, 300, 5), item('a', 106, 300, 5, 8)],
    ]) {
      expect(createPdfPageModel(parts).anchorText).toBe('I a');
    }
  });

  it('keeps raised title glyphs with their baseline text', () => {
    const model = createPdfPageModel([
      item('S', 74, 759, 9, 14),
      item('2', 84, 766, 5, 10),
      item('IT: Stepwise Syntax Integration', 90, 759, 220, 14),
      item('Unrelated raised diagram label', 360, 766, 160, 10),
      item('Abstract', 158, 710, 45),
    ]);

    expect(model.lines[0].parts.map((part) => part.str)).toEqual([
      'S',
      '2',
      'IT: Stepwise Syntax Integration',
    ]);
    expect(model.anchorText).toMatch(/^S 2 IT: Stepwise Syntax Integration/u);
  });

  it('does not insert a spoken pause inside a decimal assembled from fragments', () => {
    const model = createPdfPageModel([
      item('Decimal evidence', 54, 760, 170, 20),
      item('Accuracy is', 54, 700, 72),
      item('0', 130, 700, 7),
      item('.', 137, 700, 3),
      item('64', 140, 700, 14),
      item('on the benchmark.', 158, 700, 110),
    ]);

    expect(model.speech).toContain('Accuracy is 0.64 on the benchmark.');
    expect(model.speech).not.toContain('0. 64');
  });

  it('normalizes soft-hyphen spaces without breaking compounds or structured labels', () => {
    const model = createPdfPageModel([
      item('Hyphen repair', 54, 760, 150, 20),
      item('The cor- responding GPU- accelerated method improves MM- JudgeBench.', 54, 700, 420),
      item('Purpose- In this study we evaluate the- L variable.', 54, 680, 300),
    ]);

    expect(model.speech).toContain('The corresponding GPU-accelerated method improves MM-JudgeBench.');
    expect(model.speech).toContain('Purpose: In this study we evaluate the L variable.');
  });

  it('preserves a same-line all-capital compound while repairing an uppercase word wrapped between lines', () => {
    const model = createPdfPageModel([
      item('EF- SCALE', 54, 720, 120, 14),
      item('An INTERCOM-', 54, 680, 140, 12),
      item('PARISON follows.', 54, 664, 140, 12),
    ]);
    expect(model.speech).toContain('EF-SCALE');
    expect(model.speech).toContain('INTERCOMPARISON follows.');
  });

  it.each([1, 1.5])('joins a separate touching line-end hyphen glyph at scale %s', scale => {
    const source = [
      item('The private domes', 54, 710, 100, 12),
      item('-', 154.1, 710, 3.5, 12),
      item('tic wells supply residents.', 54, 695.6, 92, 12),
    ].map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: [1, 0, 0, 1, part.transform[4] * scale, part.transform[5] * scale] }));
    const model = createPdfPageModel(source, { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.speech).toBe('The private domestic wells supply residents.');
    expect(model.anchorText).toContain('domes -');
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([0, 1, 2]);
    expect(model.orderedItems.map(part => part.transform)).toEqual(source.map(part => part.transform));
  });

  it('keeps a separately emitted touching compound hyphen', () => {
    const model = createPdfPageModel([
      item('A state', 54, 710, 40),
      item('-', 94.1, 710, 3.5),
      item('of-the-art reader.', 54, 695.6, 55),
    ]);
    expect(model.speech).toBe('A state-of-the-art reader.');
  });

  it('repairs soft hyphens and explicit unhyphenated continuations without breaking compounds', () => {
    const modelForWrap = createPdfPageModel([
      item('Wrap repair', 54, 760, 118, 20),
      item('An inter-', 54, 710, 62, 12, { hasEOL: true }),
      item('national audience.', 54, 692, 122, 12, { hasEOL: true }),
      item('The result is inter', 54, 650, 126, 12, { hasEOL: true }),
      item('national.', 54, 632, 62, 12, { wordBoundary: false }),
    ]);
    const modelForCompound = createPdfPageModel([
      item('Compound repair', 54, 760, 154, 20),
      item('A state-', 54, 710, 56, 12, { hasEOL: true }),
      item('of-the-art reader.', 54, 692, 126, 12, { hasEOL: true }),
    ]);
    const modelForPrefix = createPdfPageModel([
      item('Prefix repair', 54, 760, 154, 20),
      item('The unhyphenated item pre', 54, 710, 160, 12, { hasEOL: true }),
      item('serves the intended whole word.', 54, 692, 190, 12, { hasEOL: true, wordBoundary: false }),
      item('The multi', 54, 650, 70, 12, { hasEOL: true }),
      item('lingual benchmark remains clear.', 54, 632, 190, 12, { hasEOL: true, wordBoundary: false }),
    ]);

    expect(modelForWrap.speech).toContain('international');
    expect(modelForWrap.speech).not.toContain('inter national');
    expect(modelForCompound.speech).toContain('state-of-the-art');
    expect(modelForPrefix.speech).toContain('preserves the intended whole word.');
    expect(modelForPrefix.speech).not.toContain('pre serves');
    expect(modelForPrefix.speech).toContain('multilingual benchmark remains clear.');
  });
});
