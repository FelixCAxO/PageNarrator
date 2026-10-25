import { describe, expect, it, vi } from 'vitest';
import {
  PDF_READING_START_RETRY,
  getPdfReadingStartFromViewer,
  resolvePdfReadStartPage,
} from '../../src/lib/pdf-reading-start.js';
import { refreshExtensionLogLevel } from '../../src/lib/logger.js';

describe('PDF reading start detection', () => {
  it('retries the viewer page query before falling back to URL state', async () => {
    const sendPageMessage = vi.fn(async () => ({
      startPosition: { pageNumber: 50, text: 'Page 50 visible text' },
    }));

    const startPosition = await getPdfReadingStartFromViewer({
      id: 42,
      url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=50',
    }, {
      isPdfViewerUrl: () => true,
      sendPageMessage,
    });

    expect(startPosition).toEqual({ pageNumber: 50, text: 'Page 50 visible text' });
    expect(sendPageMessage).toHaveBeenCalledWith(
      42,
      { type: 'getReadingStart' },
      PDF_READING_START_RETRY,
    );
    expect(PDF_READING_START_RETRY).toEqual({ attempts: 3, delayMs: 80 });
  });

  it('does not query non-viewer tabs', async () => {
    const sendPageMessage = vi.fn();

    await expect(getPdfReadingStartFromViewer({
      id: 42,
      url: 'https://example.test/book.pdf',
    }, {
      isPdfViewerUrl: () => false,
      sendPageMessage,
    })).resolves.toBeNull();

    expect(sendPageMessage).not.toHaveBeenCalled();
  });

  it('falls back when the viewer start query rejects', async () => {
    await refreshExtensionLogLevel({ storage: { get: async () => ({ logLevel: 'warn' }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendPageMessage = vi.fn(async () => {
      throw new Error('viewer is still loading');
    });

    try {
      await expect(getPdfReadingStartFromViewer({
        id: 42,
        url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=50',
      }, {
        isPdfViewerUrl: () => true,
        sendPageMessage,
      })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[PageNarrator:pdf-reading-start]',
        'Could not read PDF viewport start from viewer; falling back to URL state.',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await refreshExtensionLogLevel({ storage: { get: async () => ({ logLevel: 'silent' }) } });
    }
  });

  it('uses a deep PDF tab page when the viewer reports its default first page after a stop', () => {
    const activeTab = {
      id: 42,
      url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=1000',
    };

    const startPage = resolvePdfReadStartPage({
      activeTab,
      pdfReadingStart: { source: 'page', pageNumber: 1, anchorId: 'pdf-page-1' },
      shouldUseViewportStart: true,
      getPdfStartPageFromTab: () => 1000,
    });

    expect(startPage).toBe(1000);
  });

  it('keeps an explicit viewer reading start ahead of the URL fallback', () => {
    const startPage = resolvePdfReadStartPage({
      activeTab: {
        id: 42,
        url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=1000',
      },
      pdfReadingStart: { source: 'viewport', pageNumber: 999, anchorId: 'pdf-page-999' },
      shouldUseViewportStart: true,
      getPdfStartPageFromTab: () => 1000,
    });

    expect(startPage).toBe(999);
  });

  it('starts at page one when the user explicitly asks to read from the top', () => {
    const startPage = resolvePdfReadStartPage({
      activeTab: {
        id: 42,
        url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=1000',
      },
      pdfReadingStart: { source: 'page', pageNumber: 1000, anchorId: 'pdf-page-1000' },
      shouldUseViewportStart: false,
      getPdfStartPageFromTab: () => 1000,
    });

    expect(startPage).toBe(1);
  });

  it('asks the viewer only for a page the reader moved to after a finished read', async () => {
    const sendPageMessage = vi.fn(async () => ({ startPosition: null }));

    await expect(getPdfReadingStartFromViewer({
      id: 42,
      url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=12',
    }, {
      isPdfViewerUrl: () => true,
      sendPageMessage,
      afterFinishedRead: true,
    })).resolves.toBeNull();

    expect(sendPageMessage).toHaveBeenCalledWith(
      42,
      { type: 'getReadingStart', afterFinishedRead: true },
      PDF_READING_START_RETRY,
    );
  });

  it('restarts a finished read on the page the reader moved to, or from page one', () => {
    const activeTab = {
      id: 42,
      url: 'chrome-extension://pagenarrator-test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=12',
    };
    const resolveAfterFinish = (pdfReadingStart) => resolvePdfReadStartPage({
      activeTab,
      pdfReadingStart,
      shouldUseViewportStart: false,
      afterFinishedRead: true,
      getPdfStartPageFromTab: () => 12,
    });

    expect(resolveAfterFinish({ source: 'viewport', pageNumber: 4, anchorId: 'pdf-page-4' })).toBe(4);
    // The tab's #page=12 only follows narration to the last page, so it is not a start.
    expect(resolveAfterFinish(null)).toBe(1);
  });
});
