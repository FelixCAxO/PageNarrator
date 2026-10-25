import { expect, it } from 'vitest';
import { measureOcrReadingOrder } from '../helpers/ocr-reading-order.js';

it('requires unique complete anchors in reading order', () => {
  const passes = (text, anchors) => measureOcrReadingOrder(text, anchors).every(result => result.inOrder);
  expect(passes('Left end. Middle start. Right start.', ['left end', 'middle start', 'right start'])).toBe(true);
  expect(passes('Middle start. Left end. Right start.', ['left end', 'middle start', 'right start'])).toBe(false);
  expect(passes('Left end. Left end. Middle start.', ['left end', 'middle start'])).toBe(false);
  expect(passes('Left ending. Middle start.', ['left end', 'middle start'])).toBe(false);
  expect(passes('Left end.', ['left end', 'missing', ''])).toBe(false);
});
