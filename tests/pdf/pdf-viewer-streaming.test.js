import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPdfViewerChunkStream,
  createPdfViewerStreamingArticle,
} from '../../src/lib/pdf-viewer-chunk-stream.js';

describe('PDF viewer streaming article bridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a streaming PDF article whose iterator requests chunks from the viewer tab', async () => {
    const messages = [];
    const sendMessage = vi.fn(async (tabId, message) => {
      messages.push([tabId, message]);
      if (message.type === 'getPdfStreamMetadata') {
        return {
          ok: true,
          title: 'Viewer title',
          url: 'https://example.test/book.pdf',
          pageCount: 42,
          totalReadableWordCount: 1234,
          instanceToken: 'viewer-load-1',
        };
      }
      if (message.type === 'getPdfChunk') {
        return {
          ok: true,
          done: false,
          value: {
            type: 'pdf-page',
            speech: 'Page five text',
            text: 'Page five text',
            pageNumber: 5,
            anchorId: 'pdf-page-5',
          },
        };
      }
      if (message.type === 'closePdfChunkStream') {
        return { ok: true };
      }
      return { ok: false, error: 'Unexpected message' };
    });

    const article = await createPdfViewerStreamingArticle({
      tab: { id: 77, title: 'Source title' },
      sourceUrl: 'https://example.test/book.pdf',
      startPage: 5,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
      sendMessage,
      streamId: 'test-stream',
    });

    expect(article).toMatchObject({
      source: 'pdf',
      title: 'Viewer title',
      text: '',
      chunks: [],
      url: 'https://example.test/book.pdf',
      pageCount: 42,
      totalReadableWordCount: 1234,
      streaming: true,
      tabId: 77,
      startPosition: {
        source: 'page',
        pageNumber: 5,
        anchorId: 'pdf-page-5',
      },
    });

    const iterator = article.chunkStream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'pdf-page',
        speech: 'Page five text',
        text: 'Page five text',
        pageNumber: 5,
        anchorId: 'pdf-page-5',
      },
    });
    await iterator.return();

    expect(messages).toEqual([
      [77, { type: 'getPdfStreamMetadata', startPage: 5 }],
      [77, {
        type: 'getPdfChunk',
        streamId: 'test-stream',
        instanceToken: 'viewer-load-1',
        startPage: 5,
        speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
        count: 1,
        maxChunks: 1,
      }],
      [77, { type: 'closePdfChunkStream', streamId: 'test-stream', instanceToken: 'viewer-load-1' }],
    ]);
  });

  it('passes requested PDF chunk counts through and yields returned batches', async () => {
    const chunks = [
      { speech: 'First PDF section.', pageNumber: 1, anchorId: 'pdf-page-1' },
      { speech: 'Second PDF section.', pageNumber: 1, anchorId: 'pdf-page-1' },
      { speech: 'Third PDF section.', pageNumber: 2, anchorId: 'pdf-page-2' },
    ];
    const messages = [];
    const stream = createPdfViewerChunkStream({
      tabId: 77,
      streamId: 'batched-stream',
      instanceToken: 'viewer-load-1',
      startPage: 1,
      speechChunkOptions: { maxLen: 480, targetMinLen: 260 },
      sendMessage: async (tabId, message) => {
        messages.push([tabId, message]);
        return { ok: true, done: false, chunks };
      },
    });

    await expect(stream[Symbol.asyncIterator]().next(3)).resolves.toEqual({
      done: false,
      value: chunks,
    });
    expect(messages).toEqual([[
      77,
      {
        type: 'getPdfChunk',
        streamId: 'batched-stream',
        instanceToken: 'viewer-load-1',
        startPage: 1,
        speechChunkOptions: { maxLen: 480, targetMinLen: 260 },
        count: 3,
        maxChunks: 3,
      },
    ]]);
  });

  it('throws stream errors returned by the viewer instead of silently ending playback', async () => {
    const stream = createPdfViewerChunkStream({
      tabId: 77,
      streamId: 'bad-stream',
      startPage: 1,
      sendMessage: async () => ({ ok: false, error: 'PDF extraction failed' }),
    });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('PDF extraction failed');
  });

  it('rejects stalled metadata requests with a bounded viewer timeout', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise(() => {}));
    let rejection = null;
    let settled = false;

    createPdfViewerStreamingArticle({
      tab: { id: 77, title: 'Source title' },
      sendMessage,
      messageTimeoutMs: 25,
    }).catch((error) => {
      rejection = error;
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
    expect(rejection).toMatchObject({
      code: 'pdf_viewer_message_timeout',
      message: 'PageNarrator PDF viewer did not respond to getPdfStreamMetadata within 25 ms.',
    });
  });

  it('does not block stream cleanup on a stalled close response', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async (_tabId, message) => {
      if (message.type === 'getPdfChunk') {
        return {
          ok: true,
          done: false,
          value: {
            type: 'pdf-page',
            speech: 'Page text',
            text: 'Page text',
            pageNumber: 1,
            anchorId: 'pdf-page-1',
          },
        };
      }
      return new Promise(() => {});
    });
    const stream = createPdfViewerChunkStream({
      tabId: 77,
      streamId: 'cleanup-stream',
      sendMessage,
      messageTimeoutMs: 25,
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    let settled = false;
    void iterator.return().then(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
  });

  it('keeps coded viewer PDF errors actionable for the toolbar player', async () => {
    const stream = createPdfViewerChunkStream({
      tabId: 77,
      streamId: 'bad-stream',
      startPage: 1,
      sendMessage: async () => ({
        ok: false,
        error: 'PDF appears to be scanned or image-only, so PageNarrator cannot extract selectable text.',
        code: 'scanned_pdf_unsupported',
      }),
    });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      message: 'PDF appears to be scanned or image-only, so PageNarrator cannot extract selectable text.',
      code: 'scanned_pdf_unsupported',
    });
  });
});
