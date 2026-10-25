// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { createPdfOcr } from '../../src/lib/pdf-ocr.js';
import { createPdfOcrWorker } from '../../src/lib/pdf-ocr-worker-client.js';

vi.mock('../../src/lib/pdf-ocr-worker-client.js', () => ({ createPdfOcrWorker: vi.fn() }));
vi.mock('../../src/lib/pdf-ocr-unwarp.js', () => ({ createPdfOcrUnwarp: () => ({ destroy: async () => {} }),
  findOcrPaperInPixels: () => ({ left: 0, top: 0, right: 1, bottom: 1 }) }));
vi.mock('../../src/lib/pdf-ocr-paper.js', () => ({ getPdfOcrPaperCrop: () => null, getPdfOcrPaperSourceCrop: () => null }));
vi.mock('../../src/lib/pdf-ocr-lines.js', () => ({ joinPdfOcrLineFragments: lines => lines, orderPdfOcrMarginalLines: lines => lines, getPdfOcrRetryRectangle: () => null }));
vi.mock('../../src/lib/pdf-ocr-retry.js', () => ({ getPdfOcrRetryCrop: () => null, mapPdfOcrRetryLines: lines => lines,
  shouldUsePdfOcrRetry: () => false, preservePdfOcrConfidentWords: (_old, lines) => lines, needsPdfOcrSourceRetry: () => false,
  preferRetriedPdfOcr: () => false, getPdfOcrSourceRetryCrop: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function authoredCanvases() {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255), canvases = [];
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) };
    canvases.push(canvas); return canvas;
  } });
  return canvases;
}
const dimensions = [[1, 20, 10], [2, 10, 5], [0.5, 40, 20]];
it.each(dimensions.flatMap(row => [0, 90, 180, 270].map(rotation => [...row, rotation])))('maps authored pixels back to raw source units for unit %s width %s height %s rotation %s', async (userUnit, width, height, rotation) => {
  const canvases = authoredCanvases(), worker = { recognize: vi.fn(async () => ({ data: { blocks: [{ paragraphs: [{ lines: [
    { words: [{ text: 'Token', bbox: { x0: 30, y0: 60, x1: 90, y1: 90 } }] },
  ] }] }] } })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const renders = [], page = { pageNumber: 1, userUnit, rotate: rotation, getTextContent: async () => ({ items: [] }),
    getViewport: settings => createPdfViewport([10, 20, 110, 70], { userUnit, rotation, ...settings }),
    render: ({ viewport }) => { renders.push(viewport); return { promise: Promise.resolve() }; } };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    const items = await ocr.recognizePage(page);
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ str: 'Token', width, height });
    expect(Math.hypot(items[0].transform[0], items[0].transform[1])).toBeCloseTo(height);
    expect(Math.hypot(items[0].transform[2], items[0].transform[3])).toBeCloseTo(height);
    if (userUnit === 2 && rotation === 90) expect(items[0].transform).toEqual([0, 5, -5, 0, 25, 25]);
    expect(renders).toHaveLength(1); expect(renders[0].scale).toBe(3); expect(renders[0].userUnit ?? 1).toBe(userUnit);
    expect(await ocr.recognizePage(page)).toBe(items); expect(worker.recognize).toHaveBeenCalledTimes(1);
  } finally { await ocr.destroy(); }
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
it('retains the existing four-million-pixel admission for a large physical page', async () => {
  const canvases = authoredCanvases(), worker = { recognize: vi.fn(async canvas => {
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000); return { data: { blocks: [] } };
  }), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const page = { pageNumber: 1, userUnit: 100, getTextContent: async () => ({ items: [] }),
    getViewport: settings => createPdfViewport([0, 0, 612, 792], { userUnit: 100, ...settings }),
    render: () => ({ promise: Promise.resolve() }) };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  try { expect(await ocr.recognizePage(page)).toEqual([]); expect(worker.recognize).toHaveBeenCalledTimes(1); }
  finally { await ocr.destroy(); }
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
it('keeps cancellation and owned canvas/worker cleanup while awaiting a scaled render', async () => {
  const canvases = authoredCanvases(), cancel = vi.fn(), worker = { recognize: vi.fn(), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const page = { pageNumber: 1, getViewport: settings => createPdfViewport([0, 0, 100, 200], { userUnit: 2, ...settings }),
    render: () => ({ promise: new Promise(() => {}), cancel }) };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  const pending = ocr.recognizePage(page).catch(error => error);
  await Promise.resolve(); await ocr.destroy();
  expect(await pending).toMatchObject({ cause: expect.objectContaining({ message: 'PDF OCR has been closed.' }) });
  expect(cancel).toHaveBeenCalledTimes(1); expect(worker.recognize).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
