import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReadableTab } from '../../src/lib/active-tab-extraction.js';

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          return {
            source: 'reading-model',
            title: 'Article',
            text: 'Article text',
            url: 'https://example.test/article',
          };
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
        },
      },
      permissions: {
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return true;
        },
      },
      getContentScriptFile: () => 'src/content.js',
      extractPdfArticle: async () => { throw new Error('Not a PDF'); },
      ...overrides,
    },
  };
}

function createStreamingArticleResponse() {
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

describe('active tab extraction prompt 1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('aborts a stalled content-script extraction when the read signal stops', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          if (message.type === 'extract') return new Promise(() => {});
          return { source: 'fallback', title: 'Loaded later', text: 'Loaded text', url: 'https://example.test/page' };
        },
      },
    });

    const pending = extractReadableTab({
      tab: { id: 8, title: 'Page', url: 'https://example.test/page' },
      signal: controller.signal,
      ...deps,
    });

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out a stalled streamed article chunk request', async () => {
    vi.useFakeTimers();
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          if (message.type === 'extract') return createStreamingArticleResponse();
          if (message.type === 'getArticleChunk') return new Promise(() => {});
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Streamed', url: 'https://example.test/streamed' },
      streamArticleChunks: true,
      messageTimeoutMs: 25,
      ...deps,
    });

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    const pending = iterator.next();

    await Promise.resolve();
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'content_script_message_timeout',
      message: 'PageNarrator content script did not respond to getArticleChunk within 25 ms.',
    });
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;
  });

  it('forwards a custom messageTimeoutMs into post-injection retry attempts', async () => {
    vi.useFakeTimers();
    let extractionMessages = 0;
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          if (message.type !== 'extract') throw new Error(`Unexpected message ${message.type}`);
          extractionMessages += 1;
          if (extractionMessages === 1) throw new Error('Receiving end does not exist.');
          return new Promise(() => {});
        },
      },
    });

    const pending = extractReadableTab({
      tab: { id: 21, title: 'Page', url: 'https://example.test/page' },
      messageTimeoutMs: 37,
      ...deps,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'content_script_message_timeout',
      message: 'PageNarrator content script did not respond to extract within 37 ms.',
    });
    await vi.advanceTimersByTimeAsync(60000);
    await timeoutAssertion;
  });

  it('aborts a stalled post-injection retry attempt when the read signal stops', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let extractionMessages = 0;
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          if (message.type !== 'extract') throw new Error(`Unexpected message ${message.type}`);
          extractionMessages += 1;
          if (extractionMessages === 1) throw new Error('Receiving end does not exist.');
          return new Promise(() => {});
        },
      },
    });

    const pending = extractReadableTab({
      tab: { id: 22, title: 'Page', url: 'https://example.test/page' },
      signal: controller.signal,
      ...deps,
    });
    const rejection = vi.fn();
    pending.catch(rejection);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(extractionMessages).toBe(2);

    controller.abort();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  });

  it('aborts a stalled streamed article chunk request when the read signal stops', async () => {
    const controller = new AbortController();
    const { deps } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          if (message.type === 'extract') return createStreamingArticleResponse();
          if (message.type === 'getArticleChunk') return new Promise(() => {});
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Streamed', url: 'https://example.test/streamed' },
      streamArticleChunks: true,
      signal: controller.signal,
      ...deps,
    });

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    const pending = iterator.next();

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('closes the remote streamed article after the local read signal aborts', async () => {
    const controller = new AbortController();
    const { deps, calls } = createDeps({
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          if (message.type === 'extract') return createStreamingArticleResponse();
          if (message.type === 'closeArticleChunkStream') return { closed: true };
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    });

    const article = await extractReadableTab({
      tab: { id: 12, title: 'Streamed', url: 'https://example.test/streamed' },
      streamArticleChunks: true,
      signal: controller.signal,
      ...deps,
    });

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    controller.abort();
    await iterator.return();

    expect(calls).toContainEqual(['sendMessage', 12, {
      type: 'closeArticleChunkStream',
      streamId: 'article-stream-test',
    }]);
  });
});
