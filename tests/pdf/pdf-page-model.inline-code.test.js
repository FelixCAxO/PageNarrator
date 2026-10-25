import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

const code = (text, x, y, extra = {}) => item(text, x, y, text.length * 4.8, 8,
  { fontName: 'authored-fixed-pitch', hasEOL: true, ...extra });
const prose = (text, y) => item(text, 50, y, 360, 11, { fontName: 'authored-prose', hasEOL: true });
function program(marker = '#') {
  return [prose('The following program demonstrates the calculation.', 550),
    code('import toolkit', 50, 520),
    code('count = 27', 50, 507), code(`${marker} Update the counter`, 220, 507),
    code('emit(count)', 50, 494), code(`${marker} Display the current count`, 220, 494),
    code('inspect(count)', 50, 481), code(`${marker} Inspect the saved value`, 220, 481),
    prose('The explanatory paragraph follows the complete program.', 455),
    prose('Additional body prose remains in its original vertical order.', 440)];
}

describe('inline source-code comments', () => {
  it.each(['#', '//', '/*'])('keeps aligned %s comments beside their code before following prose', marker => {
    const model = createPdfPageModel(program(marker), { pageView: [0, 0, 500, 600] });
    const strings = model.orderedItems.map(part => part.str);
    expect(strings.indexOf(`${marker} Update the counter`)).toBeLessThan(strings.indexOf('emit(count)'));
    expect(strings.indexOf(`${marker} Display the current count`)).toBeLessThan(strings.indexOf('inspect(count)'));
    expect(model.speech.indexOf('Inspect the saved value')).toBeLessThan(model.speech.indexOf('The explanatory paragraph'));
    expect(model.narratedOriginalIndices).toEqual(expect.arrayContaining([2, 3, 4, 5, 6, 7, 8]));
  });

  it('does not merge independent adjacent code columns without inline-comment syntax', () => {
    const model = createPdfPageModel([
      code('left(alpha)', 40, 520), code('right(first)', 270, 520),
      code('left(beta)', 40, 507), code('right(second)', 270, 507),
      code('left(gamma)', 40, 494), code('right(third)', 270, 494),
    ], { pageView: [0, 0, 500, 600] });
    expect(model.speech.indexOf('left(gamma)')).toBeLessThan(model.speech.indexOf('right(first)'));
  });

  it('keeps larger body prose below an opening program instead of promoting it to a document title', () => {
    const model = createPdfPageModel([
      code('count = 27', 50, 550), code('# Set value', 220, 550),
      code('emit(count)', 50, 537), code('# Prints 27', 220, 537),
      code('inspect(count)', 50, 524), code('# Prints 27', 220, 524),
      prose('The explanatory paragraph follows the complete program.', 498),
      prose('Additional body prose remains in its original vertical order.', 483),
    ], { pageView: [0, 0, 500, 600] });
    expect(model.speech.indexOf('inspect(count)')).toBeLessThan(model.speech.indexOf('The explanatory paragraph'));
    expect(model.lines.find(line => line.text.startsWith('The explanatory')).documentTitle).toBe(false);
  });

  it.each(['connect(server, 80)', 'client.connect(server, 80)', 'result = connect(server, 80)'])(
    'retains an opening code statement before its larger explanatory prose: %s', statement => {
      const model = createPdfPageModel([
        code(statement, 50, 550),
        prose('The explanatory paragraph follows the statement.', 524),
        prose('Its continuation remains beside the original statement.', 509),
        code('def read_data(filename):', 50, 480),
        code('handle = open(filename)', 60, 467),
        code('return handle.read()', 60, 454),
      ], { pageView: [0, 0, 500, 600] });
      expect(model.lines[0].text).toBe(statement);
      expect(model.lines.find(line => line.text.startsWith('The explanatory')).documentTitle).toBe(false);
    },
  );

  it('does not infer fixed-pitch code context from proportional same-font prose', () => {
    const model = createPdfPageModel([
      item('A genuine longer paragraph begins here.', 50, 520, 220, 10, { fontName: 'body' }),
      item('The next paragraph explains the result.', 50, 500, 215, 10, { fontName: 'body' }),
      item('A third paragraph remains in the main body.', 50, 480, 223, 10, { fontName: 'body' }),
      item('# margin annotation', 340, 520, 90, 10, { fontName: 'body' }),
      item('# another annotation', 340, 500, 86, 10, { fontName: 'body' }),
    ], { pageView: [0, 0, 500, 600] });
    expect(model.speech.indexOf('third paragraph')).toBeLessThan(model.speech.indexOf('margin annotation'));
  });
});
