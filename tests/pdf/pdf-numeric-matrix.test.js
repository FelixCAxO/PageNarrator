import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { annotatePdfTextLayer } from '../../src/lib/pdf-extraction.js';
import { buildReadingModel, renderReadingModelForSpeech } from '../../src/lib/reading-model.js';
import { isNumericMatrix } from '../../src/lib/numeric-matrix.js';

const item = (str, x, y, width = 18) => ({ str, transform: [1, 0, 0, 1, x, y], width, height: 12 });

// Fixed geometry transcribed from the user's rating/similarity diagram; no source PDF was supplied.
function matrixItems() {
  return [
    item('Rating matrix', 54, 750, 100), item('Similarity', 390, 750, 72),
    ...['MI', 'ST', 'AV'].map((text, index) => item(text, 94 + index * 40, 714)),
    item('u₁', 430, 714),
    ...[1, 2, 3, 4, 5, 6].flatMap((number, row) => [
      item(`u${number}`, 54, 690 - row * 24),
      item('5', 94, 690 - row * 24), item('3', 134, 690 - row * 24),
      ...(row === 1 ? [] : [item('2', 174, 690 - row * 24)]),
      item(`u${number}`, 390, 690 - row * 24), item(['1', '0.21', '0.10', '0.30', '-0.08', '-0.14'][row], 430, 690 - row * 24, 30),
    ]),
    item('Active user', 10, 730, 72),
    item('1. Calculate the similarity between active user and all the rest.', 225, 640, 155),
    item('2. Order users by similarity.', 490, 640, 160),
    item('The result uses 6 users and 3 ratings.', 54, 480, 260),
  ];
}

describe('numeric diagram matrices', () => {
  it('requires three distinct symbolic rows and preserves measurements or prose cells', () => {
    expect(isNumericMatrix([['u1', '5'], ['u2', '3']])).toBe(false);
    expect(isNumericMatrix([['u1', '5'], ['U1', '3'], ['u₁', '2']])).toBe(false);
    expect(isNumericMatrix([['u1', '5 kg'], ['u2', '3 kg'], ['u3', '2 kg']])).toBe(false);
    expect(isNumericMatrix([['u1', '5', 'Good'], ['u2', '3', 'Poor'], ['u3', '2', 'Fair']])).toBe(false);
    expect(isNumericMatrix([['u1', '−0.08'], ['U2', '0,21'], ['u₃', '3%']])).toBe(true);
  });
  for (const source of ['native', 'ocr']) {
    it(`skips rating cells and symbolic identifiers, keeps prose and visible anchors (${source})`, () => {
      const items = matrixItems().map((part, index) => source === 'ocr' ? { ...part, ocrLine: index } : part);
      const model = createPdfPageModel(items, { pageView: [0, 0, 700, 792] });
      expect(model.speech).toContain('Rating matrix');
      expect(model.speech).toContain('Similarity');
      expect(model.speech).toContain('Calculate the similarity between active user and all the rest');
      expect(model.speech).toContain('Order users by similarity');
      expect(model.speech).toContain('The result uses 6 users and 3 ratings');
      expect(model.speech).not.toMatch(/\bu[1-6]\b|u₁|0\.21|0\.08|\bMI\b|\bST\b|\bAV\b/);
      expect(model.orderedItems).toHaveLength(items.length);
      expect(model.anchorText).toContain('u6');
      const dom = new JSDOM('<div class="textLayer"></div>');
      const layer = dom.window.document.querySelector('.textLayer');
      for (const part of items) {
        const span = dom.window.document.createElement('span');
        span.textContent = part.str;
        layer.append(span);
      }
      annotatePdfTextLayer(layer, items, { pageView: [0, 0, 700, 792] });
      expect([...layer.querySelectorAll('[data-pagenarrator-pdf-narrated="true"]')].map((span) => span.textContent))
        .toEqual(expect.arrayContaining(['Rating matrix', '2. Order users by similarity.']));
      for (const span of layer.querySelectorAll('span')) {
        if (/^u[1-6]$|^u₁$|^0\.21$/.test(span.textContent)) {
          expect(span.getAttribute('data-pagenarrator-pdf-narrated')).toBe('false');
        }
      }
      dom.window.close();
    });
  }

  it('preserves a prose table, measurements, inline variables, and isolated identifiers', () => {
    const model = createPdfPageModel([
      item('Name', 54, 710), item('Score', 160, 710, 40), item('Notes', 280, 710, 40),
      item('Alice', 54, 686, 40), item('10', 160, 686), item('Passed', 280, 686, 48),
      item('Bob', 54, 662, 30), item('8', 160, 662), item('Review', 280, 662, 48),
      item('u1 has 5 ratings; x2 is 0.21 and cost is $3.', 54, 610, 270),
      item('x1', 54, 580), item('12 kg', 100, 580, 40),
    ]);
    expect(model.speech).toContain('Alice 10 Passed');
    expect(model.speech).toContain('Bob 8 Review');
    expect(model.speech).toContain('u1 has 5 ratings; x2 is 0.21 and cost is $3');
    expect(model.speech).toContain('x1');
    expect(model.speech).toContain('12 kg');
  });

  it('keeps subscripted OCR row labels with the numeric cells despite unequal ink heights', () => {
    const items = matrixItems().map((part, ocrLine) => {
      if (!/^u[1-6]$/u.test(part.str)) return { ...part, ocrLine };
      const transform = [...part.transform]; transform[5] -= 8;
      return { ...part, transform, height: 28, ocrLine };
    });
    const model = createPdfPageModel(items, { pageView: [0, 0, 700, 792] });
    expect(model.speech).toContain('Calculate the similarity');
    expect(model.speech).toContain('The result uses 6 users and 3 ratings');
    expect(model.speech).not.toMatch(/\bu[1-6]\b|0\.21|0\.08/u);
    expect(model.anchorText).toContain('u6');
    expect(model.orderedItems).toHaveLength(items.length);
  });

  it('keeps a numeric label with its own column when another matrix pulls the global row center', () => {
    const items = [], labels = [];
    const add = (str, x, center, width = 8) => {
      const originalIndex = items.length;
      items.push({ ...item(str, x, center - 5, width), height: 10, ocrLine: originalIndex });
      return originalIndex;
    };
    for (const [row, center] of [200, 178, 156, 134, 112].entries()) {
      labels.push(add(`r${row + 1}`, 10, center, 12));
      for (let column = 0; column < 7; column++) add(String(column + 1), 30 + column * 20, center);
      labels.push(add(`c${row + 1}`, 350, row === 3 ? 127.5 : row === 4 ? 108.5 : center, 12));
      add(row === 3 ? '-0.08' : row === 4 ? '-0.14' : `0.${row + 1}`, 380, row === 3 ? 129 : row === 4 ? 107 : center, 24);
    }
    add('Ordinary x4 denotes a variable; the result uses 5 cases.', 20, 60, 280);
    const model = createPdfPageModel(items, { pageView: [0, 0, 600, 300] });
    expect(model.speech).toContain('Ordinary x4 denotes a variable; the result uses 5 cases');
    expect(model.speech).not.toMatch(/\b[rc][1-5]\b|0\.08|0\.14/u);
    expect(model.narratedOriginalIndices.filter(index => labels.includes(index))).toEqual([]);
    expect(model.orderedItems).toHaveLength(items.length); expect(model.anchorText).toContain('c5');
  });

  it('finishes each explanation beside a matrix before reading the next column', () => {
    const items = matrixItems().filter((part) => !part.str.startsWith('1.') && !part.str.startsWith('2.'));
    const left = ['Calculate the similarity', 'between active user', 'and all the rest.'];
    const right = ['Order users', 'by similarity.'];
    for (let row = 0; row < 3; row += 1) {
      items.push(item(left[row], 225, 660 - row * 16, 130));
      if (right[row]) items.push(item(right[row], 490, 660 - row * 16, 100));
    }
    for (const source of ['native', 'ocr']) {
      const model = createPdfPageModel(items.map((part, index) => source === 'ocr' ? { ...part, ocrLine: index } : part));
      expect(model.speech).toContain('Calculate the similarity between active user and all the rest.');
      expect(model.speech).toContain('Order users by similarity.');
      expect(model.speech.indexOf('rest.')).toBeLessThan(model.speech.indexOf('Order'));
    }
  });

  it('keeps HTML matrix captions and surrounding explanation without reciting symbolic rows', () => {
    const document = new JSDOM(`<main><h1>Recommendation example</h1><table><caption>Rating matrix</caption>
      <tr><th></th><th>MI</th><th>ST</th></tr>
      <tr><td>u1</td><td>5</td><td>3</td></tr><tr><td>u2</td><td>4</td><td>3</td></tr>
      <tr><td>u3</td><td>5</td><td>2</td></tr></table>
      <p>Calculate the similarity between active user and all the rest.</p></main>`).window.document;
    const speech = renderReadingModelForSpeech(buildReadingModel(document));
    expect(speech).toContain('Rating matrix');
    expect(speech).toContain('Calculate the similarity');
    expect(speech).not.toMatch(/\bu[123]\b|\bMI\b|\bST\b|columns/);
  });
});
