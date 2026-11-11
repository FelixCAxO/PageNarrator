import { expect, it } from 'vitest';
import { stripPdfEquations } from '../../src/lib/pdf-equations.js';

it('removes equations and keeps the surrounding prose', () => {
  expect(stripPdfEquations('The value x = 17 is used in this example.')).toBe('The value is used in this example.');
  expect(stripPdfEquations('A sample of n = 30 participants was used.')).toBe('A sample of participants was used.');
  expect(stripPdfEquations('Energy: E = mc². The next sentence stays.')).toBe('Energy: The next sentence stays.');
  expect(stripPdfEquations('We compute √ x for each item.')).toBe('We compute for each item.');
  expect(stripPdfEquations('Σ = x + 119')).toBe('');
});

it('leaves prose with numbers, initialisms and comparisons alone', () => {
  for (const text of ['I read a book.', 'Results were significant, p < 0.05, in NASA and IBM trials from 2020-2021.']) {
    expect(stripPdfEquations(text)).toBe(text);
  }
});
