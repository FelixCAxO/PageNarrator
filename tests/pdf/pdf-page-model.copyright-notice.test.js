import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

describe('standalone PDF copyright notices before list merging', () => {
  it('suppresses a standalone copyright row without absorbing it into an author block', () => {
    const source = [
      item('The chapter explains the complete original argument.', 54, 700, 310, 12),
      item('M. Author (*)', 54, 118, 100, 9),
      item('Research Institute, Coastal City', 54, 108, 190, 9),
      item('© The Author(s) 2023', 54, 88, 130, 8.5),
      item('A. Editor (ed.), A Useful Handbook', 54, 78, 240, 8.5),
      item('International Library of Practical Studies 40,', 54, 68, 260, 8.5),
    ];
    const before = structuredClone(source), model = createPdfPageModel(source);
    expect(model.speech).not.toContain('© The Author(s) 2023');
    expect(model.speech).toContain('International Library of Practical Studies 40');
    expect(model.anchorText).toContain('© The Author(s) 2023');
    expect(model.orderedItems.map(part => part.originalIndex).sort((a, b) => a - b)).toEqual(source.map((_, index) => index));
    expect(source).toEqual(before);
  });

  it.each([
    'The notice "© The Author(s) 2023" appears in the original volume.',
    '"© The Author(s) 2023"',
    'The copyright rules apply to the full original work.',
    '© The Author(s) 2023 describes an attribution, rather than this complete explanatory sentence.',
  ])('preserves quoted notices and substantive copyright prose: %s', text => {
    const source = [item(text, 54, 700, 480, 12)], before = structuredClone(source);
    const model = createPdfPageModel(source);
    expect(model.speech).toContain(text);
    expect(model.anchorText).toContain(text);
    expect(source).toEqual(before);
  });
});
