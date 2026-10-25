import { describe, expect, it, vi } from 'vitest';

import { getPdfStartPageFromTab, getPdfStartPageFromUrl, getPdfViewerUrl, getPdfSourceUrl, isPageNarratorPdfViewerUrl, isLikelyPdfTab } from "../../src/lib/pdf-extraction.js";
import { refreshExtensionLogLevel } from '../../src/lib/logger.js';

describe('PDF extraction', () => {
  it('detects normal browser PDF URLs without treating every extension page as readable', () => {
    expect(isLikelyPdfTab({ url: 'https://example.test/report.pdf' })).toBe(true);
    expect(isLikelyPdfTab({ url: 'https://example.test/report.pdf?download=0#page=2' })).toBe(true);
    expect(isLikelyPdfTab({ url: 'https://example.test/report', title: 'report.pdf' })).toBe(true);
    expect(isLikelyPdfTab({ url: 'https://arxiv.org/pdf/2107.09051', title: 'AI in Finance' })).toBe(true);
    expect(isLikelyPdfTab({ url: 'chrome-extension://abc/src/reader-engine.html' })).toBe(false);
  });

  it('detects Chrome PDF viewer tabs through their source URL', () => {
    const tab = {
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf',
    };

    expect(isLikelyPdfTab(tab)).toBe(true);
    expect(getPdfSourceUrl(tab)).toBe('https://example.test/paper.pdf');
  });

  it('detects known PDF viewer tabs even when Chrome hides the source URL', () => {
    expect(isLikelyPdfTab({
      title: 'PDF viewer',
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
    })).toBe(true);
    expect(isLikelyPdfTab({
      title: 'PDF viewer',
      url: 'chrome-extension://test/src/pdf-viewer.html',
    })).toBe(true);
  });

  it('detects Chromium PDF viewer tabs that carry the PDF URL as a bare query', () => {
    const tab = {
      title: 'Introduction to Java Programming and Data Structures',
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https%3A%2F%2Fexample.test%2Fbooks%2Fintro-java',
    };

    expect(isLikelyPdfTab(tab)).toBe(true);
    expect(getPdfSourceUrl(tab)).toBe('https://example.test/books/intro-java');
  });

  it('does not treat unrelated extension pages with URL-shaped query strings as PDFs', () => {
    const bareQueryTab = {
      url: 'chrome-extension://abc/src/options.html?https%3A%2F%2Fexample.test%2Fpaper.pdf',
    };
    const srcParamTab = {
      url: 'chrome-extension://abc/src/options.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf',
    };

    expect(isLikelyPdfTab(bareQueryTab)).toBe(false);
    expect(getPdfSourceUrl(bareQueryTab)).toBe(bareQueryTab.url);
    expect(isLikelyPdfTab(srcParamTab)).toBe(false);
    expect(getPdfSourceUrl(srcParamTab)).toBe(srcParamTab.url);
  });

  it('does not throw on malformed percent-encoded PDF-looking tab URLs', async () => {
    await refreshExtensionLogLevel({ storage: { get: async () => ({ logLevel: 'warn' }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tab = {
      title: 'Broken percent encoding.pdf',
      url: 'https://example.test/reports/%E0%A4%A.pdf',
    };

    try {
      expect(() => isLikelyPdfTab(tab)).not.toThrow();
      expect(isLikelyPdfTab(tab)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[PageNarrator:pdf-extraction]',
        'Could not decode PDF URL component.',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await refreshExtensionLogLevel({ storage: { get: async () => ({ logLevel: 'silent' }) } });
    }
  });

  it('does not classify a normal loading tab as a PDF just because pendingUrl is available', () => {
    expect(isLikelyPdfTab({
      title: 'Loading article',
      url: '',
      pendingUrl: 'https://example.test/article',
    })).toBe(false);
  });

  it('builds and detects PageNarrator PDF viewer URLs', () => {
    const viewerUrl = getPdfViewerUrl('https://example.test/paper.pdf', {
      getURL: (path) => `chrome-extension://test/${path}`,
    });

    expect(viewerUrl).toBe('chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf');
    expect(isPageNarratorPdfViewerUrl(viewerUrl)).toBe(true);
    expect(getPdfSourceUrl({ url: viewerUrl })).toBe('https://example.test/paper.pdf');
  });

  it('reads an initial page from PDF viewer URLs and source fragments', () => {
    expect(getPdfStartPageFromUrl('https://example.test/report.pdf#page=4')).toBe(4);
    expect(getPdfStartPageFromUrl('https://example.test/report.pdf?page=5')).toBe(5);
    expect(getPdfStartPageFromTab({
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf%23page%3D7',
    })).toBe(7);
    expect(getPdfStartPageFromTab({
      url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fpaper.pdf#page=9',
    })).toBe(9);
    expect(getPdfStartPageFromTab({
      url: '',
      pendingUrl: 'https://example.test/report.pdf#page=3',
    })).toBe(3);
  });
});
