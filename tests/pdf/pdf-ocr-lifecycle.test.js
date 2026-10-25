import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPdfOcrUnwarp } from '../../src/lib/pdf-ocr-unwarp.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), dispose: vi.fn(async () => null), detect: vi.fn(), recognize: vi.fn() }));
vi.mock('../../src/engines/browser-inference.js', () => ({
  createBrowserInferenceEngine: () => ({ InferenceSession: { create: mocks.create }, Tensor: class {}, dispose: mocks.dispose }),
}));
vi.mock('../../src/lib/pdf-ocr-detector.js', () => ({
  detectPdfOcrLines: mocks.detect, recognizePdfOcrDetectedLines: mocks.recognize,
}));

beforeEach(() => {
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    fillRect() {}, drawImage() {}, getImageData: (x, y, width, height) => ({ data: new Uint8Array(width * height * 4) }),
  }) }) });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ['', 'a', ' '] })));
  mocks.detect.mockResolvedValue([{}]);
  mocks.recognize.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const runtime = { getURL: path => path };

it.each(['recognition', 'correction'])('releases disabled neural sessions after %s fails and keeps subsequent fallback work cheap', async stage => {
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  const correction = { release: vi.fn(async () => {}), run: vi.fn(async () => { throw new Error('GPU device lost'); }) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  if (stage === 'correction') {
    mocks.detect.mockResolvedValue(Array.from({ length: 20 }, () => ({})));
    mocks.create.mockResolvedValueOnce(correction);
  } else mocks.recognize.mockRejectedValueOnce(new Error('GPU device lost'));
  const unwarp = createPdfOcrUnwarp(runtime);
  expect(await unwarp.retry({ width: 20, height: 20 }, null, { left: 0, top: 0, right: 20, bottom: 20 })).toBeNull();
  await vi.waitFor(() => expect(detector.release).toHaveBeenCalledTimes(1));
  expect(detector.release).toHaveBeenCalledTimes(1);
  expect(recognizer.release).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(correction.release).toHaveBeenCalledTimes(stage === 'correction' ? 1 : 0);
  expect(await unwarp.retry({}, null, {})).toBeNull();
  await Promise.all([unwarp.destroy(), unwarp.destroy()]);
  expect(mocks.create).toHaveBeenCalledTimes(stage === 'correction' ? 3 : 2);
  expect(detector.release).toHaveBeenCalledTimes(1);
  expect(recognizer.release).toHaveBeenCalledTimes(1);
});

it('attempts every neural session release even when one release fails', async () => {
  const failure = new Error('Detector release failed');
  const detector = { release: vi.fn(async () => { throw failure; }) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  const unwarp = createPdfOcrUnwarp(runtime);
  expect(await unwarp.retry({}, null, {})).toEqual([]);
  await expect(unwarp.destroy()).rejects.toBe(failure);
  expect(detector.release).toHaveBeenCalledTimes(1);
  expect(recognizer.release).toHaveBeenCalledTimes(1);
  await expect(unwarp.destroy()).rejects.toBe(failure);
  expect(recognizer.release).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});

it('waits for active neural inference before releasing its sessions', async () => {
  let complete;
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  mocks.recognize.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const unwarp = createPdfOcrUnwarp(runtime);
  const inference = unwarp.retry({}, null, {});
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  const closing = unwarp.destroy();
  expect(detector.release).not.toHaveBeenCalled();
  expect(recognizer.release).not.toHaveBeenCalled();
  complete([]);
  await inference;
  await closing;
  expect(detector.release).toHaveBeenCalledTimes(1);
  expect(recognizer.release).toHaveBeenCalledTimes(1);
});

it('falls back without waiting for native release while explicit close still waits', async () => {
  let completeRelease, returned = false, closed = false;
  const detector = { release: vi.fn(() => new Promise(resolve => { completeRelease = resolve; })) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  mocks.recognize.mockRejectedValueOnce(new Error('GPU device lost'));
  const unwarp = createPdfOcrUnwarp(runtime);
  const inference = unwarp.retry({}, null, {}).then(result => { returned = true; return result; });
  try {
    await vi.waitFor(() => expect(completeRelease).toBeTypeOf('function'));
    expect(returned).toBe(true);
    expect(await inference).toBeNull();
    const closing = unwarp.destroy().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    completeRelease();
    await closing;
    expect(detector.release).toHaveBeenCalledTimes(1);
    expect(recognizer.release).toHaveBeenCalledTimes(1);
  } finally { completeRelease?.(); await inference; await unwarp.destroy(); }
});

it.each(['empty-cache', 'detector-only', 'no-gpu', 'closed'])('does not load crop sessions when %s prevents cached GPU reuse', async state => {
  const requestAdapter = vi.spyOn(navigator.gpu, 'requestAdapter');
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  const unwarp = createPdfOcrUnwarp(runtime);
  if (state === 'detector-only') mocks.detect.mockResolvedValueOnce([]);
  if (state !== 'empty-cache') await unwarp.retry({ width: 20, height: 20 }, null, {});
  if (state === 'no-gpu') vi.stubGlobal('navigator', {});
  if (state === 'closed') await unwarp.destroy();
  const counts = [requestAdapter.mock.calls.length, mocks.create.mock.calls.length,
    fetch.mock.calls.length, mocks.detect.mock.calls.length, mocks.recognize.mock.calls.length];
  expect(await unwarp.recognizeCrop({ width: 1299, height: 112 }, null)).toBeNull();
  expect([requestAdapter.mock.calls.length, mocks.create.mock.calls.length,
    fetch.mock.calls.length, mocks.detect.mock.calls.length, mocks.recognize.mock.calls.length]).toEqual(counts);
  await unwarp.destroy();
});

it('reuses cached primary sessions and gives each source crop a fresh four-line independent budget', async () => {
  const requestAdapter = vi.spyOn(navigator.gpu, 'requestAdapter');
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  const unwarp = createPdfOcrUnwarp(runtime);
  await unwarp.retry({ width: 20, height: 20 }, null, {});
  const engine = mocks.detect.mock.calls[0][1];
  const line = { bbox: { x0: 0, y0: 0, x1: 50, y1: 20 }, words: [
    { text: 'goa/s', confidence: 97, bbox: { x0: 0, y0: 0, x1: 50, y1: 20 } },
  ] };
  const primary = { blocks: [{ paragraphs: [{ lines: [line] }] }] };
  const worker = { recognizeLine: vi.fn(async () => primary), recognize: vi.fn() };
  const source = { width: 1299, height: 112 };
  mocks.recognize.mockImplementation(async (image, ort, det, rec, alphabet, cancelled, boxes, verify) => {
    expect(image).toBe(source); expect(ort).toBe(engine); expect(det).toBe(detector); expect(rec).toBe(recognizer);
    expect(alphabet).toEqual(['', 'a', ' ']); expect(cancelled()).toBe(false); expect(boxes).toEqual([{}]);
    for (let i = 0; i < 6; i++) expect(await verify({ width: 60, height: 40 }, primary)).toBe(primary);
    expect(verify.spacingRemaining()).toBe(false);
    return [line];
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await unwarp.recognizeCrop(source, Promise.resolve(worker));
      expect(result).toEqual({ data: primary });
      expect(mocks.detect).toHaveBeenLastCalledWith(source, engine, detector, 1280);
      expect(worker.recognizeLine).toHaveBeenCalledTimes((i + 1) * 4);
    }
    mocks.detect.mockResolvedValueOnce([]); mocks.recognize.mockResolvedValueOnce([]);
    expect(await unwarp.recognizeCrop(source, Promise.resolve(worker)))
      .toEqual({ data: { blocks: [{ paragraphs: [{ lines: [] }] }] } });
    expect(worker.recognize).not.toHaveBeenCalled();
    expect(worker.recognizeLine).toHaveBeenCalledTimes(8);
    expect(requestAdapter).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls.map(([url]) => url)).toEqual(['assets/ocr/tiny-det.onnx', 'assets/ocr/small-rec.onnx']);
    expect([source.width, source.height]).toEqual([1299, 112]);
  } finally { await unwarp.destroy(); }
  expect(detector.release).toHaveBeenCalledTimes(1); expect(recognizer.release).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});

it.each(['detection', 'recognition'])('disables failed cached crop %s and releases each owner once', async stage => {
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  const unwarp = createPdfOcrUnwarp(runtime);
  await unwarp.retry({ width: 20, height: 20 }, null, {});
  (stage === 'detection' ? mocks.detect : mocks.recognize).mockRejectedValueOnce(new Error('GPU device lost'));
  expect(await unwarp.recognizeCrop({ width: 1299, height: 112 }, null)).toBeNull();
  expect(await unwarp.recognizeCrop({ width: 1299, height: 112 }, null)).toBeNull();
  await Promise.all([unwarp.destroy(), unwarp.destroy()]);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.detect).toHaveBeenCalledTimes(2);
  expect(mocks.recognize).toHaveBeenCalledTimes(stage === 'detection' ? 1 : 2);
  expect(detector.release).toHaveBeenCalledTimes(1); expect(recognizer.release).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});

it.each(['detection', 'recognition'])('waits for cached crop %s before close and discards its late result', async stage => {
  let complete;
  const detector = { release: vi.fn(async () => {}) };
  const recognizer = { release: vi.fn(async () => {}) };
  mocks.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(recognizer);
  const unwarp = createPdfOcrUnwarp(runtime);
  await unwarp.retry({ width: 20, height: 20 }, null, {});
  (stage === 'detection' ? mocks.detect : mocks.recognize)
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const inference = unwarp.recognizeCrop({ width: 1299, height: 112 }, null);
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  const closing = unwarp.destroy();
  expect(detector.release).not.toHaveBeenCalled(); expect(recognizer.release).not.toHaveBeenCalled();
  if (stage === 'recognition') expect(mocks.recognize.mock.calls.at(-1)[5]()).toBe(true);
  complete([]);
  expect(await inference).toBeNull();
  await closing;
  expect(mocks.recognize).toHaveBeenCalledTimes(stage === 'detection' ? 1 : 2);
  expect(detector.release).toHaveBeenCalledTimes(1); expect(recognizer.release).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});
