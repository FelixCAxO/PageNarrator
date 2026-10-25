import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Worker as NodeWorker } from 'node:worker_threads';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodePdfStream, applyPredictor } from '../../src/pdf/streams.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { pdfImageSampleBytes } from '../../src/pdf/image-limits.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());

describe('bounded large PDF image execution', () => {
  it('derives packed-row budgets and rejects excessive pixels and sample bytes', () => {
    expect(pdfImageSampleBytes(3, 2, 1, 1)).toBe(2);
    expect(pdfImageSampleBytes(5990, 4320, 3, 8)).toBe(77_630_400);
    expect(() => pdfImageSampleBytes(32_000_001, 1, 1, 8)).toThrow(/pixel budget/);
    expect(() => pdfImageSampleBytes(8000, 4000, 4, 16)).toThrow(/sample byte budget/);
    expect(() => pdfImageSampleBytes(1, 1, 3, 12)).toThrow(/not implemented/);
  });
  it('allows only declared image samples past the ordinary 32 MiB stream ceiling', async () => {
    const length = 33 * 1024 * 1024, compressed = deflateSync(new Uint8Array(length).fill(73));
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(compressed, '/Filter /FlateDecode')] }), options);
    try {
      const id = reader.checked(reader.api.pn_pdf_resolve(6, 0));
      await expect(decodePdfStream(reader, id)).rejects.toMatchObject({ code: 'pdf_limit' });
      const decoded = await decodePdfStream(reader, id, { image: true, imageSamples: { bytes: length, rows: 1 } });
      expect(decoded.bytes.length).toBe(length); expect(decoded.bytes[0]).toBe(73); expect(decoded.bytes.at(-1)).toBe(73);
      await expect(decodePdfStream(reader, id, { image: true, imageSamples: { bytes: length - 1, rows: 1 } })).rejects.toMatchObject({ code: 'pdf_limit' });
      await expect(decodePdfStream(reader, id, { imageSamples: { bytes: length, rows: 1 } })).rejects.toMatchObject({ code: 'pdf_corrupt' });
    } finally { reader.destroy(); }
  });
  it.each([2, 15])('reverses predictor %i in the owned image buffer without changing source-independent output', predictor => {
    const source = predictor === 2 ? Uint8Array.of(10, 10, 10, 20, 10, 10) : Uint8Array.of(1, 10, 10, 10, 2, 1, 2, 3);
    const expected = applyPredictor(source, { predictor, columns: 3 });
    const owned = source.slice(), actual = applyPredictor(owned, { predictor, columns: 3, inPlace: true });
    expect(actual).toEqual(expected); expect(actual.buffer).toBe(owned.buffer); expect(source).not.toEqual(expected);
  });
  it('collects each nested image/font buffer once for ownership transfer', () => {
    const bytes = Uint8Array.of(1, 2, 3), pixels = new Uint8ClampedArray(8);
    const payload = { fonts: [{ bytes }], commands: [{ op: 'group', commands: [{ op: 'image', pixels, colorProfile: bytes.subarray(1) }] }] };
    const buffers = pdfPayloadBuffers(payload); expect(buffers).toEqual([bytes.buffer, pixels.buffer]);
    const clone = structuredClone(payload, { transfer: buffers });
    expect(bytes.byteLength).toBe(0); expect(pixels.byteLength).toBe(0); expect([...clone.fonts[0].bytes]).toEqual([1, 2, 3]);
  });
  it('deduplicates actual worker payloads and recompiles intact bytes after cleanup', async () => {
    const transports = [];
    vi.stubGlobal('Worker', class {
      constructor() {
        this.requests = []; this.worker = new NodeWorker(new URL('./worker-harness.mjs', import.meta.url)); transports.push(this);
        this.worker.on('message', data => this.onmessage?.({ data })); this.worker.on('error', error => this.onerror?.(error));
      }
      postMessage(message) { this.requests.push(message.method); this.worker.postMessage(message); }
      terminate() { void this.worker.terminate(); }
    });
    vi.stubGlobal('FontFace', class {}); vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
    vi.stubGlobal('ImageData', class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } });
    const colors = [];
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { Object.assign(this, { width, height }); } getContext() { return { putImageData: value => colors.push([...value.data]) }; } });
    const data = simplePdf('q 20 0 0 20 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.of(31, 67, 109), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB')] });
    const document = await openPdfDocument(data, { wasm: options.wasm, useWorker: true });
    const context = { canvas: { width: 30, height: 30 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {}, drawImage() {} };
    try {
      const page = await document.getPage(1);
      await Promise.all([page.getTextContent(), page.inspect(), page.getTextContent()]); await page.ensureFonts();
      await page.render({ canvasContext: context, viewport: page.getViewport() }).promise;
      expect(transports[0].requests.filter(method => method === 'pagePayload')).toHaveLength(1);
      page.cleanup(); await page.render({ canvasContext: context, viewport: page.getViewport() }).promise;
      expect(transports[0].requests.filter(method => method === 'pagePayload')).toHaveLength(2);
      expect(colors).toEqual([[31, 67, 109, 255], [31, 67, 109, 255]]);
    } finally { document.destroy(); }
  });
  it('bounds temporary raster surfaces and releases them when cancellation reaches the next band', async () => {
    const width = 2000, height = 2100, surfaces = [], draws = [], written = [];
    vi.stubGlobal('ImageData', class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } });
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width, height) { Object.assign(this, { width, height }); surfaces.push(this); }
      getContext() { return { putImageData: image => written.push([image.width, image.height, image.data.length]) }; }
    });
    let task;
    const context = { canvas: { width: 100, height: 100 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {}, drawImage(...args) { draws.push(args.slice(1)); task.cancel(); } };
    task = renderPdfDisplayList({ fonts: [], commands: [{ op: 'image', width, height, matrix: [1, 0, 0, 1, 0, 0], pixels: new Uint8ClampedArray(width * height * 4) }] }, { canvasContext: context, viewport: createPdfViewport([0, 0, 100, 100]) });
    await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect(written).toEqual([[2000, 2000, 16_000_000]]); expect(draws).toHaveLength(1); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
  it('evicts resolved vector-only pages even when their binary payload byte count is zero', async () => {
    const requests = [];
    vi.stubGlobal('Worker', class {
      postMessage({ id, method, args }) {
        requests.push([method, ...args]);
        const result = method === 'open' ? { numPages: 7, metadata: {} } : method === 'pageInfo' ? { view: [0, 0, 10, 10], rotate: 0 } : method === 'pagePayload' ? { fonts: [], commands: [], items: [], inspection: {} } : null;
        queueMicrotask(() => this.onmessage?.({ data: { id, result } }));
      }
      terminate() {}
    });
    const document = await openPdfDocument(simplePdf(''), { wasm: options.wasm, useWorker: true });
    try {
      for (let number = 1; number <= 6; number++) await (await document.getPage(number)).getTextContent();
      await (await document.getPage(1)).inspect();
      expect(requests.filter(([method]) => method === 'pagePayload').map(([, number]) => number)).toEqual([1, 2, 3, 4, 5, 6, 1]);
    } finally { document.destroy(); }
  });
  it.each(['destroy', 'caller'])('releases an active image-band surface when %s cancels after the worker payload resolved', async mode => {
    const width = 2000, height = 2100, surfaces = [];
    vi.stubGlobal('Worker', class {
      postMessage({ id, method }) {
        const result = method === 'open' ? { numPages: 1, metadata: {} } : method === 'pageInfo' ? { view: [0, 0, 10, 10], rotate: 0 } : method === 'pagePayload' ? { fonts: [], items: [], commands: [{ op: 'image', width, height, matrix: [1, 0, 0, 1, 0, 0], pixels: new Uint8ClampedArray(width * height * 4) }] } : null;
        queueMicrotask(() => this.onmessage?.({ data: { id, result } }));
      }
      terminate() {}
    });
    vi.stubGlobal('FontFace', class {}); vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
    vi.stubGlobal('ImageData', class {});
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { Object.assign(this, { width, height }); surfaces.push(this); } getContext() { return { putImageData() {} }; } });
    const document = await openPdfDocument(simplePdf(''), { useWorker: true, wasm: options.wasm });
    let cancelled = false, draws = 0;
    const ctx = { canvas: { width: 10, height: 10 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {}, drawImage() { draws++; if (mode === 'destroy') document.destroy(); else cancelled = true; } };
    try {
      const page = await document.getPage(1), task = page.render({ canvasContext: ctx, viewport: page.getViewport(), shouldCancel: () => cancelled });
      await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
      expect(draws).toBe(1); expect(surfaces).toHaveLength(1); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    } finally { document.destroy(); }
  });
});
