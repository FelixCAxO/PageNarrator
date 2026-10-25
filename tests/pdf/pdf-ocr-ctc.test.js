import { expect, it } from 'vitest';
import { decodePdfOcrCtc, decodePdfOcrCtcLabels } from '../../src/lib/pdf-ocr-ctc.js';
it('decodes compact int64 outputs identically and rejects invalid model labels', () => {
  const alphabet = ['', 'a', ' '], labels = [1n, 1n, 0n, 1n, 2n];
  const scores = new Float32Array([0.9, 0.8, 0.99, 0.7, 0.9]);
  const data = labels.flatMap((label, i) => alphabet.map((_, c) => c === Number(label) ? scores[i] : 0));
  const box = { left: 0, top: 0, height: 48, inputWidth: 100, width: 100 };
  expect(decodePdfOcrCtcLabels(labels, scores, alphabet, box))
    .toEqual(decodePdfOcrCtc(data, labels.length, alphabet, box));
  expect(() => decodePdfOcrCtcLabels([3n], [1], alphabet, box)).toThrow('Invalid OCR');
  expect(() => decodePdfOcrCtcLabels([1n], [], alphabet, box)).toThrow('Invalid OCR');
});
it('collapses repeats, preserves letters separated by blanks, and bounds word positions', () => {
  const alphabet = ['', 'l', ' ', 'a'], labels = [1, 1, 0, 1, 2, 3, 3, 0];
  const data = labels.flatMap((label) => alphabet.map((_, c) => c === label ? 0.9 : 0.01));
  const box = { left: 10, top: 20, height: 48, inputWidth: 80, width: 60 };
  const words = decodePdfOcrCtc(data, 8, alphabet, box);
  expect(words.map((word) => word.text)).toEqual(['ll', 'a']);
  expect(words[0].bbox).toEqual({ x0: 10, y0: 20, x1: 50, y1: 68 });
  expect(words[1].bbox.x1).toBeLessThanOrEqual(70);
  expect(decodePdfOcrCtc([0, 0, 0, 1, 0, 0, 0, 1], 2, alphabet, { ...box, width: 80 })[0].bbox.x1).toBe(90);
  expect(() => decodePdfOcrCtc([], 8, alphabet, box)).toThrow('Invalid OCR');
});

it('keeps a real boundary digit CTC span while ignoring emissions entirely in padded input', () => {
  const labels = new Int32Array(40), scores = new Float32Array(40).fill(.99), alphabet = ['', 'u', '1', ' ', '5', 'ghost'];
  labels[2] = 1; labels[4] = 2; labels[6] = labels[7] = 3; labels[9] = 4; labels[22] = 5;
  const geometry = { left: 10, top: 10, height: 44, inputWidth: 320, width: 65, sourceRight: 85 };
  const words = decodePdfOcrCtcLabels(labels, scores, alphabet, geometry);
  expect(words.map(word => word.text)).toEqual(['u1', '5']);
  expect(words[1].bbox.x0).toBe(76); expect(words[1].bbox.x1).toBeCloseTo(83.33333333333333, 12);
  // No extent metadata: independent verifier retains its established geometry.
  expect(decodePdfOcrCtcLabels(labels, scores, alphabet, { ...geometry, sourceRight: null }).map(word => word.text)).toEqual(['u1', '5ghost']);
  labels[39] = alphabet.length;
  expect(() => decodePdfOcrCtcLabels(labels, scores, alphabet, geometry)).toThrow('Invalid OCR CTC label');
  labels[39] = 0; scores[39] = NaN;
  expect(() => decodePdfOcrCtcLabels(labels, scores, alphabet, geometry)).toThrow('Invalid OCR CTC label');
  expect(() => decodePdfOcrCtcLabels(labels, new Float32Array(40), alphabet, { ...geometry, sourceRight: 10 })).toThrow('Invalid OCR CTC output');
});

it('bounds a repeated boundary-straddling run without emitting the same label again in padding', () => {
  const labels = [0, 1, 1, 1, 0, 1], scores = new Float32Array(6).fill(.9);
  const words = decodePdfOcrCtcLabels(labels, scores, ['', 'a'], { left: 10, top: 0, height: 48,
    inputWidth: 60, width: 15, sourceRight: 35 });
  expect(words).toHaveLength(1); expect(words[0].text).toBe('a');
  expect(words[0].bbox).toEqual({ x0: 20, y0: 0, x1: 35, y1: 48 });
  expect(words[0].confidence).toBeCloseTo(90, 5);
});

it('excludes synthetic edge padding while retaining the intersecting part of a real character run', () => {
  const geometry = { left: 10, top: 0, height: 48, inputWidth: 50, width: 40, sourceLeft: 25, sourceRight: 40 };
  const words = decodePdfOcrCtcLabels([1, 1, 1, 2, 0], new Float32Array(5).fill(.9), ['', 'a', ' '], geometry);
  expect(words.map(word => word.text)).toEqual(['a']);
  expect(words[0].bbox).toEqual({ x0: 25, y0: 0, x1: 40, y1: 48 });
  for (const bad of [{ sourceLeft: NaN }, { sourceLeft: 40 }, { sourceLeft: -1 }, { sourceLeft: 25, sourceRight: null }]) {
    expect(() => decodePdfOcrCtcLabels([1], [1], ['', 'a'], { ...geometry, ...bad })).toThrow('Invalid OCR CTC output');
  }
});


it('retains per-emitted-run peak evidence without changing the existing word mean, text or geometry', () => {
  const words = decodePdfOcrCtcLabels([1, 1, 2, 0, 2, 3, 4, 4], [.4, .99, .8, 1, .7, .99, .6, .98],
    ['', 'a', 'b', ' ', 'c'], { left: 10, top: 20, height: 48, inputWidth: 80, width: 80 });
  expect(words.map(word => word.text)).toEqual(['abb', 'c']);
  expect(words[0].confidence).toBeCloseTo((40 + 80 + 70) / 3, 12);
  expect(words[1].confidence).toBe(60);
  expect(words[0].bbox).toEqual({ x0: 10, y0: 20, x1: 60, y1: 68 });
  expect(words[0].symbols).toEqual([{ text: 'a', confidence: 99 }, { text: 'b', confidence: 80 }, { text: 'b', confidence: 70 }]);
  expect(words[1].symbols).toEqual([{ text: 'c', confidence: 98 }]);
});

it('keeps symbol uncertainty inside actual source spans and rejects padded labels as before', () => {
  const words = decodePdfOcrCtcLabels([1, 1, 2, 2], [.6, .8, .1, .99], ['', 'a', 'z'],
    { left: 0, top: 0, height: 48, inputWidth: 40, width: 15, sourceRight: 15 });
  expect(words).toHaveLength(1); expect(words[0].text).toBe('a');
  expect(words[0].bbox).toEqual({ x0: 0, y0: 0, x1: 15, y1: 48 });
  expect(words[0].symbols).toEqual([{ text: 'a', confidence: 80 }]);
});
