import { expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { readingOrderPatterns, buildReadingOrderPattern } from '../helpers/reading-order-patterns.js';

it.each([...readingOrderPatterns()])('$id $family $parameters', (pattern) => {
  const fixture = buildReadingOrderPattern(pattern);
  const model = createPdfPageModel(fixture.items, fixture.options);
  expect(model.orderedItems.map(item => item.patternKey)).toEqual(fixture.expectedKeys);
  if (pattern.id.startsWith('prose-')) expect(model.lines.some(line => line.role === 'table-row')).toBe(false);
});
