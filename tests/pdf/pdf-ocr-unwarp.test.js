import { expect, it, vi } from 'vitest';
import { createPdfOcrUnwarp, findOcrPaperInPixels } from '../../src/lib/pdf-ocr-unwarp.js';

it('bounds a small shadowed neutral sheet on a colored background without trimming monochrome pages', () => {
  const data = new Uint8ClampedArray(240 * 240 * 4);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const paper = x >= 74 && x <= 172 && y >= 75 && y <= 164;
    data.set(paper ? [160, 158, 155, 255] : [175, 115, 60, 255], (y * 240 + x) * 4);
  }
  expect(findOcrPaperInPixels(data)).toEqual({ left: 70 / 240, top: 71 / 240, right: 177 / 240, bottom: 169 / 240 });
  data.fill(255);
  expect(findOcrPaperInPixels(data)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
});

it('keeps ambiguous photographed sheets on the whole-page CPU path', () => {
  const data = new Uint8ClampedArray(240 * 240 * 4);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const paper = ((x >= 30 && x < 100) || (x >= 140 && x < 210)) && y >= 40 && y < 200;
    data.set(paper ? [165, 164, 162, 255] : [175, 115, 60, 255], (y * 240 + x) * 4);
  }
  expect(findOcrPaperInPixels(data, { photographOnly: true })).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
});

it('keeps ordinary OCR available without WebGPU and refuses work after closure', async () => {
  vi.stubGlobal('navigator', {});
  const runtime = { getURL: vi.fn() };
  try {
    const unwarp = createPdfOcrUnwarp(runtime);
    expect(await unwarp.retry(null, null, null)).toBeNull();
    await unwarp.destroy();
    expect(await unwarp.retry(null, null, null)).toBeNull();
    expect(runtime.getURL).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('disables a failed model load and closes idempotently without blocking ordinary OCR', async () => {
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
  const runtime = { getURL: vi.fn(() => { throw new Error('Missing local model runtime'); }) };
  try {
    const unwarp = createPdfOcrUnwarp(runtime);
    expect(await unwarp.retry(null, null, null)).toBeNull();
    expect(await unwarp.retry(null, null, null)).toBeNull();
    await Promise.all([unwarp.destroy(), unwarp.destroy()]);
    expect(runtime.getURL).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
