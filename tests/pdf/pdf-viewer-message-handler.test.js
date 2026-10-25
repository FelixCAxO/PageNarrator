import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';
import { createPdfViewerMessageHandler } from '../../src/lib/pdf-viewer-message-handler.js';
import { createReaderEnginePageHighlightController } from '../../src/lib/reader-engine-page-highlight-controller.js';

const extensionOrigin = 'chrome-extension://test';
const trustedSender = { id: 'test', url: `${extensionOrigin}/src/reader-engine.html`, origin: extensionOrigin, frameId: 0 };

describe('PDF viewer message handler', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: {
      id: 'test',
      getURL: (path) => `${extensionOrigin}/${path}`,
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
    } });
  });

  it.each([
    ['missing metadata', {}],
    ['foreign extension', { ...trustedSender, id: 'foreign' }],
    ['web content script', { ...trustedSender, url: 'https://attacker.test/', origin: 'https://attacker.test', tab: { id: 9 } }],
    ['mismatched origin', { ...trustedSender, origin: 'https://attacker.test' }],
    ['opaque origin', { ...trustedSender, origin: 'null' }],
    ['extension child frame', { ...trustedSender, frameId: 2 }],
    ['popup direct data access', { ...trustedSender, url: `${extensionOrigin}/src/popup.html` }],
    ['PDF viewer direct data access', { ...trustedSender, url: `${extensionOrigin}/src/pdf-viewer.html` }],
  ])('rejects %s without exposing document data or applying controls', async (_name, sender) => {
    const effect = vi.fn();
    const handler = createPdfViewerMessageHandler({
      readyPromise: effect,
      getReadingStartPosition: effect,
      getPdfSelection: effect,
      getStreamMetadata: effect,
      getPdfChunk: effect,
      closePdfChunkStream: effect,
      teardown: effect,
      highlighter: effect,
      setCurrentHighlightSettings: effect,
      ensureHighlightedPageRendered: effect,
      setActiveWordIndex: effect,
      clearActiveHighlight: effect,
      syncProtectedPdfHighlightPages: effect,
      reconcilePdfRenderWindow: effect,
    });
    const respond = vi.fn();
    for (const type of [
      'pagenarratorPing', 'getReadingStart', 'getPdfSelection', 'getPdfStreamMetadata',
      'getPdfChunk', 'closePdfChunkStream', 'tearDownPdfViewer', 'setHighlightSettings',
      'highlightChunk', 'highlightQueued', 'highlightWord', 'highlightWordPlan',
      'highlightPlanResync', 'highlightSyntheticSpeech', 'setHighlightPaused', 'clearHighlight',
    ]) expect(handler({ type }, sender, respond), type).toBe(false);
    await Promise.resolve();
    expect(effect).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('routes async reading-start messages through injected PDF state dependencies', async () => {
    const sendResponse = vi.fn();
    const deps = {
      readyPromise: Promise.resolve(),
      getReadingStartPosition: vi.fn(() => ({ source: 'page', pageNumber: 2, anchorId: 'pdf-page-2' })),
    };
    const handler = createPdfViewerMessageHandler(deps);

    expect(handler({ type: MESSAGE_TYPES.GET_READING_START }, trustedSender, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        startPosition: { source: 'page', pageNumber: 2, anchorId: 'pdf-page-2' },
      });
    });
  });

  it('returns sync highlight responses without keeping the Chrome channel open', () => {
    const sendResponse = vi.fn();
    const clearHighlights = vi.fn();
    const handler = createPdfViewerMessageHandler({
      highlighter: {
        clearHighlights,
      },
      clearActiveHighlight: vi.fn(),
      syncProtectedPdfHighlightPages: vi.fn(),
      reconcilePdfRenderWindow: vi.fn(),
      getCurrentPage: () => 1,
    });

    expect(handler({ type: MESSAGE_TYPES.CLEAR_HIGHLIGHT }, trustedSender, sendResponse)).toBe(false);
    expect(clearHighlights).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('serializes async route failures using PDF viewer error response shape', async () => {
    const sendResponse = vi.fn();
    const error = new Error('PDF viewer stream is stale. Please restart reading this PDF.');
    error.code = 'stale_pdf_stream';
    const handler = createPdfViewerMessageHandler({
      getPdfChunk: vi.fn(async () => {
        throw error;
      }),
    });

    expect(handler({ type: MESSAGE_TYPES.GET_PDF_CHUNK }, trustedSender, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'PDF viewer stream is stale. Please restart reading this PDF.',
        code: 'stale_pdf_stream',
      });
    });
  });

  it('uses the current highlighter when page rendering swaps it during highlight setup', async () => {
    const sendResponse = vi.fn();
    const firstHighlighter = {
      highlightChunkByAnchor: vi.fn(() => ({ ok: true, stale: true })),
    };
    const secondHighlighter = {
      highlightChunkByAnchor: vi.fn(() => ({ ok: true })),
    };
    let currentHighlighter = firstHighlighter;
    const pdfNarration = { speech: 'Rendered page text.', narratedItemOrders: [1] };
    const setActiveHighlight = vi.fn();
    const handler = createPdfViewerMessageHandler({
      readyPromise: Promise.resolve(),
      highlighter: () => currentHighlighter,
      ensureHighlightedPageRendered: vi.fn(async () => {
        currentHighlighter = secondHighlighter;
      }),
      setActiveHighlight,
      syncProtectedPdfHighlightPages: vi.fn(),
      reconcilePdfRenderWindow: vi.fn(async () => {}),
      getCurrentPage: () => 1,
    });

    const controller = createReaderEnginePageHighlightController({
      sendPageMessage: (tabId, message) => {
        expect(tabId).toBe(9);
        expect(handler(message, trustedSender, sendResponse)).toBe(true);
      },
    });
    await controller.highlightChunk(9, {
      type: 'pdf-page',
      anchorId: 'pdf-page-3',
      anchorText: 'Rendered page text',
      chunkText: 'Rendered page text',
      domWordOffset: 0,
      pdfNarration,
    });

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });
    expect(firstHighlighter.highlightChunkByAnchor).not.toHaveBeenCalled();
    expect(secondHighlighter.highlightChunkByAnchor).toHaveBeenCalledWith('pdf-page-3', 'Rendered page text', {
      chunkText: 'Rendered page text',
      domWordOffset: 0,
      pdfNarration,
    });
    expect(setActiveHighlight).toHaveBeenCalledWith(expect.objectContaining({ pdfNarration }));
  });

});
