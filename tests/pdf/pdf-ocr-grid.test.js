import { expect, it } from 'vitest';
import { mapPdfOcrGridPoint, mapPdfOcrGridBox, mapPdfOcrGridBaseline, mapPdfOcrShearedBox, mapPdfOcrShearedBaseline } from '../../src/lib/pdf-ocr-grid.js';

it('encloses both ends of a sheared crop word for positive and negative line slopes', () => {
  const box = { x0: 10, x1: 50, y0: 10, y1: 30 };
  const crop = { left: 100, top: 200, originX: 110, padding: 10 };
  expect(mapPdfOcrShearedBox(box, { ...crop, slope: 0.5 }))
    .toEqual({ x0: 100, x1: 140, y0: 195, y1: 235 });
  expect(mapPdfOcrShearedBox(box, { ...crop, slope: -0.5 }))
    .toEqual({ x0: 100, x1: 140, y0: 185, y1: 225 });
  expect(mapPdfOcrShearedBox(box, { ...crop, slope: 0 }))
    .toEqual({ x0: 100, x1: 140, y0: 200, y1: 220 });
});

it.each([0, 0.5, -0.5])('keeps an interior source word exactly unchanged (slope=%s)', slope => {
  const box = { x0: 10, x1: 50, y0: 10, y1: 30 };
  const crop = { left: 100, top: 200, originX: 110, padding: 10, slope };
  expect(mapPdfOcrShearedBox(box, { ...crop, sourceWidth: 300, sourceHeight: 300 }))
    .toEqual(mapPdfOcrShearedBox(box, crop));
});

it('clips the actual sloped source polygon without accepting an empty enclosing corner', () => {
  const projection = { left: 0, top: 0, originX: 0, padding: 0, slope: 1, sourceWidth: 100, sourceHeight: 100 };
  // Its enclosing rectangle overlaps the image at x=0..10,y=90..100, but
  // the parallelogram itself lies entirely below the bottom-left corner.
  expect(mapPdfOcrShearedBox({ x0: -20, x1: 10, y0: 110, y1: 120 }, projection)).toBeNull();
  expect(mapPdfOcrShearedBox({ x0: -20, x1: 20, y0: 90, y1: 100 }, projection))
    .toEqual({ x0: 0, x1: 10, y0: 90, y1: 100 });
});

it('retains the source-supported part of the captured tall marginal box', () => {
  const source = { left: 0, top: 0, originX: 0, padding: 0, slope: 0, sourceWidth: 1732, sourceHeight: 2309 };
  expect(mapPdfOcrShearedBox({ x0: 1520, x1: 1620, y0: 1771.4951325322634, y1: 2546.4166344121318 }, source))
    .toEqual({ x0: 1520, x1: 1620, y0: 1771.4951325322634, y1: 2309 });
  expect(mapPdfOcrShearedBox({ x0: 10, x1: 20, y0: 2309, y1: 2400 }, source)).toBeNull();
});

it.each([
  [{ x0: -4, x1: 8, y0: -3, y1: 12 }, { x0: 0, x1: 8, y0: 0, y1: 12 }],
  [{ x0: 92, x1: 110, y0: 96, y1: 108 }, { x0: 92, x1: 100, y0: 96, y1: 100 }],
])('bounds partial edge words without adding any width or changing source extent', (box, expected) => {
  expect(mapPdfOcrShearedBox(box, { left: 0, top: 0, originX: 0, padding: 0, slope: 0, sourceWidth: 100, sourceHeight: 100 })).toEqual(expected);
});

it('clips a sloped baseline to its actual source intersection and omits wholly unsupported baselines', () => {
  const projection = { left: 0, top: 0, originX: 0, padding: 0, slope: 0.5, sourceWidth: 100, sourceHeight: 100 };
  expect(mapPdfOcrShearedBaseline({ x0: -20, x1: 120, y0: 40, y1: 40 }, projection))
    .toEqual({ x0: 0, y0: 40, x1: 100, y1: 90 });
  expect(mapPdfOcrShearedBaseline({ x0: 20, x1: 80, y0: 120, y1: 120 }, projection)).toBeNull();
});

it.each([NaN, Infinity, 0, -1])('rejects malformed source dimensions rather than hiding geometry errors (%s)', sourceWidth => {
  const projection = { left: 0, top: 0, originX: 0, padding: 0, slope: 0, sourceWidth, sourceHeight: 100 };
  expect(() => mapPdfOcrShearedBox({ x0: 0, x1: 10, y0: 0, y1: 10 }, projection)).toThrow('Invalid OCR source geometry');
  expect(() => mapPdfOcrShearedBaseline({ x0: 0, x1: 10, y0: 0, y1: 0 }, projection)).toThrow('Invalid OCR source baseline');
});

it('maps corrected coordinates to source pixels and includes interior curve extrema', () => {
  const grid = { width: 3, height: 2, sourceWidth: 201, sourceHeight: 101,
    outputWidth: 101, outputHeight: 51,
    data: [-1, 0, 1, -1, 0, 1, -1, -0.5, -1, 1, 1.5, 1] };
  expect(mapPdfOcrGridPoint(25, 25, grid)).toEqual({ x: 50, y: 62.5 });
  expect(mapPdfOcrGridBox({ x0: 0, y0: 0, x1: 100, y1: 50 }, grid))
    .toEqual({ x0: 0, y0: 0, x1: 200, y1: 125 });
  expect(mapPdfOcrGridPoint(100, 50, grid)).toEqual({ x: 200, y: 100 });
  expect(mapPdfOcrGridBaseline({ x0: 0, y0: 50, x1: 100, y1: 0 }, grid))
    .toEqual({ x0: 0, y0: 100, x1: 200, y1: 0 });
});
