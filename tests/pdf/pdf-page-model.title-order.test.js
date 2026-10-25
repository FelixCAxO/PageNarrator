import { describe, it, expect } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

describe('independent column headings below a document title', () => {
  it.each([1, 1.5].flatMap(scale => ['three', 'three-reversed', 'roman', 'roman-alone'].map(kind => [scale, kind])))(
    'preserves the complete left column at scale %s in %s layout', (scale, kind) => {
      const three = kind.startsWith('three');
      const parts = [item('A Practical Handbook for Local Services', 36, 770, 540, 24)];
      if (three) {
        const headings = [item('GARDENS', 36, 742, 130, 24), item('TRANSIT', 254, 742, 100, 24), item('LIBRARIES', 412, 742, 148, 24)];
        if (kind === 'three-reversed') [headings[0], headings[1]] = [headings[1], headings[0]];
        parts.push(...headings);
      } else {
        if (kind !== 'roman-alone') parts.push(item('LEFT', 36, 742, 70, 24));
        parts.push(item('III', 303, 742, 21, 24));
      }
      const starts = three ? [36, 224, 412] : [36, 303];
      for (let row = 0; row < 6; row++) for (const [column, start] of starts.entries())
        parts.push(item(`Column ${column + 1} original sentence ${row} remains together.`, start, 704 - row * 16, three ? 160 : 245, 10));
      const input = parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
        transform: part.transform.map(value => value * scale) }));
      const before = structuredClone(input);
      for (const part of input) { Object.freeze(part.transform); Object.freeze(part); } Object.freeze(input);
      const model = createPdfPageModel(input, { pageView: [0, 0, 612 * scale, 842 * scale] });
      expect(model.speech.indexOf('Column 1 original sentence 5')).toBeLessThan(model.speech.indexOf(three ? 'TRANSIT' : 'III'));
      if (three) expect(model.speech.indexOf('Column 2 original sentence 5')).toBeLessThan(model.speech.indexOf('LIBRARIES'));
      expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(input.length);
      expect(input).toEqual(before);
    },
  );
});
