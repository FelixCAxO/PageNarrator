import { createDom, makeVisible, makeTextRangeGeometry, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('caches the page search index between chunk highlights and resets it on clear', () => {
    const dom = createDom(`
      <body>
        <p>First chunk text.</p>
        <p>Second chunk text.</p>
      </body>
    `);
    const { document } = dom.window;
    for (const paragraph of document.querySelectorAll('p')) makeVisible(paragraph);

    let treeWalks = 0;
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    document.createTreeWalker = (...args) => {
      if (args[0] === document.body && args[1] === dom.window.NodeFilter.SHOW_TEXT) {
        treeWalks += 1;
      }
      return originalCreateTreeWalker(...args);
    };

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('First chunk text.')).toEqual({ ok: true });
    expect(highlighter.highlightChunk('Second chunk text.')).toEqual({ ok: true });
    expect(treeWalks).toBe(1);

    highlighter.clearHighlights();
    expect(highlighter.highlightChunk('First chunk text.')).toEqual({ ok: true });
    expect(treeWalks).toBe(2);
  });

  it('invalidates the cached page search index after visible DOM text changes', async () => {
    const dom = createDom(`
      <body>
        <p>First chunk text.</p>
      </body>
    `);
    const { document } = dom.window;
    const paragraph = document.querySelector('p');
    makeVisible(paragraph);

    let treeWalks = 0;
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    document.createTreeWalker = (...args) => {
      if (args[0] === document.body && args[1] === dom.window.NodeFilter.SHOW_TEXT) {
        treeWalks += 1;
      }
      return originalCreateTreeWalker(...args);
    };

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('First chunk text.')).toEqual({ ok: true });
    paragraph.textContent = 'Updated chunk text.';
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));

    expect(highlighter.highlightChunk('Updated chunk text.')).toEqual({ ok: true });
    expect(treeWalks).toBe(2);
  });

  it.each(['innerWidth', 'innerHeight'])('refreshes responsive text before the %s resize event arrives', (dimension) => {
    const dom = createDom('<p>Initial introduction.</p><p>Responsive passage contains distinctive vocabulary.</p>');
    const { document } = dom.window;
    const [intro, passage] = document.querySelectorAll('p');
    makeVisible(intro);
    Object.defineProperty(dom.window, dimension, { value: 1000, configurable: true });
    passage.getBoundingClientRect = () => ({ top: 120, left: 80,
      width: dom.window[dimension] === 500 ? 340 : 0, height: dom.window[dimension] === 500 ? 60 : 0 });
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk(intro.textContent)).toEqual({ ok: true });
    Object.defineProperty(dom.window, dimension, { value: 500, configurable: true });
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: true });
    Object.defineProperty(dom.window, dimension, { value: 1000, configurable: true });
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: false });
    highlighter.dispose();
  });

  it.each([
    ['hidden', ''],
    ['aria-hidden', 'true'],
    ['style', 'display: none'],
    ['style', 'opacity: 0'],
    ['class', 'sidebar'],
    ['role', 'navigation'],
    ['id', 'sidebar'],
  ])('refreshes fallback highlighting when %s reveals or hides a passage', async (attribute, value) => {
    const dom = createDom('<p>Initial introduction.</p><p>Newly revealed passage contains distinctive vocabulary.</p>');
    const { document } = dom.window;
    const [intro, passage] = document.querySelectorAll('p');
    makeVisible(intro);
    makeVisible(passage);
    passage.setAttribute(attribute, value);
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk(intro.textContent)).toEqual({ ok: true });
    passage.removeAttribute(attribute);
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: true });

    passage.setAttribute(attribute, value);
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: false });
    highlighter.dispose();
  });

  it('uses replaced text even before the mutation observer callback runs', () => {
    const dom = createDom('<p>Original article paragraph.</p>');
    const { document } = dom.window;
    const paragraph = document.querySelector('p');
    makeVisible(paragraph);
    const highlighter = createPageHighlighter(document);
    const highlighted = installHighlightCapture();

    expect(highlighter.highlightChunk(paragraph.textContent)).toEqual({ ok: true });
    paragraph.textContent = 'Replacement passage has completely different vocabulary.';
    expect(highlighter.highlightChunk(paragraph.textContent)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk').text).toBe(paragraph.textContent);
    highlighter.dispose();
  });

  it('refreshes searchable text when a responsive layout reveals a passage', () => {
    const dom = createDom('<p>Initial introduction.</p><p>Responsive passage contains distinctive vocabulary.</p>');
    const { document } = dom.window;
    const [intro, passage] = document.querySelectorAll('p');
    makeVisible(intro);
    let revealed = false;
    passage.getBoundingClientRect = () => ({ top: 120, left: 80, width: revealed ? 340 : 0, height: revealed ? 60 : 0 });
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk(intro.textContent)).toEqual({ ok: true });
    revealed = true;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: true });
    highlighter.dispose();
  });

  it('recovers from a missed highlight when resizing reveals the first passage', () => {
    const dom = createDom('<p>Responsive passage contains distinctive vocabulary.</p>');
    const { document } = dom.window;
    const passage = document.querySelector('p');
    let revealed = false;
    passage.getBoundingClientRect = () => ({ top: 120, left: 80, width: revealed ? 340 : 0, height: revealed ? 60 : 0 });
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: false });
    revealed = true;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(highlighter.highlightChunk(passage.textContent)).toEqual({ ok: true });
    highlighter.dispose();
  });

  it('does not reuse stale search-index ranges after the matched node is removed', async () => {
    const dom = createDom(`
      <body>
        <main>
          <p id="old">Old removable chunk.</p>
        </main>
      </body>
    `);
    const { document } = dom.window;
    const main = document.querySelector('main');
    const oldParagraph = document.getElementById('old');
    makeVisible(main);
    makeVisible(oldParagraph);
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Old removable chunk.')).toEqual({ ok: true });
    oldParagraph.remove();
    const newParagraph = document.createElement('p');
    newParagraph.id = 'new';
    newParagraph.textContent = 'New connected chunk.';
    makeVisible(newParagraph);
    main.append(newParagraph);
    await new Promise((resolve) => dom.window.queueMicrotask(resolve));

    expect(highlighter.highlightChunk('New connected chunk.')).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk').text).toBe('New connected chunk.');
  });

  it('fails cheaply instead of building a huge fallback character map', () => {
    const oversizedText = `${'x'.repeat(260_000)}target phrase after cap`;
    const dom = createDom(`
      <body>
        <main>
          <p>${oversizedText}</p>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('main'));
    makeVisible(document.querySelector('p'));

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('target phrase after cap')).toEqual({
      ok: false,
      reason: 'fallback-index-too-large',
    });
    expect(document.querySelector('[data-pagenarrator-region]')).toBeNull();
  });

  it('skips applying current-block class to a zero-box display:contents element', () => {
    const dom = createDom(`
      <body>
        <div style="display:contents">
          <span>Content inside a display:contents wrapper</span>
        </div>
      </body>
    `);
    const { document } = dom.window;
    const wrapper = document.querySelector('div');
    wrapper.getBoundingClientRect = () => ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    });
    makeVisible(document.querySelector('span'));
    makeTextRangeGeometry(dom.window, {
      top: 120, left: 80, right: 400, bottom: 150, width: 320, height: 30,
    });

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Content inside a display:contents wrapper')).toEqual({ ok: true });
    expect(wrapper.classList.contains('pagenarrator-current-block')).toBe(false);

    const overlay = document.querySelector('[data-pagenarrator-region]');
    expect(overlay).not.toBeNull();
    expect(overlay.style.display).toBe('block');
  });
});
