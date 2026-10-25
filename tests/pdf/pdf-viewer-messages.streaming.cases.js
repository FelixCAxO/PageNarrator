import { loadViewer, cleanupViewerDom, installViewerDom, installChromeRuntime, createFakePdfDocument, sendViewerMessage } from "./pdf-viewer-messages.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PDF viewer message API', () => {
  afterEach(cleanupViewerDom);

  it('answers PDF metadata without walking the whole book before narration', async () => {
    vi.resetModules();
    await installViewerDom();
    const { listeners } = installChromeRuntime();
    const pdf = createFakePdfDocument(Array.from({ length: 100 }, () => 'A complete page of readable book text.'));
    const getPage = vi.spyOn(pdf, 'getPage');
    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdf) }),
      TextLayer: class TestTextLayer { async render() {} },
    }));

    await loadViewer();
    await sendViewerMessage(listeners[0], { type: 'getReadingStart' });
    getPage.mockClear();
    const metadata = await sendViewerMessage(listeners[0], { type: 'getPdfStreamMetadata' });

    expect(getPage).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({ ok: true, pageCount: 100, totalReadableWordCount: 0 });
  });

  it('streams PDF speech chunks from the viewer-owned PDF.js document', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve(createFakePdfDocument([
        'First page text',
        'Second page text for narration',
      ])),
    }));

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument,
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await loadViewer();
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="2"]')).toBeTruthy();
    });

    const metadata = await sendViewerMessage(listeners[0], { type: 'getPdfStreamMetadata' });
    expect(metadata).toEqual({
      ok: true,
      title: 'book',
      url: 'https://example.test/book.pdf',
      pageCount: 2,
      totalReadableWordCount: 0,
      instanceToken: expect.any(String),
    });

    const firstChunk = await sendViewerMessage(listeners[0], {
      type: 'getPdfChunk',
      streamId: 'viewer-stream',
      instanceToken: metadata.instanceToken,
      startPage: 2,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
    });
    expect(firstChunk).toMatchObject({
      ok: true,
      done: false,
      value: {
        type: 'pdf-page',
        speech: 'Second page text for narration.',
        text: 'Second page text for narration.',
        pageNumber: 2,
        anchorId: 'pdf-page-2',
      },
    });

    const end = await sendViewerMessage(listeners[0], {
      type: 'getPdfChunk',
      streamId: 'viewer-stream',
      instanceToken: metadata.instanceToken,
      startPage: 2,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
    });
    expect(end).toEqual({ ok: true, done: true });
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ enableScripting: false }));
  });

  it('returns batched PDF speech chunks when the toolbar player requests lookahead', async () => {
    vi.resetModules();
    const dom = await installViewerDom();
    const { listeners } = installChromeRuntime();

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({
        promise: Promise.resolve(createFakePdfDocument([
          'First page text',
          'Second page text',
          'Third page text',
        ])),
      }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await loadViewer();
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-page-number="3"]')).toBeTruthy();
    });

    const metadata = await sendViewerMessage(listeners[0], { type: 'getPdfStreamMetadata' });
    const response = await sendViewerMessage(listeners[0], {
      type: 'getPdfChunk',
      streamId: 'viewer-lookahead-stream',
      instanceToken: metadata.instanceToken,
      startPage: 1,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
      count: 2,
      maxChunks: 2,
    });

    expect(response).toMatchObject({
      ok: true,
      done: false,
      chunks: [
        { speech: 'First page text.', pageNumber: 1, anchorId: 'pdf-page-1' },
        { speech: 'Second page text.', pageNumber: 2, anchorId: 'pdf-page-2' },
      ],
    });
  });

  it('rejects stale PDF stream instance tokens', async () => {
    vi.resetModules();
    await installViewerDom();
    const { listeners } = installChromeRuntime();

    vi.doMock('../../src/pdf/pdf-engine.js', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({
        promise: Promise.resolve(createFakePdfDocument(['First page text'])),
      }),
      TextLayer: class TestTextLayer {
        async render() {}
      },
    }));

    await loadViewer();

    const response = await sendViewerMessage(listeners[0], {
      type: 'getPdfChunk',
      streamId: 'viewer-stream',
      instanceToken: 'old-viewer-load',
      startPage: 1,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
    });

    expect(response).toEqual({
      ok: false,
      error: 'PDF viewer stream is stale. Please restart reading this PDF.',
      code: 'stale_pdf_stream',
    });
  });
});
