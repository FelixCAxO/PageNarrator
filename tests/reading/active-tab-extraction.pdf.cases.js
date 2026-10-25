import { createDeps } from './active-tab-extraction.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReadableTab } from "../../src/lib/active-tab-extraction.js";

describe('active tab extraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts browser-open PDFs without content-script injection', async () => {
    
    const { deps, calls } = createDeps();

    const article = await extractReadableTab({
      tab: { id: 33, title: 'paper.pdf', url: 'https://example.test/paper.pdf' },
      ...deps,
    });

    expect(article).toEqual({
      source: 'pdf',
      title: 'paper.pdf',
      text: 'PDF text',
      url: 'https://example.test/paper.pdf',
      tabId: 33,
    });
    expect(calls).toEqual([
      ['extractPdfArticle', 'https://example.test/paper.pdf', false],
    ]);
  });

  it('requests local-file access before extracting a local PDF', async () => {

    const calls = [];
    const { deps } = createDeps({
      permissions: {
        contains: async (request) => {
          calls.push(['permissions.contains', request]);
          return false;
        },
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return true;
        },
      },
      extractPdfArticle: async ({ tab } = {}) => {
        calls.push(['extractPdfArticle', tab.url]);
        return { source: 'pdf', title: tab.title, text: 'Local PDF text', url: tab.url };
      },
    });

    const article = await extractReadableTab({
      tab: { id: 39, title: 'book.pdf', url: 'file:///C:/Users/reader/book.pdf' },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'pdf',
      text: 'Local PDF text',
      tabId: 39,
    });
    expect(calls).toEqual([
      ['permissions.contains', { origins: ['file:///*'] }],
      ['permissions.request', { origins: ['file:///*'] }],
      ['extractPdfArticle', 'file:///C:/Users/reader/book.pdf'],
    ]);
  });

  it('shows Chrome file URL access guidance when local PDF access is unavailable', async () => {

    const calls = [];
    const { deps } = createDeps({
      permissions: {
        contains: async (request) => {
          calls.push(['permissions.contains', request]);
          return false;
        },
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return false;
        },
      },
      extractPdfArticle: async ({ tab } = {}) => {
        calls.push(['extractPdfArticle', tab.url]);
        return { source: 'pdf', title: tab.title, text: 'Local PDF text', url: tab.url };
      },
    });

    await expect(extractReadableTab({
      tab: { id: 40, title: 'book.pdf', url: 'file:///C:/Users/reader/book.pdf' },
      ...deps,
    })).rejects.toThrow('enable "Allow access to file URLs"');

    expect(calls).toEqual([
      ['permissions.contains', { origins: ['file:///*'] }],
      ['permissions.request', { origins: ['file:///*'] }],
    ]);
  });

  it('starts PDF extraction at page 1 for top-start requests', async () => {

    const calls = [];
    const { deps } = createDeps({
      extractPdfArticle: async ({ tab, startPage } = {}) => {
        calls.push(['extractPdfArticle', tab.url, startPage]);
        return { source: 'pdf', title: tab.title, text: 'PDF text', url: tab.url };
      },
    });

    await extractReadableTab({
      tab: { id: 33, title: 'paper.pdf', url: 'https://example.test/paper.pdf#page=8' },
      startMode: 'top',
      ...deps,
    });

    expect(calls).toEqual([
      ['extractPdfArticle', 'https://example.test/paper.pdf#page=8', 1],
    ]);
  });

  it('passes the current PDF viewer page to streamed extraction for viewport starts', async () => {

    const calls = [];
    const { deps } = createDeps({
      extractPdfArticle: async ({ tab, startPage, streamChunks, speechChunkOptions } = {}) => {
        calls.push(['extractPdfArticle', tab.url, startPage, streamChunks, speechChunkOptions]);
        return {
          source: 'pdf',
          title: tab.title,
          text: '',
          chunks: [],
          streaming: true,
          chunkStream: (async function* streamChunks() {
            yield { speech: 'Page 500 starts here.', pageNumber: 500, anchorId: 'pdf-page-500' };
          })(),
          pageCount: 1200,
          url: tab.url,
        };
      },
    });

    const article = await extractReadableTab({
      tab: { id: 33, title: 'paper.pdf', url: 'https://example.test/paper.pdf' },
      streamPdfChunks: true,
      pdfStartPage: 500,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'pdf',
      streaming: true,
      pageCount: 1200,
      tabId: 33,
    });
    expect(calls).toEqual([
      ['extractPdfArticle', 'https://example.test/paper.pdf', 500, true, { maxLen: 320, targetMinLen: 180 }],
    ]);
  });

  it('extracts Chromium PDF viewer tabs whose source URL is carried as a bare query', async () => {

    const { deps, calls } = createDeps();
    const viewerUrl = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https%3A%2F%2Fexample.test%2Fbooks%2Fintro-java';

    const article = await extractReadableTab({
      tab: { id: 34, title: 'Introduction to Java Programming and Data Structures', url: viewerUrl },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'pdf',
      title: 'Introduction to Java Programming and Data Structures',
      text: 'PDF text',
      tabId: 34,
    });
    expect(calls).toEqual([
      ['extractPdfArticle', viewerUrl, false],
    ]);
  });

  it('sniffs extensionless PDF tabs after DOM extraction returns no readable text', async () => {

    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          return { source: 'fallback', title: 'Introduction', text: '', url: 'https://example.test/books/intro-java' };
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 35, title: 'Introduction to Java Programming', url: 'https://example.test/books/intro-java' },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'pdf',
      title: 'Introduction to Java Programming',
      text: 'PDF text',
      tabId: 35,
    });
    expect(calls).toEqual([
      ['sendMessage', 35, { type: 'extract' }],
      ['extractPdfArticle', 'https://example.test/books/intro-java', true],
    ]);
  });

  it('keeps the original DOM extraction result when PDF fallback sniffing misses', async () => {

    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          return { source: 'fallback', title: 'Empty page', text: '', url: 'https://example.test/empty' };
        },
      },
      extractPdfArticle: async ({ tab, requirePdfData } = {}) => {
        calls.push(['extractPdfArticle', tab.url, Boolean(requirePdfData)]);
        throw new Error('Current tab did not return PDF data.');
      },
    });

    const article = await extractReadableTab({
      tab: { id: 36, title: 'Empty page', url: 'https://example.test/empty' },
      ...deps,
    });

    expect(article).toEqual({
      source: 'fallback',
      title: 'Empty page',
      text: '',
      url: 'https://example.test/empty',
      tabId: 36,
    });
    expect(calls).toEqual([
      ['sendMessage', 36, { type: 'extract' }],
      ['extractPdfArticle', 'https://example.test/empty', true],
    ]);
  });
});
