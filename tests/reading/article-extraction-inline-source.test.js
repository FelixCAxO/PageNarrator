import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleExtractMessage } from '../../src/reader/extraction/content-extraction.js';
import { chooseArticleExtraction, iterateArticleSpeechChunks } from '../../src/lib/article-extraction.js';
import { isArticleDocument, parseArticleDocument } from '../../src/engines/article-extractor.js';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

const first = 'The microscope records each sample before the final analysis begins.';
const second = 'The second observation explains the complete source record in ordinary prose.';
const windows = [];
function source(markup) {
  const dom = new JSDOM(`<title>Field observations</title><article>${markup}<div id="plain">${second}</div></article>`, {
    url: 'https://example.test/observations', pretendToBeVisual: true,
  });
  windows.push(dom.window);
  dom.window.scrollBy = () => {};
  return dom.window.document;
}
function extract(document) {
  return chooseArticleExtraction(document, { startMode: 'top', articleFallback: { isArticleDocument, parse: parseArticleDocument } });
}
async function spoken(article) {
  const blocks = [];
  for await (const chunk of iterateArticleSpeechChunks(article, { maxLen: 10000 })) blocks.push(typeof chunk === 'string' ? chunk : chunk.speech);
  return blocks;
}

describe('article fallback inline source preservation', () => {
  afterEach(() => { for (const win of windows.splice(0)) win.close(); vi.unstubAllGlobals(); });

  it('keeps an inline-formatted word in the streamed extraction instead of reading only the other anchored block', async () => {
    const document = source('<div id="split">The micro<strong>scope</strong> records each sample before the final analysis begins.</div>');
    const block = document.querySelector('#split'), leading = block.firstChild, formatted = block.querySelector('strong').firstChild;
    const response = await handleExtractMessage({ streamChunks: true, startMode: 'top', speechChunkOptions: { maxLen: 10000 } }, { documentRef: document });
    expect(response.source).toBe('article-fallback');
    const chunks = [];
    try {
      for (;;) {
        const next = await handleExtractMessage({ type: MESSAGE_TYPES.GET_ARTICLE_CHUNK, streamId: response.chunkStreamId }, { documentRef: document });
        if (next.done) break;
        chunks.push(next.chunk);
      }
    } finally {
      await handleExtractMessage({ type: MESSAGE_TYPES.CLOSE_ARTICLE_CHUNK_STREAM, streamId: response.chunkStreamId }, { documentRef: document });
    }
    expect(chunks.map(chunk => chunk.speech)).toEqual([first, second]);
    expect(chunks[0].anchorId).toBe(block.dataset.pagenarratorId);
    expect(document.querySelector(`[data-pagenarrator-id="${chunks[0].anchorId}"]`)).toBe(block);
    expect(block.firstChild).toBe(leading);
    expect(block.querySelector('strong').firstChild).toBe(formatted);
    expect(leading.nodeValue).toBe('The micro');
    expect(formatted.nodeValue).toBe('scope');
  });

  it('separates an explicit BR without splitting adjacent inline letters', async () => {
    const document = source('<div id="split">The micro<strong>scope</strong> records the first sample.<br>The second sample follows on the next line.</div>');
    const article = extract(document);
    expect(article.source).toBe('article-fallback');
    expect(await spoken(article)).toEqual(['The microscope records the first sample. The second sample follows on the next line.', second]);
    expect(document.querySelectorAll('#split br')).toHaveLength(1);
  });

  it('grounds the recovered word across its exact original text-node offsets and keeps the next word aligned', () => {
    const document = source('<div id="split">The micro<strong>scope</strong> records each sample before the final analysis begins.</div>');
    const article = extract(document), block = document.querySelector('#split');
    expect(article.chunks?.[0]?.speech).toBe(first);
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(...ranges) { this.ranges = ranges; } });
    for (const element of document.querySelectorAll('article, div, strong')) element.getBoundingClientRect = () => ({ top: 100, left: 40, right: 440, bottom: 140, width: 400, height: 40 });
    const highlighter = createPageHighlighter(document);
    try {
      expect(highlighter.highlightChunkByAnchor(article.chunks[0].anchorId, first, { chunkText: first, reportGrounding: true })).toEqual({ ok: true, grounded: true, fallback: false });
      expect(highlighter.highlightWord(1)).toEqual({ ok: true });
      const word = highlights.get('pagenarrator-word-0').ranges[0];
      expect(word.toString()).toBe('microscope');
      expect(word.startContainer).toBe(block.firstChild);
      expect(word.startOffset).toBe(4);
      expect(word.endContainer).toBe(block.querySelector('strong').firstChild);
      expect(word.endOffset).toBe(5);
      expect(highlighter.highlightWord(2)).toEqual({ ok: true });
      expect(highlights.get('pagenarrator-word-0').ranges[0].toString()).toBe('records');
    } finally { highlighter.dispose(); }
  });

  it('preserves source whitespace rather than joining two intentionally separated words', async () => {
    const document = source('<div>The micro <strong>scope</strong> records each sample before the final analysis begins.</div>');
    expect(await spoken(extract(document))).toEqual(['The micro scope records each sample before the final analysis begins.', second]);
  });

  it('keeps a source line break distinct from a word split, including the first following token', () => {
    const document = source('<div id="split">The micro<strong>scope</strong> records the first sample.<br>Afterwards the complete record remains available for review.</div>');
    const article = extract(document);
    expect(article.chunks?.[0]?.speech).toBe('The microscope records the first sample. Afterwards the complete record remains available for review.');
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(...ranges) { this.ranges = ranges; } });
    const highlighter = createPageHighlighter(document);
    try {
      highlighter.highlightChunkByAnchor(article.chunks[0].anchorId, article.chunks[0].speech);
      expect(highlighter.highlightWord(6)).toEqual({ ok: true });
      expect(highlights.get('pagenarrator-word-0').ranges[0].toString()).toBe('Afterwards');
    } finally { highlighter.dispose(); }
  });

  it('retains multiline code bytes and its code anchor when fallback wins', async () => {
    const document = source('<div>The micro<strong>scope</strong> records each sample before the final analysis begins.</div><pre><code>const total = sampleCount;\n  report(total);</code></pre>');
    const article = extract(document), code = article.chunks?.find(chunk => chunk.type === 'code');
    expect(article.source).toBe('article-fallback');
    expect(code?.speech).toBe('const total = sampleCount;\n  report(total);');
    expect(document.querySelector(`[data-pagenarrator-id="${code.anchorId}"]`)).toBe(document.querySelector('pre'));
    expect(await spoken(article)).toEqual([first, 'const total = sampleCount; report(total);', second]);
  });
});
