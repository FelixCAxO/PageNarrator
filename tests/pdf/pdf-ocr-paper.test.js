import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPdfOcrPaperSourceCrop } from '../../src/lib/pdf-ocr-paper.js';
import * as paperGeometry from '../../src/lib/pdf-ocr-paper.js';
import { mapPdfOcrRetryLines } from '../../src/lib/pdf-ocr-retry.js';
import { createPdfOcr } from '../../src/lib/pdf-ocr.js';

const mocks = vi.hoisted(() => ({ paper: vi.fn(), worker: vi.fn() }));
vi.mock('../../src/lib/pdf-ocr-worker-client.js', () => ({ createPdfOcrWorker: mocks.worker }));
vi.mock('../../src/lib/pdf-ocr-unwarp.js', () => ({ findOcrPaperInPixels: mocks.paper,
  createPdfOcrUnwarp: () => ({ retry: async () => { await globalThis.navigator?.gpu?.requestAdapter?.(); return null; }, destroy: async () => {} }) }));
const full = { left: 0, top: 0, right: 1, bottom: 1 };
const paper = { left: .3, top: .2, right: .75, bottom: .8 };
const bbox = { x0: 100, y0: 150, x1: 300, y1: 200 };
const line = { bbox, baseline: { x0: 100, y0: 195, x1: 300, y1: 200 }, words: [{ text: 'Paper', confidence: 95, bbox }] };
const result = lines => ({ data: { blocks: [{ paragraphs: [{ lines }] }] } });
let canvases, worker, renders;
beforeEach(() => {
  vi.resetAllMocks(); canvases = []; renders = [];
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ canvas, drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4) }) }) };
    canvases.push(canvas); return canvas;
  } });
  mocks.paper.mockReturnValue(paper);
  worker = { recognize: vi.fn(async () => result([line])), terminate: vi.fn(async () => {}) };
  mocks.worker.mockResolvedValue(worker);
});
afterEach(() => vi.unstubAllGlobals());
const page = () => ({ pageNumber: 1, getViewport: ({ scale }) => ({ width: 500 * scale, height: 1000 * scale,
  scale, convertToPdfPoint: (x, y) => [x / scale, y / scale] }),
render: request => { renders.push({ ...request, width: request.canvasContext.canvas.width, height: request.canvasContext.canvas.height }); return { promise: Promise.resolve() }; } });

it('bounds source sampling and exactly inverts crop coordinates, including tilted baselines', () => {
  const crop = getPdfOcrPaperSourceCrop(paper, 6000, 8000, .5);
  expect(Math.floor(crop.width * crop.factor) * Math.floor(crop.height * crop.factor)).toBeLessThanOrEqual(4_000_000);
  expect(crop.factor * .5).toBeLessThanOrEqual(3);
  const mapped = mapPdfOcrRetryLines([line], crop, crop.factor)[0];
  for (const key of ['bbox', 'baseline']) for (const [name, value] of Object.entries(line[key])) {
    expect(mapped[key][name]).toBe(value / crop.factor + (name[0] === 'x' ? crop.left : crop.top));
  }
  for (const unsafe of [null, full, { ...paper, right: Infinity }, { ...paper, left: -.1 }, { ...paper, bottom: .1 }, { left: .4, top: .4, right: .41, bottom: .41 }]) {
    expect(getPdfOcrPaperSourceCrop(unsafe, 600, 800, 2)).toBeNull();
  }
});

it('renders original paper source once, maps text back, caches it and clears both rasters', async () => {
  const reader = createPdfOcr({ runtime: { getURL: path => path } }), source = page();
  try {
    const words = await reader.recognizePage(source), scale = renders[0].viewport.scale;
    const crop = getPdfOcrPaperSourceCrop(paper, renders[0].width, renders[0].height, scale);
    expect(renders).toHaveLength(2); expect(worker.recognize).toHaveBeenCalledOnce();
    expect(renders[1].viewport.scale).toBe(scale * crop.factor);
    expect(renders[1].transform).toEqual([1, 0, 0, 1, -crop.left * crop.factor, -crop.top * crop.factor]);
    expect(renders[1].width * renders[1].height).toBeLessThanOrEqual(4_000_000);
    expect(words[0].str).toBe('Paper');
    expect(words[0].transform[4]).toBeCloseTo((bbox.x0 / crop.factor + crop.left) / scale, 12);
    expect(words[0].transform[5]).toBeCloseTo((bbox.y1 / crop.factor + crop.top) / scale, 12);
    expect(await reader.recognizePage(source)).toBe(words); expect(renders).toHaveLength(2);
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
  } finally { await reader.destroy(); }
});

it('keeps absent or unsafe paper bounds on the original whole-page path', async () => {
  mocks.paper.mockReturnValue(full);
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try { expect((await reader.recognizePage(page()))[0].str).toBe('Paper'); expect(renders).toHaveLength(1); expect(worker.recognize).toHaveBeenCalledOnce(); }
  finally { await reader.destroy(); }
});

it('uses the CPU source crop when WebGPU is exposed but its adapter is unavailable', async () => {
  const requestAdapter = vi.fn(async () => null);
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    expect((await reader.recognizePage(page()))[0].str).toBe('Paper');
    expect(requestAdapter).toHaveBeenCalledOnce(); expect(worker.recognize).toHaveBeenCalledOnce();
    expect(mocks.paper).toHaveBeenLastCalledWith(expect.any(Uint8ClampedArray), { photographOnly: true });
    expect(renders).toHaveLength(3);
    expect(renders.at(-1).width * renders.at(-1).height).toBeLessThanOrEqual(4_000_000);
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
  } finally { await reader.destroy(); }
});

it('falls back to the original whole page if the bounded paper produced no text', async () => {
  worker.recognize.mockResolvedValueOnce(result([]));
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try { expect((await reader.recognizePage(page()))[0].str).toBe('Paper'); expect(worker.recognize).toHaveBeenCalledTimes(2); }
  finally { await reader.destroy(); }
});

it('cancels an in-flight source render before recognition and releases crop pixels', async () => {
  const source = page(), original = source.render;
  source.render = request => renders.length ? (original(request), { promise: new Promise(() => {}), cancel: vi.fn() }) : original(request);
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  const active = expect(reader.recognizePage(source)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'PDF OCR has been closed.' }) });
  await vi.waitFor(() => expect(renders).toHaveLength(2));
  await reader.destroy(); await active;
  expect(worker.recognize).not.toHaveBeenCalled(); expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it('uses the actual integer preview raster for both GPU and CPU paper renders on fractional viewports', async () => {
  mocks.paper.mockReturnValue({ left: .25, top: .25, right: .75, bottom: .75 });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn(async () => null) } });
  const source = page();
  source.getViewport = ({ scale }) => ({ width: 333.6 * scale, height: 777.6 * scale,
    scale, convertToPdfPoint: (x, y) => [x / scale, y / scale] });
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    await reader.recognizePage(source);
    expect(renders).toHaveLength(3);
    expect([renders[0].width, renders[0].height]).toEqual([1000, 2332]);
    expect([renders[1].width, renders[1].height]).toEqual([516, 1182]);
    expect([renders[2].width, renders[2].height]).toEqual([516, 1182]);
    expect(renders[1].transform).toEqual(renders[2].transform);
    expect(worker.recognize).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
  } finally { await reader.destroy(); }
});

it('preserves the full-frame GPU attempt when CPU bounded-paper admission rejects full bounds', async () => {
  mocks.paper.mockReturnValue(full);
  const requestAdapter = vi.fn(async () => null);
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    await reader.recognizePage(page());
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(renders).toHaveLength(2);
    expect([renders[1].width, renders[1].height]).toEqual([renders[0].width, renders[0].height]);
    expect(renders[1].transform).toEqual([1, 0, 0, 1, -0, -0]);
    expect(worker.recognize).toHaveBeenCalledOnce();
  } finally { await reader.destroy(); }
});

it('binds each GPU gutter crop to the initial raster and its actual integer region render offset', async () => {
  const pixels = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  for (let y = 24; y < 216; y += 2) for (let x = 30; x < 210; x++)
    if (x < 119 || x > 122) pixels[(y * 240 + x) * 4] = 0;
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ canvas, drawImage() {}, getImageData: () => ({ data: pixels }) }) };
    canvases.push(canvas); return canvas;
  } });
  mocks.paper.mockReturnValue({ left: .6, top: .2, right: .8, bottom: .8 });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn(async () => null) } });
  const source = page();
  source.getViewport = ({ scale }) => ({ width: 2000 * scale, height: 1000.25 * scale,
    scale, convertToPdfPoint: (x, y) => [x / scale, y / scale] });
  const crop = vi.spyOn(paperGeometry, 'getPdfOcrPaperCrop');
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    await reader.recognizePage(source);
    expect(crop).toHaveBeenCalledTimes(2);
    const initial = renders[0], rightRegion = renders[2], offsetX = -rightRegion.transform[4];
    expect(Number.isInteger(offsetX)).toBe(true);
    expect(Number.isInteger(rightRegion.viewport.width * (121 / 240))).toBe(false);
    expect(crop.mock.calls[1]).toEqual([
      { left: .6, top: .2, right: .8, bottom: .8 }, rightRegion.width, rightRegion.height, rightRegion.viewport.scale,
      { sourceWidth: initial.width, sourceHeight: initial.height, sourceScale: initial.viewport.scale, offsetX },
    ]);
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
  } finally { crop.mockRestore(); await reader.destroy(); }
});
