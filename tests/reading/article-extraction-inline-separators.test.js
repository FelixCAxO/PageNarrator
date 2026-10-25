import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseArticleExtraction, iterateArticleSpeechChunks } from '../../src/lib/article-extraction.js';
import { isArticleDocument, parseArticleDocument } from '../../src/engines/article-extractor.js';

const second = 'The second observation explains the complete source record in ordinary prose.';
const windows = [];
function source(markup) {
  const dom = new JSDOM(`<title>Field observations</title><article>${markup}<div>${second}</div></article>`, { url: 'https://example.test/observations' });
  windows.push(dom.window);
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

describe('fallback source separators and linked inline words', () => {
  afterEach(() => { for (const win of windows.splice(0)) win.close(); });

  it.each([' ', '\n', '\t'])('keeps a whitespace-only source node between formatted words: %j', async (gap) => {
    const document = source(`<div id="split">The <em>first</em>${gap}<strong>second</strong> observations explain how each sample remains in its original source order.</div>`);
    const block = document.querySelector('#split'), separator = block.querySelector('em').nextSibling;
    const article = extract(document);
    expect(article.source).toBe('article-fallback');
    expect(await spoken(article)).toEqual(['The first second observations explain how each sample remains in its original source order.', second]);
    expect(separator.nodeValue).toBe(gap);
    expect(separator).toBe(block.querySelector('em').nextSibling);
  });

  it.each([
    'The micro<a href="/instrument">scope</a> records each sample before the final analysis begins.',
    'The <a href="/instrument">microscope</a> records each sample before the final analysis begins.',
  ])('keeps inline linked text in its original paragraph when a code article uses fallback', async (markup) => {
    const document = source(`<div id="split">${markup}</div><pre><code>const total = sampleCount;</code></pre>`);
    const block = document.querySelector('#split'), link = block.querySelector('a'), text = link.firstChild;
    const article = extract(document);
    expect(article.source).toBe('article-fallback');
    expect(await spoken(article)).toEqual(['The microscope records each sample before the final analysis begins.', 'const total = sampleCount;', second]);
    expect(document.querySelector(`[data-pagenarrator-id="${article.chunks[0].anchorId}"]`)).toBe(block);
    expect(link.firstChild).toBe(text);
    expect(link.getAttribute('href')).toBe('/instrument');
  });

  it('does not turn excluded whitespace into a separator inside a source word', async () => {
    const document = source('<div>The micro<span hidden> \n\t </span><strong>scope</strong> records each sample before the final analysis begins.</div>');
    expect(await spoken(extract(document))).toEqual(['The microscope records each sample before the final analysis begins.', second]);
  });

  it('keeps ordinary standalone links on the structured link path', () => {
    const dom = new JSDOM('<title>Field observations</title><main><a id="report" href="/report">Open the field report</a></main>', { url: 'https://example.test/observations' });
    windows.push(dom.window);
    const document = dom.window.document, article = extract(document), link = article.chunks.find(chunk => chunk.type === 'link');
    expect(article.source).toBe('reading-model');
    expect(link.anchorText).toBe('Open the field report');
    expect(document.querySelector(`[data-pagenarrator-id="${link.anchorId}"]`)).toBe(document.querySelector('#report'));
  });
});
