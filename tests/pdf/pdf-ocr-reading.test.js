import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { findOcrGutterInPixels } from '../../src/lib/pdf-ocr.js';
import { orderPdfOcrMarginalLines } from '../../src/lib/pdf-ocr-lines.js';
import { getPdfReadingProgress } from '../../src/lib/pdf-reading-progress.js';
import { getPanelView } from '../../src/lib/reader-engine-view.js';
import { createReaderEngineReadingStateRenderer } from '../../src/lib/reader-engine-reading-state-renderer.js';
import { execFileSync, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

it('keeps a separated narrow margin from interrupting a hyphenated body word', () => {
  const line=(text,x0,x1,y0)=>({text,bbox:{x0,x1,y0,y1:y0+10}});
  const body=[line('system require-',100,400,20),line('ments continue.',100,400,40)];
  const margin=[line('Margin note',10,70,15),line('continued',10,70,30)];
  const interleaved=[margin[0],body[0],margin[1],body[1]];
  expect(orderPdfOcrMarginalLines(interleaved).map(row=>row.text)).toEqual([
    'Margin note','continued','system require-','ments continue.',
  ]);
  const peers=interleaved.map(row=>({...row,bbox:{...row.bbox,x1:row.bbox.x0+60}}));
  expect(orderPdfOcrMarginalLines(peers)).toBe(peers);
  const table=[line('Quantity',10,70,20),body[0],line('2',10,70,40),body[1]];
  expect(orderPdfOcrMarginalLines(table)).toBe(table);
  const warpedContinuation={...body[1],bbox:{...body[1].bbox,y0:10}};
  expect(orderPdfOcrMarginalLines([margin[0],body[0],margin[1],warpedContinuation]).map(row=>row.text))
    .toEqual(['Margin note','continued','system require-','ments continue.']);
});

it('does not discard OCR heading numbers because warped boxes have different heights', () => {
  const words = [['Part III.b-', 30, 100, 20], ['11', 140, 20, 12], ['Documenting scenarios', 170, 200, 20]];
  const items = words.map(([str, x, width, height]) => ({ str, width, height, ocrLine: 0,
    transform: [height, 0, 0, height, x, 600] }));
  expect(createPdfPageModel(items).speech).toContain('11');
});

it('preserves OCR line order across columns and joins wrapped prose', () => {
  const item = (str, x, y, ocrLine) => ({ str, ocrLine, width: 140, height: 12,
    transform: [12, 0, 0, 12, x, y] });
  const items = [item('The left page begins', 30, 700, 0),
    item('and continues here.', 30, 686, 1), item('The right page follows.', 340, 700, 2)];
  const model = createPdfPageModel(items);
  expect(model.speech).toBe('The left page begins and continues here. The right page follows.');
  expect(model.orderedItems.map((part) => part.originalIndex)).toEqual([0, 1, 2]);
});

it('joins a short comma-ended OCR line into its broader lowercase continuation around an illustration', () => {
  const item = (str, x, y, width, ocrLine) => ({ str, width, height: 12, ocrLine, transform: [12, 0, 0, 12, x, y] });
  const first = item('Prepare for extreme weather,', 30, 700, 100, 0);
  const continuation = item('hazards, and emergencies.', 30, 686, 220, 1);
  expect(createPdfPageModel([first, continuation]).speech).toBe('Prepare for extreme weather, hazards, and emergencies.');
  expect(createPdfPageModel([first, { ...continuation, transform: [12, 0, 0, 12, 340, 686] }]).speech)
    .toBe('Prepare for extreme weather,. hazards, and emergencies.');
  expect(createPdfPageModel([first, { ...continuation, transform: [12, 0, 0, 12, 30, 660] }]).speech)
    .toBe('Prepare for extreme weather,. hazards, and emergencies.');
});

it('uses an explicitly separated OCR column to join a short prose line without crossing another column or a new list item', () => {
  const item = (str, width, y, ocrLine, ocrColumn = 0) => ({ str, width, height: 12, ocrLine, ocrColumn,
    transform: [12, 0, 0, 12, 30, y] });
  const first = item('Where fires are permitted, use', 100, 700, 0);
  const next = item('established fire rings, fire pans, or mound fires.', 220, 686, 1);
  expect(createPdfPageModel([first, next]).speech).toBe('Where fires are permitted, use established fire rings, fire pans, or mound fires.');
  expect(createPdfPageModel([first, { ...next, ocrColumn: 0.34 }]).speech).toBe('Where fires are permitted, use. established fire rings, fire pans, or mound fires.');
  expect(createPdfPageModel([first, { ...next, str: '• Keep the next list item separate.' }]).speech)
    .toBe('Where fires are permitted, use. • Keep the next list item separate.');
});

it('splits dense spreads only at a white central gutter', () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  expect(findOcrGutterInPixels(pixels)).toBe(0);
  for (let y = 24; y < 216; y += 2) {
    for (let x = 30; x < 210; x++) {
      if (x < 119 || x > 122) pixels[(y * 240 + x) * 4] = 0;
    }
  }
  expect(findOcrGutterInPixels(pixels)).toBeCloseTo(0.504, 2);
  for (let y = 24; y < 216; y += 2) {
    for (let x = 119; x <= 122; x++) pixels[(y * 240 + x) * 4] = 0;
  }
  expect(findOcrGutterInPixels(pixels)).toBe(0);
});

it.each(['Add to Chrome', 'Google Research', 'Chrome extension', 'reader@example.com', 'Piper voice models'])(
  'keeps one large text line intact instead of cutting glyphs into columns: %s', async text => {
    const pixels = await sharp(Buffer.from(`<svg width="1100" height="320" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="60" y="184" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700" fill="#111111">${text}</text></svg>`))
      .resize(240, 240, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    expect([80, 120, 160].map(center => findOcrGutterInPixels(pixels, center))).toEqual([0, 0, 0]);
  });

it('finds each white separator of three dense landscape panels without treating a dark binding as a separator', () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 24; y < 216; y += 2) for (let x = 15; x < 225; x++) {
    if (!(x >= 77 && x <= 83) && !(x >= 157 && x <= 163)) pixels[(y * 240 + x) * 4] = 0;
  }
  expect(findOcrGutterInPixels(pixels, 80)).toBeCloseTo(80.5 / 240, 4);
  expect(findOcrGutterInPixels(pixels, 160)).toBeCloseTo(160.5 / 240, 4);
  expect(findOcrGutterInPixels(pixels)).toBe(0);
  for (let y = 24; y < 216; y++) for (let x = 77; x <= 83; x++) pixels[(y * 240 + x) * 4] = 0;
  expect(findOcrGutterInPixels(pixels, 80)).toBe(0);
});

it('does not mistake an authored diagram with offset separators for symmetric three-panel gutters', async () => {
  const jpeg = await sharp(await readFile(new URL('../fixtures/ocr/authored-offset-diagram.svg', import.meta.url)))
    .resize(1200, 600, { fit: 'contain', background: 'white' }).jpeg().toBuffer();
  const pixels = await sharp(jpeg).resize(240, 240, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  expect([80, 160].map(center => findOcrGutterInPixels(pixels, center)).every(Boolean)).toBe(false);
});

it('keeps the centre of a wide panel gutter instead of clipping it to the preferred position', () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 24; y < 216; y += 2) for (let x = 15; x < 225; x++) {
    if (x < 76 || x > 87) pixels[(y * 240 + x) * 4] = 0;
  }
  expect(findOcrGutterInPixels(pixels, 80)).toBe(82 / 240);
});

it('ignores a black scan border above a clear body gutter without splitting a dark binding', () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 24; y < 216; y++) {
    for (let x = 30; x < 210; x++) {
      if (y < 48 || (y % 2 === 0 && (x < 129 || x > 131))) pixels[(y * 240 + x) * 4] = 0;
    }
  }
  expect(findOcrGutterInPixels(pixels)).toBeCloseTo(0.544, 2);
  for (let y = 48; y < 192; y++) {
    for (let x = 129; x <= 131; x++) pixels[(y * 240 + x) * 4] = 0;
  }
  expect(findOcrGutterInPixels(pixels)).toBe(0);
});

it('never confuses buffered OCR chunks with the full book, including pause and final page', () => {
  for (const state of ['reading', 'paused']) {
    const reading = { state, source: 'pdf', pageNumber: 8, pageCount: 401,
      currentChunk: 2, totalChunks: 7, totalReadableWordCount: 0 };
    const view = getPanelView(reading);
    expect(view.progressLabel).toBe('Page 8 of 401');
    expect(view.remainingLabel).toBe('393 pages after this page');
    expect(getPanelView({ ...reading, totalChunks: 30 })).toEqual(view);
    expect(getPanelView({ ...reading, pageNumber: 401 }).progressPercent).toBeLessThan(100);
  }
  expect(getPdfReadingProgress({ pageCount: 0 })).toBeNull();
  expect(getPdfReadingProgress({ pageNumber: 999, pageCount: 401 }).remainingPages).toBe(0);
});

it('runs the standalone checker without loading a PDF or OCR engine', () => {
  const result = JSON.parse(execFileSync(process.execPath,
    ['scripts/check-pdf-remaining.mjs', '8', '401'], { encoding: 'utf8' }));
  expect(result.remainingPages).toBe(393);
  expect(spawnSync(process.execPath, ['scripts/check-pdf-remaining.mjs', '0', '401']).status).toBe(1);
});

it('broadcasts the active OCR page through the real state renderer to the popup', () => {
  const dom = new JSDOM('<body></body>');
  const els = new Proxy({}, { get: (target, key) => target[key] ||= dom.window.document.createElement('div') });
  const sendMessage = vi.fn(async () => {});
  const state = { activeChunks: [{ pageNumber: 8, speech: 'Read this page.' }], currentChunk: 0,
    totalChunks: 7, activePdfPageCount: 401, totalReadableWordCount: 0, activeArticleSource: 'pdf' };
  const renderer = createReaderEngineReadingStateRenderer({ els, state,
    session: { setReadingState: (next) => { state.readingState = next; } },
    chrome: { runtime: { sendMessage } }, icons: {}, renderQueue: () => {},
    renderPdfPageControls: () => {}, hideReaderEngineErrorNotice: () => {},
    onboardingController: { render: () => {} }, reviewPromptController: { hide: () => {} },
  });
  renderer.setReadingState('paused');
  expect(els.readingProgressLabel.textContent).toBe('Page 8 of 401');
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    progressLabel: 'Page 8 of 401', remainingLabel: '393 pages after this page',
  }));
  dom.window.close();
});

it('finds the gutter of an offset book using the paper bounds', () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    if (x < 40 || (y % 4 === 0 && x !== 141 && x !== 142)) pixels[(y * 240 + x) * 4] = 0;
  }
  expect(findOcrGutterInPixels(pixels)).toBeCloseTo(142 / 240, 4);
  for (let y = 0; y < 240; y++) for (const x of [141, 142]) pixels[(y * 240 + x) * 4] = 0;
  expect(findOcrGutterInPixels(pixels)).toBe(0);
});
