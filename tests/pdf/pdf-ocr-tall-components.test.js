import { expect, it } from 'vitest';
import { orderPdfOcrBoxes, splitPdfOcrTallComponents } from '../../src/lib/pdf-ocr-detector.js';

function imageWithRows(rows, ink = 100) {
  return { width: 60, height: 100, getContext: () => ({
    getImageData(x, top, width, height) {
      const data = new Uint8ClampedArray(width * height * 4).fill(220);
      for (let y = 0; y < height; y++) if (rows.some(([a,b]) => y + top >= a && y + top < b)) {
        for (let c = 0; c < width; c++) for (let channel = 0; channel < 3; channel++) data[(y * width + c) * 4 + channel] = ink;
      }
      return { data };
    },
  }) };
}
const box = { x0: 10, x1: 20, y0: 10, y1: 60, slope: 0, score: .9 };
it('splits repeated pixel-separated rows and retains their source coordinates', () => {
  const input = [box];
  const result = splitPdfOcrTallComponents(imageWithRows([[12,20],[27,35],[42,50]]), input);
  expect(result.map(b => [b.x0,b.x1,b.y0,b.y1,b.slope])).toEqual([[8,22,12,20,0],[8,22,27,35,0],[8,22,42,50,0]]);
  expect(input).toEqual([box]);
  expect(result.every(b => b.score === .9)).toBe(true);
});
it('preserves unsplittable, low-contrast and ordinary horizontal components', () => {
  for (const image of [imageWithRows([[12,50]]), imageWithRows([[12,20],[27,35],[42,50]], 210), imageWithRows([[12,20],[27,35]])]) {
    expect(splitPdfOcrTallComponents(image, [box])[0]).toBe(box);
  }
  const horizontal = { ...box, x1: 50, y1: 20 };
  expect(splitPdfOcrTallComponents({ getContext() { throw Error('Unnecessary pixel read'); } }, [horizontal])[0]).toBe(horizontal);
});

it('keeps nearby row edges in left-to-right order across float32 jitter', () => {
  const left = { x0: 20, y0: 40.00001 }, right = { x0: 800, y0: 40 };
  for (const jitter of [-0.0001, 0, 0.0001]) {
    const shifted = { ...left, y0: left.y0 + jitter };
    expect(orderPdfOcrBoxes([right, shifted])).toEqual([shifted, right]);
  }
  const lower = { x0: 0, y0: 41 };
  expect(orderPdfOcrBoxes([lower, right, left])).toEqual([left, right, lower]);
});

it('anchors row groups without chaining a tolerance across multiple text rows', () => {
  const boxes = [{ x0: 80, y0: 10 }, { x0: 40, y0: 10.4 }, { x0: 0, y0: 10.8 }];
  expect(orderPdfOcrBoxes(boxes)).toEqual([boxes[1], boxes[0], boxes[2]]);
  expect(boxes.map(box => box.x0)).toEqual([80, 40, 0]);
});

it('scales row grouping with glyph height while keeping small annotations separate', () => {
  for (const scale of [1, 3, 10]) {
    const left = { x0: 20 * scale, y0: 40.15 * scale, y1: 47 * scale };
    const right = { x0: 300 * scale, y0: 40 * scale, y1: 47 * scale };
    const annotation = { x0: 0, y0: 42 * scale, y1: 44 * scale };
    expect(orderPdfOcrBoxes([right, annotation, left])).toEqual([left, right, annotation]);
  }
});
