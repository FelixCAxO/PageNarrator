import { expect, it } from 'vitest';
import { getPdfOcrPaperCrop, getPdfOcrPaperSourceCrop } from '../../src/lib/pdf-ocr-paper.js';
import { mapPdfOcrRetryLines } from '../../src/lib/pdf-ocr-retry.js';

// Fixed interval-oracle results from authored rectangles, frozen before the crop implementation.
// id, paper edges, render size/scale, original raster/scale/offset, expected crop, CPU crop (false = gutter).
const cases = [
  ["integer-whole-page",[0.3,0.2,0.75,0.8],[1200,2400,3],[1200,2400,3,0],[352,472,556,1456,1],[352,472,556,1456,1]],
  ["fractional-whole-page",[0.25,0.25,0.75,0.75],[1000,2332,3],[1000,2332,3,0],[242,575,516,1182,1],[242,575,516,1182,1]],
  ["fractional-wide-page",[0.25,0.25,0.75,0.75],[2332,1000,3],[2332,1000,3,0],[575,242,1182,516,1],[575,242,1182,516,1]],
  ["gpu-full-frame-must-remain",[0,0,1,1],[1000,2332,3],[1000,2332,3,0],[0,0,1000,2332,1],null],
  ["gpu-small-area-cpu-rejects",[0.4,0.4,0.41,0.41],[1000,2332,3],[1000,2332,3,0],[392,924,26,41,1],null],
  ["gpu-large-area-cpu-rejects",[0.05,0.05,0.95,0.95],[1000,2332,3],[1000,2332,3,0],[42,108,916,2116,1],null],
  ["cpu-min-area-boundary",[0,0,0.25,0.2],[1200,2400,3],[1200,2400,3,0],[0,0,308,488,1],[0,0,308,488,1]],
  ["cpu-max-area-boundary",[0,0,1,0.8],[1200,2400,3],[1200,2400,3,0],[0,0,1200,1928,1],[0,0,1200,1928,1]],
  ["fractional-half-gutter-origin",[0.6,0.2,0.8,0.8],[1414,2828,1.4142135623730951],[2000,2000,1,1414],[275,557,582,1714,2.002456518461668],false],
  ["fractional-three-panel-left",[0.05,0.1,0.9,0.9],[1968,2032,2.2564618142171082],[3398,1177,1.3068336470918092,0],[285,195,1683,1643,1.2027328029997204],false],
  ["fractional-three-panel-middle",[0.05,0.1,0.9,0.9],[1961,2038,2.2635022738035495],[3398,1177,1.3068336470918092,1974],[0,195,1961,1648,1.1125322141843208],false],
  ["fractional-three-panel-right",[0.05,0.1,0.9,0.9],[1955,2045,2.2706090488220423],[3398,1177,1.3068336470918092,3948],[0,196,1374,1653,1.3212314121430788],false],
  ["gutter-full-frame-must-remain",[0,0,1,1],[1955,2045,2.2706090488220423],[3398,1177,1.3068336470918092,3948],[0,0,1955,2045,1.000253221148962],false],
  ["paper-outside-region-refusal",[0.7,0.2,0.9,0.8],[1414,2828,1.4142135623730951],[2000,2000,1,0],null,false],
  ["fractional-intrinsic-rotation-90",[0.25,0.25,0.75,0.75],[2332,1000,3],[2332,1000,3,0],[575,242,1182,516,1],[575,242,1182,516,1]],
  ["fractional-intrinsic-rotation-180",[0.25,0.25,0.75,0.75],[1000,2332,3],[1000,2332,3,0],[242,575,516,1182,1],[242,575,516,1182,1]],
  ["fractional-intrinsic-rotation-270",[0.25,0.25,0.75,0.75],[2332,1000,3],[2332,1000,3,0],[575,242,1182,516,1],[575,242,1182,516,1]],
];

for (const [id, paperEdges, size, frame, expected, cpu] of cases) it(`maps the frozen integer raster interval: ${id}`, () => {
  const [left, top, right, bottom] = paperEdges, paper = { left, top, right, bottom };
  const [width, height, scale] = size, [sourceWidth, sourceHeight, sourceScale, offsetX] = frame;
  const crop = getPdfOcrPaperCrop(paper, width, height, scale, { sourceWidth, sourceHeight, sourceScale, offsetX });
  if (!expected) { expect(crop).toBeNull(); return; }
  expect([crop.left, crop.top, crop.width, crop.height]).toEqual(expected.slice(0, 4));
  expect(crop.factor).toBeCloseTo(expected[4], 14);
  expect(Math.floor(crop.width * crop.factor) * Math.floor(crop.height * crop.factor)).toBeLessThanOrEqual(4_000_000);
  expect(scale * crop.factor).toBeLessThanOrEqual(3 + 1e-14);
  const local = { x0: 3, x1: 17, y0: 5, y1: 11 };
  const mapped = mapPdfOcrRetryLines([{ bbox: local, words: [{ text: 'authored', bbox: local }] }], crop, crop.factor)[0].bbox;
  expect((mapped.x0 + offsetX) / scale).toBeCloseTo((crop.left + offsetX) / scale + local.x0 / (crop.factor * scale), 10);
  expect(mapped.y1 / scale).toBeCloseTo(crop.top / scale + local.y1 / (crop.factor * scale), 10);
  if (cpu !== false) {
    const source = getPdfOcrPaperSourceCrop(paper, sourceWidth, sourceHeight, sourceScale);
    if (!cpu) expect(source).toBeNull();
    else { expect([source.left, source.top, source.width, source.height]).toEqual(cpu.slice(0, 4)); expect(source.factor).toBeCloseTo(cpu[4], 14); }
  }
});

it('quantizes absolute gutter edges before subtracting the actual integer render offset', () => {
  const crop = getPdfOcrPaperCrop({ left: .6, top: .2, right: .8, bottom: .8 }, 1414, 2828, Math.SQRT2,
    { sourceWidth: 2000, sourceHeight: 2000, sourceScale: 1, offsetX: 1414 });
  expect(crop).toMatchObject({ left: 275, top: 557, width: 582, height: 1714 });
});

it('rejects absent, malformed or outside-frame mappings without an unbounded crop', () => {
  const paper = { left: .2, top: .2, right: .8, bottom: .8 };
  for (const frame of [{ sourceWidth: 0 }, { sourceHeight: 3.5 }, { sourceScale: Infinity }, { sourceScale: 0 }, { offsetX: -1 }, { offsetX: .5 }])
    expect(getPdfOcrPaperCrop(paper, 100, 100, 1, frame)).toBeNull();
  for (const value of [null, { ...paper, right: 1.1 }, { ...paper, left: -.1 }, { ...paper, top: NaN }, { ...paper, bottom: .1 }])
    expect(getPdfOcrPaperCrop(value, 100, 100, 1)).toBeNull();
});
