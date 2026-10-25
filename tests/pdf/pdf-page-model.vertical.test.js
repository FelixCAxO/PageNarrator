import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

const vertical = (str, x, y, height, extra = {}) => ({ str, dir: 'ttb', vertical: true, textOrder: 'logical',
  transform: [5, 0, 0, 10, x, y], width: 5, height, ...extra });

describe('vertical PDF narration and source association', () => {
  it('reads each column top to bottom and columns right to left without splitting CJK characters', () => {
    const glyphs = [{ text: 'A', x: -0.25, y: -0.9, width: 1 }, { text: '、', x: -0.5, y: -1.8, width: 1 }];
    const source = [vertical('左列。', 80, 200, 30), vertical('A、', 100, 200, 22, { glyphs }), vertical('A', 100, 178, 10)];
    const model = createPdfPageModel(source);
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([1, 2, 0]);
    expect(model.lines.map(line => line.text)).toEqual(['A、A', '左列。']);
    expect(model.speech).toBe('A、A左列。');
    expect(model.narratedOriginalIndices).toEqual([1, 2, 0]);
    expect(model.orderedItems[0].glyphs).toBe(glyphs);
    expect(model.orderedItems[0].transform).toBe(source[1].transform);
    expect(source[1]).not.toHaveProperty('x');
  });

  it('retains horizontal headings and conclusions around the vertical text block', () => {
    const source = [item('An illustrated document', 54, 720, 500, 20), vertical('次の列。', 400, 650, 100),
      vertical('最初の列', 420, 650, 100), item('The conclusion remains available.', 54, 500, 450)];
    const model = createPdfPageModel(source);
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([0, 2, 1, 3]);
    expect(model.speech).toBe('An illustrated document: 最初の列次の列。 The conclusion remains available.');
  });

  it('preserves separated Latin words and logical punctuation along the vertical baseline', () => {
    const model = createPdfPageModel([vertical('Hello', 100, 200, 50), vertical('world!', 100, 145, 60)]);
    expect(model.lines[0].text).toBe('Hello world!');
    expect(model.speech).toBe('Hello world!');
  });

  it('uses transformed writing axes for rotated vertical glyph runs', () => {
    const rotate = part => ({ ...part, transform: [0, 5, -10, 0, 300 - part.transform[5], part.transform[4]] });
    const model = createPdfPageModel([vertical('左。', 80, 200, 20), vertical('右', 100, 200, 10), vertical('続', 100, 190, 10)].map(rotate));
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([1, 2, 0]);
    expect(model.speech).toBe('右続左。');
  });

  it('keeps disconnected top and bottom vertical paragraphs separate', () => {
    const model = createPdfPageModel([vertical('上段。', 100, 600, 30), vertical('下段。', 100, 300, 30)]);
    expect(model.lines).toHaveLength(2);
    expect(model.speech).toBe('上段。 下段。');
    expect(model.narratedOriginalIndices).toEqual([0, 1]);
  });

  it('joins vertically overlapping columns transitively before applying right-to-left order', () => {
    const model = createPdfPageModel([vertical('中', 120, 600, 20), vertical('右', 140, 560, 20), vertical('左。', 100, 590, 40)]);
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([1, 0, 2]);
    expect(model.speech).toBe('右中左。');
  });
});
