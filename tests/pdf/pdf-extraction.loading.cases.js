import { tinyPdfBytes, createFakePdfDocument } from "./pdf-extraction.fixtures.js";
import { describe, expect, it } from "vitest";

import { getDocument } from '../../src/pdf/pdf-engine.js';
import { configurePdfWorker, extractPdfArticle, extractPdfTextFromData, getPdfDocumentParams, getPdfReadableWordCount, getPdfWorkerUrl } from "../../src/lib/pdf-extraction.js";
const originalAssets = {
  wasmUrl: new URL('../../native/pdf.wasm', import.meta.url).href,
  standardFontDataUrl: new URL('../../vendor/pdf-data/standard_fonts/', import.meta.url).href,
};

describe('PDF extraction', () => {
  it('counts every narrated PDF word without materializing the document', async () => {
    const document = createFakePdfDocument([
      'First page has four words',
      'Second page has five more words',
    ]);

    await expect(getPdfReadableWordCount(document)).resolves.toBe(11);
    await expect(getPdfReadableWordCount(document, { startPage: 2 })).resolves.toBe(6);
    expect(document.cleanupCalls).toEqual([1, 2, 2]);
  });

  it('extracts page text from real PDF bytes in reading order', async () => {
    const article = await extractPdfTextFromData(tinyPdfBytes(), {
      ...originalAssets,
      title: 'Browser PDF',
      url: 'https://example.test/report.pdf',
    });

    expect(article).toEqual({
      source: 'pdf',
      title: 'Browser PDF',
      text: 'Hello PDF from browser\n\nSecond line text',
      chunks: [
        {
          type: 'pdf-page',
          speech: 'Hello PDF from browser Second line text.',
          text: 'Hello PDF from browser\n\nSecond line text',
          anchorText: 'Hello PDF from browser\n\nSecond line text',
          anchorId: 'pdf-page-1',
          speechPrefixWords: 0,
          pageNumber: 1,
          pdfNarration: {
            speech: 'Hello PDF from browser Second line text.',
            narratedItemOrders: [0, 1],
          },
        },
      ],
      url: 'https://example.test/report.pdf',
      pageCount: 1,
    });
  });

  it('resolves the packaged original module worker URL for extension pages', () => {
    expect(getPdfWorkerUrl({
      getURL: (path) => `chrome-extension://test/${path}`,
    })).toBe('chrome-extension://test/assets/pdf.worker.js');
  });

  it('destroys the original document through the app loading-task contract', async () => {
    const task = getDocument({ data: tinyPdfBytes(), ...originalAssets }), document = await task.promise;
    expect(document.numPages).toBe(1); await task.destroy();
    await expect(document.getPage(1)).rejects.toMatchObject({ code: 'pdf_closed' });
  });

  it('passes the configured runtime to the PDF worker resolver', () => {
    const fakePdfjs = { GlobalWorkerOptions: { workerSrc: '' } };
    const workerSrc = configurePdfWorker(fakePdfjs, {
      runtime: { getURL: (path) => `chrome-extension://custom/${path}` },
    });

    expect(workerSrc).toBe('chrome-extension://custom/assets/pdf.worker.js');
    expect(fakePdfjs.GlobalWorkerOptions.workerSrc).toBe(workerSrc);
  });

  it('builds URL loading parameters without making a caller-owned ArrayBuffer copy', () => {
    expect(getPdfDocumentParams('https://example.test/report.pdf')).toEqual({
      url: 'https://example.test/report.pdf',
      withCredentials: false,
      useSystemFonts: true,
      rangeChunkSize: 64 * 1024,
      enableScripting: false,
    });

    expect(getPdfDocumentParams('http://example.test/report.pdf')).toMatchObject({
      url: 'http://example.test/report.pdf',
      withCredentials: false,
      rangeChunkSize: 64 * 1024,
    });
    expect(getPdfDocumentParams('blob:https://example.test/id')).toBeNull();
    expect(getPdfDocumentParams('data:application/pdf;base64,JVBERi0=')).toBeNull();
  });

  it('delegates ordinary URL downloading to the injected loading backend', async () => {
    const calls = [];
    const document = createFakePdfDocument(['Hello range loaded PDF']);
    const fakePdfjs = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument(params) {
        calls.push(params);
        return { promise: Promise.resolve(document) };
      },
    };

    const article = await extractPdfArticle({
      tab: { title: 'Annual report.pdf', url: 'https://example.test/report.pdf' },
      pdfjs: fakePdfjs,
      fetch: async () => {
        throw new Error('fetch should not be used for URL/range extraction');
      },
    });

    expect(calls).toEqual([getPdfDocumentParams('https://example.test/report.pdf')]);
    expect(document.destroyed).toBe(true);
    expect(article).toMatchObject({
      source: 'pdf',
      title: 'Annual report.pdf',
      text: 'Hello range loaded PDF',
      pageCount: 1,
    });
  });

  it('disables PDF scripting when extracting from downloaded bytes', async () => {
    const calls = [];
    const document = createFakePdfDocument(['Safe PDF text']);
    const fakePdfjs = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument(params) {
        calls.push(params);
        return { promise: Promise.resolve(document) };
      },
    };

    await extractPdfTextFromData(new Uint8Array([1, 2, 3]), { pdfjs: fakePdfjs });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      data: expect.any(Uint8Array),
      enableScripting: false,
    });
  });

  it('uses the full-byte fallback when PDF data must be verified before parsing', async () => {
    const calls = [];
    const article = await extractPdfArticle({
      tab: { title: 'Annual report.pdf', url: 'https://example.test/report.pdf' },
      requirePdfData: true,
      ...originalAssets,
      fetch: async (url) => {
        calls.push(url);
        return new Response(tinyPdfBytes(), { headers: { 'content-type': 'application/pdf' } });
      },
    });

    expect(calls).toEqual(['https://example.test/report.pdf']);
    expect(article.source).toBe('pdf');
    expect(article.title).toBe('Annual report.pdf');
    expect(article.text).toContain('Hello PDF from browser');
  });

  it('accepts extensionless PDF responses when fallback detection verifies PDF bytes', async () => {
    const article = await extractPdfArticle({
      tab: { title: 'Introduction to Java Programming', url: 'https://example.test/books/intro-java' },
      requirePdfData: true,
      ...originalAssets,
      fetch: async () => new Response(tinyPdfBytes(), { headers: { 'content-type': 'application/pdf' } }),
    });

    expect(article.source).toBe('pdf');
    expect(article.url).toBe('https://example.test/books/intro-java');
    expect(article.text).toContain('Hello PDF from browser');
  });

  it('rejects non-PDF responses during fallback detection before parsing', async () => {
    await expect(extractPdfArticle({
      tab: { title: 'Empty page', url: 'https://example.test/empty' },
      requirePdfData: true,
      fetch: async () => new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } }),
    })).rejects.toThrow('Current tab did not return PDF data.');
  });

  it('fails with a useful message when the PDF cannot be downloaded', async () => {
    await expect(extractPdfArticle({
      tab: { title: 'report.pdf', url: 'https://example.test/report.pdf' },
      fetch: async () => ({ ok: false, status: 403 }),
    })).rejects.toThrow('Could not download the PDF');
  });
});
