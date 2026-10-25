import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getDocument } from '../../src/pdf/pdf-engine.js';
import { annotatePdfTextLayer, readPdfPageRecord } from '../../src/lib/pdf-extraction.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { tinyPdfBytes } from '../pdf/pdf-extraction.fixtures.js';
import { simplePdf, stream, show, options } from './fixtures.js';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { croppedRotatedSidewaysPdf, croppedRotatedUprightPdf } from './app-viewer-fixtures.js';
import { renderPdfTextLayer } from '../../src/pdf/browser-pdf.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('original engine app loading, routing and source association', () => {
  it.each([0, 90, 180, 270])('preserves text-layer rotation metadata without applying viewport rotation twice (%s)', async rotation => {
    const dom = new JSDOM('<div id="layer"></div>');
    try {
      const container = dom.window.document.getElementById('layer');
      vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 12 }) });
      const item = { str: 'AB', fontName: 'Original', dir: 'ltr', transform: [12, 0, 0, 12, 50, 700], width: 24, height: 12 };
      const viewport = createPdfViewport([0, 0, 612, 792], { rotation });
      await renderPdfTextLayer({ container, viewport, textContentSource: { items: [item] } });
      expect(container.dataset.mainRotation).toBe(String(rotation)); expect(container.style.transform).toBe('none');
      const span = container.querySelector('span'), [x, y] = viewport.convertToViewportPoint(50, 712);
      expect(parseFloat(span.style.left)).toBe(x); expect(parseFloat(span.style.top)).toBe(y);
      expect(span.style.transform).toBe(['matrix(2,0,0,1,0,0)', 'matrix(0,2,-1,0,0,0)', 'matrix(-2,0,0,-1,0,0)', 'matrix(0,-2,1,0,0,0)'][rotation / 90]);
    } finally { dom.window.close(); }
  });
  it.each([
    ['sideways', croppedRotatedSidewaysPdf, ''],
    ['upright', croppedRotatedUprightPdf, 'Upright cropped source.'],
  ])('preserves the existing model classification for cropped, rotated %s source against the isolated oracle', async (_name, fixture, speech) => {
    const data = fixture(), ownTask = getDocument({ data, ...options }), oracleTask = reference.getDocument({ data: data.slice(), useSystemFonts: true });
    const own = await ownTask.promise, oracle = await oracleTask.promise;
    try {
      const ownPage = await own.getPage(1), oraclePage = await oracle.getPage(1);
      const original = createPdfPageModel((await ownPage.getTextContent()).items, { pageView: ownPage.view, pageRotation: ownPage.rotate });
      const baseline = createPdfPageModel((await oraclePage.getTextContent()).items, { pageView: oraclePage.view, pageRotation: oraclePage.rotate });
      expect(original.speech).toBe(speech); expect(original.speech).toBe(baseline.speech);
      expect(original.orderedItems.map(item => item.originalIndex)).toEqual(baseline.orderedItems.map(item => item.originalIndex));
    } finally { await ownTask.destroy(); await oracleTask.destroy(); }
  });
  it('requires explicit parser configuration outside the extension instead of fetching a bundled source-path copy', async () => {
    vi.stubGlobal('chrome', undefined); const fetch = vi.fn();
    await expect(getDocument({ data: simplePdf(''), fetch }).promise).rejects.toMatchObject({ code: 'pdf_configuration' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('loads the single fixed packaged parser URL when the extension runtime supplies defaults', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: relative => `chrome-extension://original/${relative}` } });
    const fetch = vi.fn(async () => new Response(options.wasm));
    const task = getDocument({ data: simplePdf(''), loadAsset: options.loadAsset, fetch });
    try {
      expect((await task.promise).numPages).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe('chrome-extension://original/assets/pdf-engine/pdf.wasm');
    } finally { await task.destroy(); }
  });
  it.each(['known-length', 'chunked', 'decoded-gzip'])('loads bounded original URL bytes with progress for %s', async mode => {
    const data = simplePdf(show('Original URL-backed source.')), progress = [], chunks = [data.subarray(0, 31), data.subarray(31, 149), data.subarray(149)];
    const headers = new Headers(mode === 'known-length' ? { 'content-length': String(data.length) } : mode === 'decoded-gzip' ? { 'content-length': '10', 'content-encoding': 'gzip' } : {});
    const fetch = vi.fn(async () => ({ ok: true, headers, body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) }));
    const task = getDocument({ url: 'https://example.test/original.pdf', ...options, disableWorker: true, fetch }); task.onProgress = value => progress.push(value);
    const document = await task.promise;
    try {
      expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe('Original URL-backed source.');
      expect(fetch).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledWith('https://example.test/original.pdf', expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
      expect(progress.map(value => value.loaded)).toEqual([31, 149, data.length]);
      expect(progress.at(-1).total).toBe(mode === 'known-length' ? data.length : 0);
    } finally { await task.destroy(); }
  });
  it('rejects an oversized declared source before downloading the body', async () => {
    const cancel = vi.fn(async () => {}), fetch = vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-length': String(128 * 1024 * 1024 + 1) }), body: { cancel } }));
    const task = getDocument({ url: 'https://example.test/large.pdf', ...options, fetch });
    await expect(task.promise).rejects.toMatchObject({ code: 'pdf_limit' }); expect(cancel).toHaveBeenCalledTimes(1); await task.destroy();
  });
  it('cancels an outstanding loading task promptly even if an injected transport ignores abort', async () => {
    let pendingSignal; const fetch = vi.fn((_url, { signal }) => { pendingSignal = signal; return new Promise(() => {}); });
    const task = getDocument({ url: 'https://example.test/pending.pdf', ...options, fetch });
    await Promise.resolve(); const rejection = expect(task.promise).rejects.toMatchObject({ code: 'pdf_closed' });
    await task.destroy(); await rejection; expect(pendingSignal.aborted).toBe(true);
  });
  it('recovers the existing malformed extraction fixture explicitly while preserving its source bytes', async () => {
    const data = tinyPdfBytes(), saved = data.slice(), core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items.map(item => item.str)).toEqual(['Hello PDF from browser', 'Second line text']);
      expect(payload.inspection.repairFlags).toBe(3); expect(data).toEqual(saved);
    } finally { core.destroy(); }
  });
  it('rejects ambiguous malformed stream boundaries instead of choosing an arbitrary terminator', async () => {
    const contents = stream('endstream\nendobj\nBT /F1 12 Tf (unsafe) Tj ET');
    // Preserve a definite malformed Length independent of the literal content length.
    const data = simplePdf('', { contents: contents.replace(/\/Length \d+/u, '/Length 1') }), core = await createPdfDocumentCore(data, options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_corrupt' }); } finally { core.destroy(); }
  });
  it('confines stream-length repair to its indexed object and honors correctly declared marker-like data', async () => {
    const first = stream(show('first')).replace(/\/Length \d+/u, '/Length 1');
    const data = simplePdf('', { contents: first, page: '/Contents [4 0 R 6 0 R]', extra: [stream(show('endstream endobj'))] });
    const core = await createPdfDocumentCore(data, options);
    try { const payload = await core.pagePayload(1); expect(payload.items.map(item => item.str)).toEqual(['first', 'endstream endobj']); expect(payload.inspection.repairFlags).toBe(2); } finally { core.destroy(); }
  });
  it('routes original raster, vector and blank pages through their actual inspection results', async () => {
    const data = simplePdf('q 200 0 0 200 30 300 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.of(0), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8')] });
    const task = getDocument({ data, ...options, disableWorker: true }), document = await task.promise;
    try {
      const record = await readPdfPageRecord(document, 1);
      expect(record).toMatchObject({ contentKind: 'raster-image', needsOcr: true, hasImages: true });
      const recognized = await readPdfPageRecord(document, 1, { recognizePage: async () => [{ str: 'Recognized original raster text.', transform: [12, 0, 0, 12, 40, 600], width: 240, height: 12 }] });
      expect(recognized).toMatchObject({ contentKind: 'text', needsOcr: false });
    } finally { await task.destroy(); }
    for (const [content, kind] of [['0 0 20 20 re f', 'renderable-nontext'], ['', 'blank']]) {
      const loading = getDocument({ data: simplePdf(content), ...options, disableWorker: true }), pdf = await loading.promise;
      try { expect(await readPdfPageRecord(pdf, 1)).toMatchObject({ contentKind: kind, needsOcr: false }); } finally { await loading.destroy(); }
    }
  });
  it('associates multiple glyph spans with one original source item without shifting the next item', () => {
    const dom = new JSDOM('<div id="layer"><span data-pagenarrator-pdf-source-index="0">A</span><span data-pagenarrator-pdf-source-index="0">B</span><span data-pagenarrator-pdf-source-index="1">Next source item.</span></div>');
    try {
      const layer = dom.window.document.getElementById('layer'), items = [{ str: 'AB', transform: [12, 0, 0, 12, 50, 700], width: 20, height: 12 }, { str: 'Next source item.', transform: [12, 0, 0, 12, 50, 680], width: 120, height: 12 }];
      const annotated = annotatePdfTextLayer(layer, items);
      expect(annotated.map(record => record.originalIndex)).toEqual([0, 0, 1]); expect(annotated.map(record => record.order)).toEqual([0, 0, 1]);
    } finally { dom.window.close(); }
  });
});
