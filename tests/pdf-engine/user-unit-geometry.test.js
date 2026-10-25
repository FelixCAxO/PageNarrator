// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { openPdfDocument, renderPdfTextLayer } from '../../src/pdf/browser-pdf.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { renderPdfOcrTextLayer } from '../../src/lib/pdf-ocr-text-layer.js';
import { applyPageViewportStyles } from '../../src/lib/pdf-viewer-rendering.js';
import { applyPdfViewportToPageElement, getPdfPageViewport } from '../../src/lib/pdf-viewer-toolbar.js';

vi.mock('../../src/lib/pdf-extraction.js', () => ({ annotatePdfTextLayer: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const view = [10, 20, 110, 70];
const cases = [
  [0, [2, 0, 0, -2, -16, 147], 200, 100, [10, 70]],
  [90, [0, 2, 2, 0, -36, -13], 100, 200, [10, 20]],
  [180, [-2, 0, 0, 2, 224, -33], 200, 100, [110, 20]],
  [270, [0, -2, -2, 0, 144, 227], 100, 200, [110, 70]],
];
it.each(cases)('scales source units once at rotation %i while keeping public zoom and offsets', (rotation, transform, width, height, corner) => {
  const input = [...view], viewport = createPdfViewport(input, { scale: 1, userUnit: 2, rotation, offsetX: 4, offsetY: 7 });
  expect(viewport).toMatchObject({ scale: 1, userUnit: 2, offsetX: 4, offsetY: 7, width, height });
  expect(viewport.transform).toEqual(transform);
  expect(viewport.convertToViewportPoint(...corner)).toEqual([4, 7]);
  expect(viewport.convertToPdfPoint(4, 7)).toEqual(corner);
  expect(input).toEqual(view);
});
it('retains default-unit transforms and accepts fractional positive units', () => {
  expect(createPdfViewport(view, { scale: 2 }).transform).toEqual([2, 0, 0, -2, -20, 140]);
  const fractional = createPdfViewport(view, { scale: 2, userUnit: 0.5 });
  expect(fractional).toMatchObject({ width: 100, height: 50, scale: 2, userUnit: 0.5 });
  expect(fractional.transform).toEqual([1, 0, 0, -1, -10, 70]);
});
it('clones public zoom and offsets without reapplying or replacing the page unit', () => {
  const original = createPdfViewport(view, { scale: 1, userUnit: 2, rotation: 90, offsetX: 4, offsetY: 7 });
  const clone = original.clone({ scale: 0.5, rotation: 0, offsetX: 9, offsetY: 11, userUnit: 99 });
  expect(clone).toMatchObject({ scale: 0.5, userUnit: 2, width: 100, height: 50, rotation: 0 });
  expect(clone.transform).toEqual([1, 0, 0, -1, -1, 81]);
  expect(original.clone().transform).toEqual([0, 2, 2, 0, -36, -13]);
  clone.viewBox[0] = -100;
  expect(original.viewBox).toEqual(view);
});
it.each([0, -1, NaN, Infinity, '2', Number.MIN_VALUE])('rejects unsafe unit/effective inverse %s', userUnit => {
  expect(() => createPdfViewport(view, { userUnit })).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
});
it('rejects overflowing effective transforms and nonfinite offsets before raster allocation', () => {
  expect(() => createPdfViewport(view, { userUnit: Number.MAX_VALUE, scale: 2 })).toThrow();
  expect(() => createPdfViewport(view, { userUnit: 2, offsetX: Infinity })).toThrow();
  expect(() => createPdfViewport(view, { userUnit: 2, scale: 0 })).toThrow();
});

function authoredReader(unit, parentUnit = 1) {
  const fields = { 1: { Root: 2 }, 2: { Type: 3, Pages: 4 }, 4: { Type: 7, Count: 5, Kids: 6, MediaBox: 8, UserUnit: 24 },
    10: { Type: 11, CropBox: 12, Rotate: 13, ...(unit === undefined ? {} : { UserUnit: 14 }) } };
  const numbers = { 5: 1, 13: 90, 14: unit, 15: 0, 16: 0, 17: 200, 18: 100, 19: 10, 20: 20, 21: 110, 22: 70, 24: parentUnit };
  const reader = { trailer: 1, field: (id, key) => fields[id]?.[key] || 0,
    name: id => ({ 3: 'Catalog', 7: 'Pages', 11: 'Page' })[id],
    number: (id, fallback = 0) => typeof numbers[id] === 'number' ? numbers[id] : fallback,
    array: id => ({ 6: [10], 8: [15, 16, 17, 18], 12: [19, 20, 21, 22] })[id],
    node: id => ({ id }), check() {}, destroy: vi.fn() };
  vi.spyOn(NativePdfReader, 'create').mockResolvedValue(reader);
  return reader;
}
it.each([2, 0.5, undefined])('carries the page-local unit %s from acquired reader through facade without changing source boxes', async unit => {
  const reader = authoredReader(unit, 4), document = await openPdfDocument(new Uint8Array(), { useWorker: false });
  try {
    const page = await document.getPage(1), expected = unit ?? 1;
    expect(page.view).toEqual(view); expect(page.userUnit).toBe(expected);
    expect(page.getViewport({ scale: 1, userUnit: 99 })).toMatchObject({ scale: 1, userUnit: expected, rotation: 90, width: 50 * expected, height: 100 * expected });
  } finally { document.destroy(); }
  expect(reader.destroy).toHaveBeenCalledTimes(1);
});
it.each([0, -2, NaN, Infinity, '2'])('rejects invalid explicit page-unit metadata %s and retains explicit document cleanup', async unit => {
  const reader = authoredReader(unit), document = await openPdfDocument(new Uint8Array(), { useWorker: false });
  try { await expect(document.getPage(1)).rejects.toMatchObject({ code: 'pdf_corrupt' }); }
  finally { document.destroy(); }
  expect(reader.destroy).toHaveBeenCalledTimes(1);
});
it('receives the same page geometry through the existing worker message contract', async () => {
  let worker;
  class AuthoredWorker {
    constructor() { worker = this; this.terminate = vi.fn(); }
    postMessage({ id, method }) {
      const result = method === 'open' ? { numPages: 1, metadata: { info: {} } } : { view: [...view], rotate: 90, userUnit: 2 };
      queueMicrotask(() => this.onmessage({ data: { id, result } }));
    }
  }
  vi.stubGlobal('Worker', AuthoredWorker);
  const document = await openPdfDocument(new Uint8Array(), { useWorker: true });
  try { expect((await document.getPage(1)).getViewport()).toMatchObject({ width: 100, height: 200, scale: 1, userUnit: 2 }); }
  finally { document.destroy(); }
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

function authoredLayer() {
  const canvases = [], context = { measureText: () => ({ width: 12 }) };
  const document = { createElement: tag => {
    if (tag === 'canvas') { const canvas = { width: 10, height: 10, getContext: () => context }; canvases.push(canvas); return canvas; }
    return { style: {}, setAttribute() {} };
  } };
  const layer = { ownerDocument: document, style: {}, dataset: {}, children: [], setAttribute() {},
    replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } };
  return { layer, canvases };
}
it('projects native text width with the effective scale while preserving source transforms', async () => {
  const { layer, canvases } = authoredLayer(), item = { str: 'AB', fontName: 'Authored', dir: 'ltr', transform: [10, 0, 0, 10, 20, 30], width: 30, height: 10 };
  await renderPdfTextLayer({ container: layer, viewport: createPdfViewport(view, { userUnit: 2, rotation: 90 }), textContentSource: { items: [item] } });
  expect(layer.children[0].style).toMatchObject({ left: '40px', top: '20px', fontSize: '20px', transform: 'matrix(0,5,-1,0,0,0)' });
  expect(item.transform).toEqual([10, 0, 0, 10, 20, 30]);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
it('projects OCR source-unit boxes at display zoom without applying the page unit twice', () => {
  const { layer } = authoredLayer(), item = { str: 'Authored', transform: [0, 5, -5, 0, 25, 25], width: 10, height: 5 };
  renderPdfOcrTextLayer({ querySelector: () => layer }, [item], createPdfViewport(view, { userUnit: 2, rotation: 90 }), view);
  expect(layer.children[0].style).toMatchObject({ left: '10px', top: '20px', fontSize: '10px', transform: 'rotate(0rad) scaleX(1.6666666666666667)' });
});
it('keeps fit dimensions physical and public zoom unmultiplied while carrying CSS scale metadata', () => {
  const fitted = getPdfPageViewport({ width: 200, height: 100, rotation: 0, userUnit: 2 }, {}, { width: 1040, height: 740 });
  expect(fitted).toEqual({ width: 1000, height: 500, scale: 5, rotation: 0, userUnit: 2 });
  for (const apply of [applyPageViewportStyles, applyPdfViewportToPageElement]) {
    const values = {}, page = { style: { setProperty: (key, value) => { values[key] = value; } } };
    apply(page, { width: 300, height: 150, scale: 1.5, userUnit: 2 });
    expect(values['--total-scale-factor']).toBe('3'); expect(page.style.width).toBe('300px');
  }
  expect(getPdfPageViewport({ width: 200, height: 100 }, {}, { width: 1040, height: 740 })).toEqual({ width: 1000, height: 500, scale: 5, rotation: 0 });
});
