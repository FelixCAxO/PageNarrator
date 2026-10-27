import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

function layout({ side = 'right', noteHeight = 7, noteWidth = 110, labels = false } = {}) {
  const mainX = side === 'right' ? 54 : 200, noteX = side === 'right' ? 390 : 54;
  const source = [];
  for (let row = 0; row < 30; row++) {
    const text = row === 9 ? 'A narrow connection has three orders of'
      : row === 10 ? 'magnitude less capacity and limited band-'
        : row === 11 ? 'width for its original useful messages.'
          : `The main explanation number ${row} remains complete${row < 9 ? '' : '.'}`;
    source.push(item(text, mainX, 730 - row * 14, 300, 10, { fontName: 'Main' }));
  }
  for (let row = 0; row < 17; row++) source.push(item(labels ? String(row + 1) : row === 0 ? 'A compact technical sidebar' : `The sidebar explanation ${row} remains separate.`,
    noteX, 650 - row * 9, labels ? 10 : noteWidth, noteHeight, { fontName: 'Notes' }));
  return source;
}

describe('compact smaller-type sidebars beside the text block', () => {
  it.each([0.5, 1, 2].flatMap(scale => ['center', 'right'].flatMap(alignment => ['rows', 'columns', 'reverse', 'shuffled'].map(order => ({ scale, alignment, order })))))
  ('keeps a displaced heading above short code and full-width prose: $alignment, $scale, $order', ({ scale, alignment, order }) => {
    const source = [item('Section overview', alignment === 'right' ? 340 : 210, 820, 180, 9),
      item('>>> read(value)', 60, 760, 110, 10), item('>>> print(result)', 60, 744, 110, 10),
      item('>>> close()', 60, 728, 110, 10), item('A complete explanation continues across the page.', 60, 700, 420, 10)]
      .map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
        transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) }));
    const expected = source.map(part => part.str);
    if (order === 'columns') source.sort((a, b) => a.transform[4] - b.transform[4] || b.transform[5] - a.transform[5]);
    if (order === 'reverse') source.reverse();
    if (order === 'shuffled') source.push(...source.splice(0, 2));
    const model = createPdfPageModel(source, { pageView: [0, 0, 600 * scale, 900 * scale] });
    expect(model.orderedItems.map(part => part.str)).toEqual(expected);
  });

  it.each(['left', 'right'])('keeps a long %s sidebar after the complete main text and repairs body wraps', side => {
    const source = layout({ side }), before = structuredClone(source);
    const model = createPdfPageModel(source);
    expect(model.speech).toContain('three orders of magnitude less capacity and limited bandwidth for its original useful messages.');
    expect(model.speech.indexOf('main explanation number 29')).toBeLessThan(model.speech.indexOf('compact technical sidebar'));
    expect(model.speech).toContain('sidebar explanation 16 remains separate');
    expect(model.orderedItems.map(part => part.originalIndex).sort((a, b) => a - b)).toEqual(source.map((_, index) => index));
    expect(source).toEqual(before);
  });

  it.each([{ noteHeight: 10, noteWidth: 110 }, { noteHeight: 7, noteWidth: 220 }])('retains genuine left-column-first flow without the complete compact-type distinction: %o', options => {
    const source = layout({ side: 'left', ...options });
    const model = createPdfPageModel(source);
    expect(model.speech.indexOf('compact technical sidebar')).toBeLessThan(model.speech.indexOf('main explanation number 29'));
    expect(model.lines.every(line => !line.sideNote)).toBe(true);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
  });

  it('does not classify a smaller line-number gutter as a prose sidebar', () => {
    const source = layout({ side: 'left', labels: true });
    const model = createPdfPageModel(source);
    expect(model.lines.every(line => !line.sideNote)).toBe(true);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
  });

  it.each(['#', '//'])('keeps smaller mixed-font %s comments attached to their assignment rows', marker => {
    const source = [];
    for (let row = 0; row < 12; row++) {
      source.push(item(`result_${row} = load_record_and_apply_options(input_${row}, options_${row})`, 54, 710 - row * 14, 300, 10, { fontName: 'Code' }));
      if (row < 9) source.push(item(`${marker} explain the original step ${row}`, 390, 710 - row * 14, 145, 7, { fontName: 'Comment' }));
    }
    const before = structuredClone(source), model = createPdfPageModel(source);
    for (let row = 0; row < 9; row++) expect(model.lines.some(line => line.text.includes(`result_${row} =`)
      && line.text.includes(`${marker} explain the original step ${row}`))).toBe(true);
    expect(model.lines.every(line => !line.sideNote)).toBe(true);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
    expect(source).toEqual(before);
  });

  it('does not split a sidebar hyphenation when an outdented body row crosses a candidate gutter', () => {
    const source = [];
    for (let row = 0; row < 30; row++) source.push(item(`The main explanation number ${row} remains complete.`,
      row === 13 ? 200 : 240, 730 - row * 14, 300, 10, { fontName: 'Main' }));
    for (let row = 0; row < 17; row++) source.push(item(row === 6 ? 'A device has centimeter-level preci-'
      : row === 7 ? 'sion. While highly accurate, these'
        : row === 8 ? 'sensors can operate under constraints.'
          : `The original side explanation ${row} stays complete.`, 54, 650 - row * 14, 110, 7, { fontName: 'Notes' }));
    const before = structuredClone(source), model = createPdfPageModel(source);
    expect(model.speech).toContain('precision. While highly accurate, these sensors can operate under constraints.');
    expect(model.speech).not.toContain('precisensors');
    expect(model.orderedItems.map(part => part.originalIndex).sort((a, b) => a - b)).toEqual(source.map((_, index) => index));
    expect(source).toEqual(before);
  });
});
