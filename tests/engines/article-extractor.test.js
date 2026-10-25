import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { isArticleDocument, parseArticleDocument } from '../../src/engines/article-extractor.js';

const first = 'The browser reads this complete paragraph, including the meaningful inline link and all punctuation.';
const second = 'A second paragraph explains how the document continues without menus or subscription prompts.';
const document = html => new JSDOM(`<title>Browser article</title>${html}`).window.document;

describe('first-party article fallback', () => {
  it('extracts prose in DOM order, retains inline text and never clones or mutates the page', () => {
    const doc = document(`<article><header><h1>Article heading</h1></header><p>${first}</p><div>Before <strong>inline prose</strong><p>${second}</p>After the nested paragraph.</div></article><footer>Footer text</footer>`);
    const before = doc.documentElement.outerHTML, clone = vi.spyOn(doc, 'cloneNode');
    const result = parseArticleDocument(doc);
    expect(result.title).toBe('Article heading');
    expect(result.textContent).toBe(`Article heading\n\n${first}\n\nBefore inline prose\n\n${second}\n\nAfter the nested paragraph.`);
    expect(doc.documentElement.outerHTML).toBe(before); expect(clone).not.toHaveBeenCalled();
  });
  it('keeps all top-level paragraphs when there is no article container', () => {
    const result = parseArticleDocument(document(`<p>${first.repeat(3)}</p><p>${second}</p>`));
    expect(result.textContent).toBe(`${first.repeat(3)}\n\n${second}`);
  });
  it('excludes hidden, interactive, navigation and link-heavy furniture', () => {
    const doc = document(`<nav>${first.repeat(5)}</nav><main><p>${first}</p><div hidden>${second}</div><p style="display: none">Hidden paragraph</p><button>Submit form</button><p>${second}</p></main><aside>${first.repeat(5)}</aside>`);
    expect(parseArticleDocument(doc).textContent).toBe(`${first}\n\n${second}`);
  });
  it('honors an explicit root and reads title and author metadata', () => {
    const doc = document(`<meta property="og:title" content="Published title"><meta name="author" content="Author"><article id="a"><p>${first}</p></article><article id="b"><p>${second}</p></article>`);
    expect(parseArticleDocument(doc, { root: doc.querySelector('#b') })).toMatchObject({ title: 'Published title', byline: 'Author', textContent: second });
  });
  it('respects computed CSS visibility and permits a child to override inherited visibility', () => {
    const doc = document(`<style>.removed{display:none}.invisible{visibility:hidden}.restored{visibility:visible}.locked{content-visibility:hidden}</style>
      <article><h1 class="removed">Hidden heading</h1><h1>Visible heading</h1><p>${first}</p>
      <section class="removed"><p style="display:block">Still hidden by an ancestor.</p></section>
      <section class="invisible"><p>Hidden by inherited visibility.</p><p class="restored">${second}</p></section>
      <div class="locked"><p>Hidden by skipped rendering.</p></div></article>`);
    expect(parseArticleDocument(doc)).toMatchObject({ title: 'Visible heading', textContent: `Visible heading\n\n${first}\n\n${second}` });
  });
  it('does not report an empty or navigation-only page as an article', () => {
    expect(isArticleDocument(document(''))).toBe(false);
    expect(parseArticleDocument(document('<nav><a href="/">Navigation only</a></nav>'))).toBeNull();
    expect(parseArticleDocument(document(`<div>${Array.from({ length: 20 }, () => '<a href="/">Menu link</a>').join(' ')}</div>`))).toBeNull();
  });
  it('does not let an article header bypass ARIA, inert or noisy-ancestor exclusions', () => {
    const doc = document(`<article><header aria-hidden="true"><h1>Hidden title</h1><p>Secret header contents.</p></header>
      <aside><header><p>Promotional header contents.</p></header></aside>
      <header inert><p>Inactive header contents.</p></header><header><h1>Visible title</h1></header>
      <p>${first}</p><p>${second}</p></article>`);
    expect(parseArticleDocument(doc)).toMatchObject({ title: 'Visible title', textContent: `Visible title\n\n${first}\n\n${second}` });
  });
  it('anchors explicit custom or inline roots inside their scope rather than an outside block', () => {
    for (const tag of ['span', 'article-content']) {
      const doc = document(`<p>Outside before. <${tag} role="main">${first}</${tag}> Outside after.</p>`);
      expect(parseArticleDocument(doc, { root: doc.querySelector('[role="main"]') })?.textContent).toBe(first);
    }
  });
});
