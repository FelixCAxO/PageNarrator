import { createDeps } from './active-tab-extraction.fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReadableTab, isBrowserInternalUrl } from '../../src/lib/active-tab-extraction.js';

describe('active tab extraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the existing content-script extraction path for normal web pages', async () => {
    const { deps, calls } = createDeps();

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Article', url: 'https://example.test/article' },
      ...deps,
    });

    expect(article).toEqual({
      source: 'reading-model',
      title: 'Article',
      text: 'Article text',
      url: 'https://example.test/article',
      tabId: 12,
    });
    expect(calls).toEqual([
      ['sendMessage', 12, { type: 'extract' }],
    ]);
  });

  it('passes explicit selected-text extraction requests to the content script', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          return { source: 'selection', title: 'Article', text: 'Selected text', url: 'https://example.test/article' };
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Article', url: 'https://example.test/article' },
      readSelection: true,
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'selection',
      text: 'Selected text',
      tabId: 12,
    });
    expect(calls).toEqual([
      ['sendMessage', 12, { type: 'extract', readSelection: true }],
    ]);
  });

  it('passes top-start extraction requests to the content script', async () => {
    const { deps, calls } = createDeps();

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Article', url: 'https://example.test/article' },
      startMode: 'top',
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'reading-model',
      tabId: 12,
    });
    expect(calls).toEqual([
      ['sendMessage', 12, { type: 'extract', startMode: 'top' }],
    ]);
  });

  it('classifies browser-internal URLs before content-script extraction', () => {
    expect(isBrowserInternalUrl('chrome://extensions')).toBe(true);
    expect(isBrowserInternalUrl('edge://settings')).toBe(true);
    expect(isBrowserInternalUrl('about:blank')).toBe(true);
    expect(isBrowserInternalUrl('chrome-extension://abc/src/reader-engine.html')).toBe(true);
    expect(isBrowserInternalUrl('https://example.test/article')).toBe(false);
    expect(isBrowserInternalUrl('file:///tmp/article.html')).toBe(false);
  });

  it('injects the content script when a normal page is readable but not initialized yet', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (calls.filter(([name]) => name === 'sendMessage').length === 1) {
            throw new Error('Receiving end does not exist.');
          }
          return { source: 'fallback', title: 'Loaded later', text: 'Loaded text', url: 'https://example.test/page' };
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 8, title: 'Page', url: 'https://example.test/page' },
      ...deps,
    });

    expect(article.source).toBe('fallback');
    expect(article.tabId).toBe(8);
    expect(calls).toEqual([
      ['sendMessage', 8, { type: 'extract' }],
      ['executeScript', { target: { tabId: 8 }, files: ['src/content.js'] }],
      ['sendMessage', 8, { type: 'extract' }],
    ]);
  });

  it('wraps content-script article stream handles in a local async chunk stream', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (message.type === 'extract') {
            return {
              source: 'reading-model',
              title: 'Streamed',
              text: '',
              chunks: [],
              streaming: true,
              chunkStreamId: 'article-stream-test',
              url: 'https://example.test/streamed',
            };
          }
          if (message.type === 'getArticleChunk') {
            return { done: false, chunk: { speech: 'First streamed section.' } };
          }
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Streamed', url: 'https://example.test/streamed' },
      streamArticleChunks: true,
      speechChunkOptions: { maxLen: 96, targetMinLen: 64 },
      ...deps,
    });

    expect(article).toMatchObject({
      source: 'reading-model',
      streaming: true,
      tabId: 12,
    });
    expect(typeof article.chunkStream?.[Symbol.asyncIterator]).toBe('function');

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { speech: 'First streamed section.' },
    });
    await iterator.return?.();

    expect(calls).toEqual([
      ['sendMessage', 12, {
        type: 'extract',
        streamChunks: true,
        speechChunkOptions: { maxLen: 96, targetMinLen: 64 },
      }],
      ['sendMessage', 12, {
        type: 'getArticleChunk',
        streamId: 'article-stream-test',
        count: 1,
        maxChunks: 1,
      }],
      ['sendMessage', 12, {
        type: 'closeArticleChunkStream',
        streamId: 'article-stream-test',
      }],
    ]);
  });

  it('forwards batched chunk requests from the readerEngine into the content script', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (message.type === 'extract') {
            return {
              source: 'reading-model',
              title: 'Streamed',
              text: '',
              chunks: [],
              streaming: true,
              chunkStreamId: 'article-stream-batch',
              url: 'https://example.test/streamed',
            };
          }
          if (message.type === 'getArticleChunk') {
            return {
              done: false,
              chunks: [
                { speech: 'First streamed section.' },
                { speech: 'Second streamed section.' },
              ],
            };
          }
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Streamed', url: 'https://example.test/streamed' },
      streamArticleChunks: true,
      speechChunkOptions: { maxLen: 96, targetMinLen: 64 },
      ...deps,
    });

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    await expect(iterator.next(2)).resolves.toEqual({
      done: false,
      value: { speech: 'First streamed section.' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { speech: 'Second streamed section.' },
    });

    expect(calls).toEqual([
      ['sendMessage', 12, {
        type: 'extract',
        streamChunks: true,
        speechChunkOptions: { maxLen: 96, targetMinLen: 64 },
      }],
      ['sendMessage', 12, {
        type: 'getArticleChunk',
        streamId: 'article-stream-batch',
        count: 2,
        maxChunks: 2,
      }],
    ]);
  });

  it('retries extraction briefly after injection when the content receiver registers late', async () => {
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (calls.filter(([name]) => name === 'sendMessage').length < 3) {
            throw new Error('Receiving end does not exist.');
          }
          return { source: 'fallback', title: 'Loaded later', text: 'Loaded text', url: 'https://example.test/page' };
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 8, title: 'Page', url: 'https://example.test/page' },
      ...deps,
    });

    expect(article.source).toBe('fallback');
    expect(article.tabId).toBe(8);
    expect(calls).toEqual([
      ['sendMessage', 8, { type: 'extract' }],
      ['executeScript', { target: { tabId: 8 }, files: ['src/content.js'] }],
      ['sendMessage', 8, { type: 'extract' }],
      ['sendMessage', 8, { type: 'extract' }],
    ]);
  });
});
