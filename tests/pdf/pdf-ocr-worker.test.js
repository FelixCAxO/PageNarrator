import { afterEach, expect, it, vi } from 'vitest';
import { createPdfOcr } from '../../src/lib/pdf-ocr.js';
import { createPdfOcrWorker } from '../../src/lib/pdf-ocr-worker-client.js';
import { JSDOM } from 'jsdom';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { renderPdfOcrTextLayer } from '../../src/lib/pdf-ocr-text-layer.js';

vi.mock('../../src/lib/pdf-ocr-worker-client.js', () => ({ createPdfOcrWorker: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

function stubRasterCanvases() {
  const canvases = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4).fill(255) }) }) };
    canvases.push(canvas); return canvas;
  } });
  return canvases;
}

it('reads three separated landscape panels in column order using one bounded OCR worker', async () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 24; y < 216; y += 2) for (let x = 15; x < 225; x++) {
    if (!(x >= 77 && x <= 83) && !(x >= 157 && x <= 163)) pixels[(y * 240 + x) * 4] = 0;
  }
  vi.stubGlobal('navigator', {});
  const canvases = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) };
    canvases.push(canvas);return canvas;
  } });
  let calls = 0;
  const worker = { recognize: vi.fn(async canvas => {
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000);
    const text = ['Left panel.', 'Middle panel.', 'Right panel.'][calls++];
    return { data: { blocks: [{ paragraphs: [{ lines: [{ words: [{ text, bbox: { x0: 30, y0: 60, x1: 180, y1: 90 } }] }] }] }] } };
  }), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const page = { pageNumber: 1, render: vi.fn(() => ({ promise: Promise.resolve() })),
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 400 * scale,
      convertToPdfPoint: (x, y) => [x / scale, 400 - y / scale] }),
  };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    const items = await ocr.recognizePage(page);
    expect(createPdfPageModel(items, { pageView: [0, 0, 600, 400] }).speech).toBe('Left panel. Middle panel. Right panel.');
    expect(items.map(item => item.transform[4])).toEqual([10, 211, 411]);
    expect(createPdfOcrWorker).toHaveBeenCalledTimes(1);
    expect(worker.recognize).toHaveBeenCalledTimes(3);
    expect(page.render).toHaveBeenCalledTimes(4);
    expect(await ocr.recognizePage(page)).toBe(items);
    expect(worker.recognize).toHaveBeenCalledTimes(3);
  } finally { await ocr.destroy(); }
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it.each([0, 90, 180, 270])('preserves selectable source text inside OCR guesses and the cached highlight layer at %i degrees', async rotate => {
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4).fill(255) }) }) }) });
  const worker = { recognize: vi.fn(async () => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words: [
    { text: 'Wrong', bbox: { x0: 30, y0: 60, x1: 50, y1: 90 } },
    { text: 'guess', bbox: { x0: 50, y0: 60, x1: 90, y1: 90 } },
    { text: 'outside', bbox: { x0: 120, y0: 60, x1: 180, y1: 90 } },
  ] }] }] }] } })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const transforms = { 0: [10, 0, 0, 10, 10, 270], 90: [0, 10, -10, 0, 30, 10],
    180: [-10, 0, 0, -10, 190, 30], 270: [0, -10, 10, 0, 170, 290] };
  const native = { str: 'Source text', transform: transforms[rotate], width: 20, height: 10 };
  const page = { pageNumber: 1, rotate, getTextContent: vi.fn(async () => ({ items: [native] })),
    render: () => ({ promise: Promise.resolve() }), getViewport: ({ scale }) => ({
      width: (rotate === 90 || rotate === 270 ? 300 : 200) * scale,
      height: (rotate === 90 || rotate === 270 ? 200 : 300) * scale,
      convertToPdfPoint: (x, y) => rotate === 0 ? [x / scale, 300 - y / scale]
        : rotate === 90 ? [y / scale, x / scale] : rotate === 180 ? [200 - x / scale, y / scale]
          : [200 - y / scale, 300 - x / scale],
    }) };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    const items = await ocr.recognizePage(page);
    expect(items.map(item => item.str)).toEqual(['Source text', 'outside']);
    expect(items[0]).toEqual({ ...native, ocrLine: 0 });
    expect(createPdfPageModel(items, { pageView: [0, 0, 200, 300], pageRotation: rotate }).speech).toBe('Source text outside.');
    expect(ocr.getItems(1)).toBe(items);
    expect(await ocr.recognizePage(page)).toBe(items);
    expect(page.getTextContent).toHaveBeenCalledTimes(1);
    expect(worker.recognize).toHaveBeenCalledTimes(1);
  } finally { await ocr.destroy(); }
});

it.each([90, 180, 270])('keeps OCR word boxes upright on an intrinsic %i-degree page', async rotate => {
  const canvas = { getContext: () => ({ drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4).fill(255) }) }) };
  vi.stubGlobal('document', { createElement: () => ({ ...canvas }) });
  vi.stubGlobal('navigator', {});
  const worker = { recognize: vi.fn(async () => ({ data: { blocks: [{ paragraphs: [{ lines: [
    { words: [{ text: 'Hello', bbox: { x0: 30, y0: 60, x1: 90, y1: 90 } }] },
  ] }] }] } })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const getViewport = ({ scale }) => ({ scale,
    width: (rotate === 180 ? 200 : 300) * scale,
    height: (rotate === 180 ? 300 : 200) * scale,
    transform: rotate === 90 ? [0, scale, scale, 0, 0, 0]
      : rotate === 180 ? [-scale, 0, 0, scale, 200 * scale, 0] : [0, -scale, -scale, 0, 300 * scale, 200 * scale],
    convertToPdfPoint: (x, y) => rotate === 90 ? [y / scale, x / scale]
      : rotate === 180 ? [200 - x / scale, y / scale] : [200 - y / scale, 300 - x / scale],
    convertToViewportPoint: (x, y) => rotate === 90 ? [y * scale, x * scale]
      : rotate === 180 ? [(200 - x) * scale, y * scale] : [(300 - y) * scale, (200 - x) * scale],
  });
  const page = { pageNumber: 1, rotate, getViewport, render: () => ({ promise: Promise.resolve() }) };
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  const dom = new JSDOM('<section><div class="textLayer"></div></section>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({ width: 20 }) });
  try {
    const items = await ocr.recognizePage(page);
    const pageView = [0, 0, 200, 300];
    const model = createPdfPageModel(items, { pageView, pageRotation: rotate });
    expect(model.speech).toBe('Hello.');
    expect(model.orderedItems[0]).toMatchObject({ x: 10, width: 20, height: 10 });
    const section = dom.window.document.querySelector('section');
    renderPdfOcrTextLayer(section, items, getViewport({ scale: 1 }), pageView);
    const span = section.querySelector('span');
    expect(parseFloat(span.style.left)).toBeCloseTo(10);
    expect(parseFloat(span.style.top)).toBeCloseTo(20);
    expect(span.style.transform).toBe('rotate(0rad) scaleX(1)');
    expect(span.getAttribute('data-pagenarrator-pdf-narrated')).toBe('true');
    expect(section.querySelector('.textLayer').getAttribute('data-pagenarrator-pdf-text')).toBe('Hello.');
  } finally { await ocr.destroy(); dom.window.close(); }
});

it('recovers after a page deadline with a fresh worker and no poisoned queue', async () => {
  vi.useFakeTimers();
  const canvases = stubRasterCanvases();
  const stalled = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn() };
  const recovered = { recognize: vi.fn(async () => ({ data: { blocks: [] } })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValueOnce(stalled).mockResolvedValueOnce(recovered);
  const ocr = createPdfOcr({ runtime: { getURL: (path) => path } });
  const page = { pageNumber: 1, getViewport: () => ({ width: 100, height: 200 }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
  const failed = ocr.recognizePage(page).then(() => null, error => error);
  try {
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await failed).toMatchObject({ cause: expect.objectContaining({ message: 'PDF OCR timed out.' }) });
    expect(stalled.terminate).toHaveBeenCalledTimes(1);
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
    await expect(ocr.recognizePage(page)).resolves.toEqual([]);
    expect(createPdfOcrWorker).toHaveBeenCalledTimes(2);
    expect(createPdfOcrWorker.mock.calls[1][0].runtime.getURL('native/ocr-engine.wasm')).toBe('native/ocr-engine.wasm');
  } finally { await ocr.destroy(); await failed; }
});

it('rerenders suspicious ordinary CPU text from fresh bounded source pixels and maps retry geometry', async () => {
  vi.stubGlobal('navigator', {});
  stubRasterCanvases();
  const original = { x0: 30, y0: 60, x1: 90, y1: 90 };
  const data = (text, bbox) => ({ data: { blocks: [{ paragraphs: [{ lines: [{ bbox, words: [{ text, confidence: 95, bbox }] }] }] }] } });
  const worker = { recognize: vi.fn().mockResolvedValueOnce(data('goa/s', original))
    .mockResolvedValueOnce(data('goals', { x0: 30, y0: 30, x1: 120, y1: 75 })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const page = { pageNumber: 1, render: vi.fn(() => ({ promise: Promise.resolve() })),
    getViewport: ({ scale }) => ({ width: 100 * scale, height: 200 * scale, convertToPdfPoint: (x, y) => [x / scale, 200 - y / scale] }) };
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    expect(await reader.recognizePage(page)).toEqual([expect.objectContaining({ str: 'goals', width: 20, height: 10 })]);
    expect(worker.recognize.mock.calls.map(([, options]) => options.mode)).toEqual(['page', 'crop']);
    expect(page.render).toHaveBeenCalledTimes(2);
    expect(page.render.mock.calls[1][0].viewport.width).toBe(450);
  } finally { await reader.destroy(); }
});

it('bounds raster memory, uses local assets, cancels active OCR and releases its canvas', async () => {
  const canvases = stubRasterCanvases();
  const worker = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const ocr = createPdfOcr({ runtime: { getURL: (path) => `chrome-extension://test/${path}` } });
  const page = { pageNumber: 1,
    getViewport: ({ scale }) => ({ width: 10000 * scale, height: 10000 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  };
  const result = ocr.recognizePage(page).then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
    expect(canvases[0].width * canvases[0].height).toBeGreaterThan(0);
    expect(canvases[0].width * canvases[0].height).toBeLessThanOrEqual(4_000_000);
    expect(createPdfOcrWorker.mock.calls[0][0].runtime.getURL('native/ocr-engine.wasm')).toBe('chrome-extension://test/native/ocr-engine.wasm');
    await ocr.destroy();
    expect(await result).toMatchObject({ message: expect.stringContaining('Could not recognize PDF page 1') });
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
    expect(worker.terminate).toHaveBeenCalled();
    await expect(ocr.recognizePage(page)).rejects.toThrow('closed');
  } finally { await ocr.destroy(); await result; }
});

it('reuses OCR word boxes and bounds the cache to twelve pages', async () => {
  const canvases = stubRasterCanvases();
  const worker = { recognize: vi.fn(async () => ({ data: { blocks: [{ paragraphs: [{ lines: [
    { words: [{ text: 'Hello', bbox: { x0: 30, y0: 60, x1: 90, y1: 90 } }] },
  ] }] }] } })), terminate: vi.fn() };
  createPdfOcrWorker.mockResolvedValue(worker);
  const ocr = createPdfOcr({ runtime: { getURL: (path) => path } });
  const page = (pageNumber) => ({ pageNumber,
    getViewport: ({ scale }) => ({ width: 100 * scale, height: 200 * scale,
      convertToPdfPoint: (x, y) => [x / scale, 200 - y / scale] }),
    render: () => ({ promise: Promise.resolve() }),
  });
  const items = await ocr.recognizePage(page(1));
  expect(items[0]).toMatchObject({ str: 'Hello', ocrLine: 0, width: 20, height: 10 });
  expect(await ocr.recognizePage(page(1))).toBe(items);
  expect(worker.recognize).toHaveBeenCalledTimes(1);
  expect(worker.recognize).toHaveBeenCalledWith(canvases[0], { mode: 'page' });
  for (let n = 2; n <= 13; n++) await ocr.recognizePage(page(n));
  expect(ocr.getItems(1)).toBeUndefined();
  expect(ocr.hasPage(1)).toBe(true);
  expect(ocr.getItems(13)).toHaveLength(1);
  await ocr.destroy();
  expect(ocr.getItems(13)).toBeUndefined();
});
