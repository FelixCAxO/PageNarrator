import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleExtractMessage } from '../../src/reader/extraction/content-extraction.js';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

function createDocument(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/streaming-article' });
  dom.window.getSelection = () => ({ toString: () => '' });
  return dom.window.document;
}

describe('content extraction article chunk streaming', () => {
  it('routes article chunk protocol messages through the content extraction handler', () => {
    const contentScript = readFileSync(new URL('../../src/content.js', import.meta.url), 'utf8');

    expect(contentScript).toContain("'getArticleChunk'");
    expect(contentScript).toContain("'closeArticleChunkStream'");
    expect(contentScript).toContain("modulePath: './reader/extraction/content-extraction.js'");
  });

  it('returns a serializable stream handle and serves speech chunks on demand', async () => {
    const document = createDocument(`
      <title>Streaming Story</title>
      <main>
        <article>
          <h1>Streaming Story</h1>
          <p>Artificial intelligence (AI) improves reading tasks[1] quickly. The first block should be chunked before later blocks.</p>
          <p>The second paragraph should be pulled only after the stream asks for another chunk.</p>
        </article>
      </main>
    `);

    const response = await handleExtractMessage({
      type: MESSAGE_TYPES.EXTRACT,
      streamChunks: true,
      speechChunkOptions: { maxLen: 74, targetMinLen: 48 },
    }, { documentRef: document });

    expect(response).toMatchObject({
      source: 'reading-model',
      title: 'Streaming Story',
      text: '',
      chunks: expect.arrayContaining([
        expect.objectContaining({ type: 'page-title', speech: 'Streaming Story.' }),
        expect.objectContaining({
          type: 'paragraph',
          speech: 'Artificial intelligence (AI) improves reading tasks[1] quickly. The first block should be chunked before later blocks.',
        }),
      ]),
      streaming: true,
      chunkStreamId: expect.stringMatching(/^article-stream-/),
      totalReadableWordCount: 32,
    });
    expect(response.chunkStream).toBeUndefined();

    const first = await handleExtractMessage({
      type: MESSAGE_TYPES.GET_ARTICLE_CHUNK,
      streamId: response.chunkStreamId,
    }, { documentRef: document });
    const second = await handleExtractMessage({
      type: MESSAGE_TYPES.GET_ARTICLE_CHUNK,
      streamId: response.chunkStreamId,
      count: 2,
    }, { documentRef: document });

    expect(first).toEqual({
      done: false,
      chunk: expect.objectContaining({
        type: 'page-title',
        speech: 'Streaming Story.',
      }),
    });
    expect(second).toEqual({
      done: false,
      chunk: expect.objectContaining({
        type: 'paragraph',
        speech: 'Artificial intelligence (AI) improves reading tasks quickly.',
        anchorText: 'Artificial intelligence (AI) improves reading tasks[1] quickly. The first block should be chunked before later blocks.',
      }),
      chunks: [
        expect.objectContaining({
          type: 'paragraph',
          speech: 'Artificial intelligence (AI) improves reading tasks quickly.',
        }),
        expect.objectContaining({
          type: 'paragraph',
          speech: 'The first block should be chunked before later blocks.',
        }),
      ],
    });

    await expect(handleExtractMessage({
      type: MESSAGE_TYPES.CLOSE_ARTICLE_CHUNK_STREAM,
      streamId: response.chunkStreamId,
    }, { documentRef: document })).resolves.toEqual({ closed: true });
    await expect(handleExtractMessage({
      type: MESSAGE_TYPES.GET_ARTICLE_CHUNK,
      streamId: response.chunkStreamId,
    }, { documentRef: document })).resolves.toEqual({ done: true });
  });
});
