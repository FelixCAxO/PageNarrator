import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { joinPdfOcrLineFragments, getPdfOcrRetryRectangle } from '../../src/lib/pdf-ocr-lines.js';

const { lines, expectedGroups, expectedWords, expectedRetryRectangle } = JSON.parse(readFileSync(new URL('../fixtures/ocr/authored-line-fragments.json', import.meta.url), 'utf8'));

it('rejoins ten authored split-row continuations without changing any word or box', () => {
  const original = structuredClone(lines);
  // Detached tails are deliberately interleaved; expected rows come from the authored source.
  const groups = expectedGroups;
  const joined = joinPdfOcrLineFragments(lines);
  expect(joined.map((line) => line.words)).toEqual(groups.map((group) => group.flatMap((i) => lines[i].words)));
  expect(joined.flatMap((line) => line.words)).toHaveLength(expectedWords);
  expect(lines).toEqual(original);
  expect(getPdfOcrRetryRectangle(lines, joined)).toEqual(expectedRetryRectangle);
});

it('keeps separate columns and vertically adjacent lines separate', () => {
  const line = (x, y, text) => ({ bbox: { x0: x, x1: x + 100, y0: y - 12, y1: y },
    baseline: { x0: x, x1: x + 100, y0: y, y1: y }, words: [{ text }] });
  const separate = [line(0, 20, 'Left'), line(0, 40, 'Below'), line(150, 20, 'Right')];
  expect(joinPdfOcrLineFragments(separate)).toEqual(separate);
  expect(getPdfOcrRetryRectangle(separate, separate)).toBeNull();
  expect(joinPdfOcrLineFragments([{ words: [{ text: 'No baseline' }] }])).toEqual([{ words: [{ text: 'No baseline' }] }]);
});

it('does not retry a page with two genuine text columns as one block', () => {
  const column = (x, y) => ({ bbox: { x0: x, y0: y, x1: x + 100, y1: y + 15 }, words: [] });
  const columns = [column(0, 0), column(0, 30), column(0, 60), column(200, 0), column(200, 30), column(200, 60)];
  expect(getPdfOcrRetryRectangle([...columns, ...columns], columns)).toBeNull();
});

it('follows the local tangent when the line bends between fragments', () => {
  const fragment = (x0, y0, x1, y1, text) => ({
    bbox: { x0, x1, y0: Math.min(y0, y1) - 15, y1: Math.max(y0, y1) },
    baseline: { x0, y0, x1, y1 }, words: [{ text }],
  });
  const curved = [fragment(0, 30, 100, 40, 'One'), fragment(205, 43, 300, 35, 'three'),
    fragment(103, 40, 203, 43, 'two')];
  expect(joinPdfOcrLineFragments(curved).map((line) => line.words.map((word) => word.text)))
    .toEqual([['One', 'two', 'three']]);
});

