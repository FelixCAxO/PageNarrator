// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original synthetic development controls. No source screenshot, book, model or OCR output is read.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? fileURLToPath(new URL('../tests/fixtures/ocr/', import.meta.url)) : resolve(process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [];
async function save(name, bytes, role) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await writeFile(resolve(output, name), data, { flag: 'wx' });
  records.push({ name, bytes: data.length, sha256: hash(data), role });
}
async function json(name, value, role) { await save(name, JSON.stringify(value, null, 2) + '\n', role); }

// Deliberately odd dimensions, distinct RGB channels, oblique boundaries and nonopaque alpha.
// Pixels are integer formulas plus original geometric bands; no font or input-image dependencies.
const width = 173, height = 109, rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  rgba[i] = (29 * x + 11 * y) % 256;
  rgba[i + 1] = (x * x + 13 * y) % 256;
  rgba[i + 2] = ((x ^ y) * 17) % 256;
  rgba[i + 3] = (7 * x + 19 * y) % 256;
  if (x < 7 || y < 5) { rgba[i] = 250; rgba[i + 1] = 242; rgba[i + 2] = 231; }
  if (x >= y + 18 && x < y + 24) { rgba[i] = 9; rgba[i + 1] = 54; rgba[i + 2] = 171; }
  if ((x - 111) ** 2 + (y - 53) ** 2 < 19 ** 2) rgba[i + 3] = 0;
  if (x > 145 && y > 70) rgba[i + 3] = 255;
}
await save('authored-packing.png', await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(),
  'Synthetic exact-pixel packing control; odd width/tails, RGB distinction, bands and transparent hidden RGB.');

// The first ten row baselines each have one 10-pixel interruption; the last is intact.
// All geometry and tokens are authored, not a transform of the retired OCR hypotheses.
const anchors = [], continuations = [];
function fragment(row, x0, x1, tokenStart, count) {
  const y0 = 8 + row * 28, y1 = y0 + 16, base = y0 + 12;
  const gap = 5, wordWidth = (x1 - x0 - 8 - (count - 1) * gap) / count;
  return { bbox: { x0, y0, x1, y1 }, baseline: { x0, y0: base, x1, y1: base },
    words: Array.from({ length: count }, (_, i) => {
      const left = x0 + 4 + i * (wordWidth + gap);
      return { text: `Row${String(row + 1).padStart(2, '0')}Token${String(tokenStart + i).padStart(2, '0')}`,
        bbox: { x0: left, y0, x1: left + wordWidth, y1 } };
    }) };
}
for (let row = 0; row < 11; row++) {
  const x = 48 + row % 3 * 2;
  anchors.push(fragment(row, x, x + (row === 10 ? 395 : 180), 1, row === 10 ? 10 : 4));
  if (row < 10) continuations.push(fragment(row, x + 190, x + 395, 5, 5));
}
const tailOrder = [5, 0, 8, 2, 9, 4, 1, 7, 3, 6];
const expectedGroups = Array.from({ length: 11 }, (_, row) => row < 10 ? [row, 11 + tailOrder.indexOf(row)] : [row]);
await json('authored-line-fragments.json', {
  schema: 'pagenarrator-authored-line-fragment-control-v1',
  provenance: 'Original PageNarrator GPL-3.0-or-later synthetic geometry and arbitrary tokens. No OCR output or third-party screenshot.',
  scope: 'Development grouping/index/box/no-mutation control, not image recognition or real curved-page quality.',
  lines: [...anchors, ...tailOrder.map(row => continuations[row])], expectedGroups,
  expectedWords: 100, expectedContinuations: 10, expectedRetryRectangle: { left: 48, top: 8, width: 399, height: 296 },
}, 'Synthetic 21 fragments, 11 rows and 100 words, with exactly 10 detached continuations.');

// Independent diagram: three colored instrument panels with deliberately asymmetric white gaps.
// Uses platform SVG text rendering only; no embedded/extracted font program, external resource or old artwork.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">
<rect width="1200" height="600" fill="white"/>
<g stroke="#071827" stroke-width="3">
<rect x="36" y="24" width="144" height="552" rx="8" fill="#284b63"/>
<rect x="256" y="24" width="284" height="552" rx="8" fill="#46546a"/>
<rect x="790" y="24" width="374" height="552" rx="8" fill="#315b50"/>
</g>
<g fill="white" font-family="sans-serif" font-size="24">
<text x="48" y="72">Sensor</text><text x="48" y="112">A7</text>
<text x="275" y="72">Current</text><text x="275" y="120">0.42 m/s</text>
<text x="808" y="72">Difference</text><text x="808" y="120">-0.08</text>
<text x="275" y="520">Collect samples.</text><text x="808" y="520">Review drift.</text>
</g>
<g fill="none" stroke="#d9e4ee" stroke-width="4">
<path d="M65 180 L145 220 L65 260 L145 300 L65 340 L145 380 L65 420"/>
<path d="M280 200 H510 M280 280 H510 M280 360 H510 M280 440 H510"/>
<path d="M815 400 L875 330 L935 350 L995 240 L1055 275 L1130 175"/>
</g>
</svg>`;
await save('authored-offset-diagram.svg', svg + '\n',
  'Original synthetic three-panel diagram with offset white gaps and m/s/-0.08 text; not traced rating artwork.');

const pages = [];
for (const [page, regions] of [[1, [
  { kind: 'heading', rect: [.10, .08, .60, .10], text: 'Harbor sensor notes' },
  { kind: 'prose', rect: [.10, .22, .70, .25], text: 'An amber marker identifies the next inspection point.' },
]], [2, [
  { kind: 'prose', rect: [.16, .12, .64, .26], text: 'Record two measurements before closing the panel.' },
  { kind: 'caption', rect: [.18, .62, .58, .08], text: 'Panel B: sample count 7.' },
]]]) {
  const name = `authored-reference-page-${page}.json`;
  const value = { page, referenceStatus: 'authored', scope: 'Original synthetic reference-schema control; no photographed page or OCR result.', regions };
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await save(name, bytes, 'Original text/normalized-region metadata, not real-image quality gold.');
  pages.push({ page, referenceFile: name, referenceStatus: 'authored', referenceSha256: hash(bytes) });
}
await json('authored-reference-corpus.json', {
  version: 1, sourceKind: 'authored-schema-control-no-recognition',
  provenance: 'Original PageNarrator synthetic short text and rectangular regions under GPL-3.0-or-later.',
  scope: 'Two-page JSON schema/hash integrity control only. No held-out/development recognizer score or quality threshold.', pages,
}, 'Two original reference files/hash manifest; no old book excerpts.');
await json('authored-fixture-provenance.json', {
  schema: 'pagenarrator-original-ocr-development-fixtures-v1', license: 'GPL-3.0-or-later',
  copyright: 'Copyright 2026 Felix Olsson. Original authored PageNarrator control source, text and geometry.',
  scope: 'Synthetic development/unit controls only; no new real dataset, OCR output, prior mask, quality acceptance or transcription claim.',
  producer: 'scripts/generate-original-ocr-fixtures.mjs',
  rendering: { packing: 'Sharp encodes directly authored raw RGBA; no font or input-image dependency.', diagram: 'Original SVG geometry/text. Platform font rasterization is used only by tests; no font binary is copied.' },
  files: records,
}, 'Original-control provenance receipt.');
console.log(JSON.stringify({ output, files: records.length, sourceImagesRead: 0, modelCalls: 0, browserCalls: 0 }));
