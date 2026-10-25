// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original synthetic source-ownership control. No old image, OCR model or product function is read/executed.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const index = process.argv.indexOf('--output');
const output = index < 0 ? fileURLToPath(new URL('../tests/fixtures/ocr/', import.meta.url)) : resolve(process.argv[index + 1]);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const width = 112, height = 108, data = Buffer.alloc(width * height * 4, 255);
const own = [], neighbor = [];
// Five nonoverlapping bars give each original S 20 by 20 bounds and 272 ink pixels.
for (const top of [22, 55]) own.push(
  [30, top, 50, top + 4], [30, top + 4, 34, top + 9],
  [30, top + 9, 50, top + 13], [46, top + 13, 50, top + 16],
  [30, top + 16, 50, top + 20],
);
// A detached, connected ladder reaches the initial right search edge; its complete source lies farther right.
neighbor.push([104, 15, 108, 92], [78, 15, 104, 19], [78, 46, 104, 50], [78, 88, 104, 92]);
for (const [left, top, right, bottom] of [...own, ...neighbor])
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++)
    data.set([0, 0, 0, 255], (y * width + x) * 4);
function mask(rect) {
  const bytes = [];
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) bytes.push(Number(data[(y * width + x) * 4] < 180));
  return { rect, threshold: 180, foregroundPixels: bytes.reduce((sum, value) => sum + value, 0), maskSha256: hash(Uint8Array.from(bytes)) };
}
const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const fixture = {
  file: 'authored-stacked-glyphs.png', pngSha256: hash(png), pixelSha256: hash(data),
  provenance: 'Original PageNarrator five-bar stacked glyphs and detached ladder on a white canvas. Synthetic development/source-ownership geometry, not OCR output or an image-quality sample.',
  words: [{ text: 'S', confidence: 61.25, bbox: { x0: 26, y0: 12, x1: 56, y1: 92 } }],
  frame: { top: 12, bottom: 92, left: 0, right: width, stepWidth: 11 },
  // Source ink union [30,22,50,75] plus one pixel of padding, independently of production output.
  expected: [{ x0: 29, y0: 21, x1: 51, y1: 76 }],
  own: mask([30, 22, 50, 75]), neighbor: mask([78, 15, 108, 92]),
};
if (fixture.own.foregroundPixels !== 544 || fixture.neighbor.foregroundPixels !== 620) throw Error('Authored rectangle arithmetic changed');
await writeFile(resolve(output, fixture.file), png, { flag: 'wx' });
await writeFile(resolve(output, 'authored-stacked-control.json'), JSON.stringify({
  schema: 'pagenarrator-authored-stacked-glyph-control-v1', license: 'GPL-3.0-or-later',
  copyright: 'Copyright 2026 Felix Olsson. Original PageNarrator text, pixels and geometry.',
  producer: 'scripts/generate-ocr-stacked-control.mjs',
  scope: 'Synthetic source-bound refinement and unchanged word/confidence regression. No tracing or inference; not fresh real OCR quality evidence.',
  image: { width, height, mode: 'RGBA', background: [255, 255, 255, 255], ink: [0, 0, 0, 255] },
  authoredRectangles: { own, neighbor },
  expectationDerivation: {
    ownInkUnion: [30, 22, 50, 75], visibleInkPadding: 1,
    expectedBounds: [29, 21, 51, 76], initialSearch: [10, 11, 96, 93],
    neighbor: 'All three ladder teeth touch the initial right search edge. Its full component is detached 28 pixels from established ink, so it must not extend this source word.',
    ownPixelCount: '2*(20*4+4*5+20*4+4*3+20*4)=544',
    neighborPixelCount: '4*77+3*26*4=620',
    masks: 'Row-major uint8 0/1 values for black source pixels inside each half-open rectangle; SHA covers every foreground/background mask byte.',
    observation: 'Expected bounds/masks come from this authored drawing, never from recording refinePdfOcrWordBounds output.',
  },
  fixture,
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, files: 2, sourceImageReads: 0, productFunctionCalls: 0, modelCalls: 0, ownInk: 544, neighborInk: 620 }));
