import { expect, it } from 'vitest';
import { TABLE_PATTERN_AXES, tableReadingOrderPatterns, buildTableReadingOrderPattern } from '../helpers/reading-order-patterns.js';
import { SIDENOTE_PATTERN_AXES, sidenoteReadingOrderPatterns, buildSidenoteReadingOrderPattern } from '../helpers/sidenote-reading-order-patterns.js';

it('enumerates every declared table combination exactly once with a semantic oracle independent of drawing order', () => {
  const patterns = [...tableReadingOrderPatterns()];
  const count = Object.values(TABLE_PATTERN_AXES).reduce((total, values) => total * values.length, 1);
  expect(count).toBe(27648);
  expect(patterns).toHaveLength(count);
  expect(new Set(patterns.map(({ id }) => id)).size).toBe(count);
  expect(new Set(patterns.map(({ parameters }) => JSON.stringify(parameters))).size).toBe(count);
  for (const pattern of patterns) {
    const fixture = buildTableReadingOrderPattern(pattern);
    expect(new Set(fixture.expectedKeys).size, pattern.id).toBe(fixture.items.length);
    expect(fixture.expectedText.join(' '), pattern.id).toBe(fixture.cells.flat(2).join(' '));
    expect(fixture.items.every(item => item.x >= 0 && item.y > 0
      && item.x + item.width < fixture.options.pageView[2] && item.y < fixture.options.pageView[3]), pattern.id).toBe(true);
  }
});

it('enumerates every rotated sidenote combination exactly once without changing its semantic paragraph anchor', () => {
  const patterns = [...sidenoteReadingOrderPatterns()];
  const count = Object.values(SIDENOTE_PATTERN_AXES).reduce((total, values) => total * values.length, 1);
  expect(count).toBe(6912);
  expect(patterns).toHaveLength(count);
  expect(new Set(patterns.map(({ id }) => id)).size).toBe(count);
  expect(new Set(patterns.map(({ parameters }) => JSON.stringify(parameters))).size).toBe(count);
  for (const pattern of patterns) {
    const fixture = buildSidenoteReadingOrderPattern(pattern);
    expect(new Set(fixture.expectedKeys).size, pattern.id).toBe(fixture.items.length);
    expect(fixture.expectedText.join(' '), pattern.id).toBe(fixture.cells.join(' '));
    expect(fixture.expectedKeys.findIndex(key => key.startsWith('note/')), pattern.id).toBeGreaterThan(0);
    expect(fixture.options.pageRotation || 0, pattern.id).toBe(pattern.parameters.rotation);
  }
});
