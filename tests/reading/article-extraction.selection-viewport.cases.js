import { createDocument } from './article-extraction.fixtures.js';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { chooseArticleExtraction } from "../../src/lib/article-extraction.js";

describe('article extraction priority', () => {
  it('reads the user selection when it has substantial text', () => {
    const document = createDocument(
      `<title>Page</title><main><p>This is a selected passage that easily exceeds forty characters of content.</p></main>`,
      { selection: '   This is a selected passage that easily exceeds forty characters of content.   ' },
    );

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
      readSelection: true,
    });

    expect(result.source).toBe('selection');
    expect(result.text).toBe('This is a selected passage that easily exceeds forty characters of content.');
    expect(result.chunks).toEqual([expect.objectContaining({
      speech: 'This is a selected passage that easily exceeds forty characters of content.',
      anchorText: 'This is a selected passage that easily exceeds forty characters of content.',
      anchorId: expect.stringMatching(/^sel-\d+$/),
      speechPrefixWords: 0,
    })]);
    expect(result.title).toBe(document.title);
    expect(result.url).toBe('https://example.test/article');
  });

  it('anchors multi-paragraph selected text to each selected block', () => {
    const dom = new JSDOM(`
      <title>Page</title>
      <main>
        <p id="first">Ignore these words. Selected first sentence for playback.</p>
        <p id="second">But first of all lets answer one fundamental question. Another sentence after selection.</p>
      </main>
    `, { url: 'https://example.test/article' });
    const { document } = dom.window;
    const firstText = document.querySelector('#first').firstChild;
    const secondText = document.querySelector('#second').firstChild;
    const range = document.createRange();
    range.setStart(firstText, firstText.nodeValue.indexOf('Selected'));
    range.setEnd(secondText, secondText.nodeValue.indexOf(' Another sentence'));
    dom.window.getSelection = () => ({
      toString: () => range.toString(),
      rangeCount: 1,
      getRangeAt: () => range,
    });

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
      readSelection: true,
    });

    expect(result.source).toBe('selection');
    expect(result.chunks).toEqual([
      expect.objectContaining({
        speech: 'Selected first sentence for playback.',
        anchorId: document.querySelector('#first').dataset.pagenarratorId,
        domWordOffset: 3,
      }),
      expect.objectContaining({
        speech: 'But first of all lets answer one fundamental question.',
        anchorId: document.querySelector('#second').dataset.pagenarratorId,
      }),
    ]);
    expect(result.startPosition).toMatchObject({
      source: 'selection',
      anchorId: document.querySelector('#first').dataset.pagenarratorId,
    });
  });

  it('ignores tiny selections so an accidental click does not narrate one word', () => {
    const document = createDocument(
      `<title>Page</title><main><h1>Page</h1><p>The body text in this article is meaningful and worth reading aloud.</p></main>`,
      { selection: 'short' },
    );

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(result.source).toBe('reading-model');
    expect(result.text).toContain('Page.');
    expect(result.text).toContain('The body text in this article is meaningful and worth reading aloud.');
    expect(result.chunks?.length).toBeGreaterThan(0);
  });

  it('returns a clear selection error when the explicit selected-text action has no selection', () => {
    const document = createDocument(
      `<title>Page</title><main><p>The body text is available but no selection is active.</p></main>`,
    );

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
      readSelection: true,
    });

    expect(result).toMatchObject({
      source: 'selection',
      text: '',
      chunks: [],
      error: 'Select text on the page first.',
    });
  });

  it('reports the first visible anchored article block as the read-page start position', () => {
    const document = createDocument(`
      <title>Visible Article</title>
      <main>
        <h1>Visible Article</h1>
        <p id="first">The earlier paragraph is above the viewport.</p>
        <p id="second">The visible paragraph should be the default starting section.</p>
      </main>
    `);
    Object.defineProperty(document.defaultView, 'innerHeight', { value: 700, configurable: true });
    document.querySelector('h1').getBoundingClientRect = () => ({ top: -160, bottom: -120, left: 0, right: 400, width: 400, height: 40 });
    document.querySelector('#first').getBoundingClientRect = () => ({ top: -80, bottom: -20, left: 0, right: 400, width: 400, height: 60 });
    document.querySelector('#second').getBoundingClientRect = () => ({ top: 120, bottom: 180, left: 0, right: 400, width: 400, height: 60 });

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(result.startPosition).toEqual({
      source: 'viewport',
      anchorId: document.querySelector('#second').dataset.pagenarratorId,
      text: 'The visible paragraph should be the default starting section.',
    });
  });

  it('skips a paragraph whose last line is all that remains at the top of the screen', () => {
    const document = createDocument(`
      <title>Visible Article</title>
      <main>
        <p id="first">The previous paragraph was already read and only its final line is still visible.</p>
        <p id="second">The next paragraph starts on screen and is where the reader expects to begin.</p>
      </main>
    `);
    Object.defineProperty(document.defaultView, 'innerHeight', { value: 800, configurable: true });
    document.querySelector('#first').getBoundingClientRect = () => ({ top: -680, bottom: 24, left: 0, right: 400, width: 400, height: 704 });
    document.querySelector('#second').getBoundingClientRect = () => ({ top: 48, bottom: 200, left: 0, right: 400, width: 400, height: 152 });

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(result.startPosition).toMatchObject({ anchorId: document.querySelector('#second').dataset.pagenarratorId });
  });

  it('keeps a tall paragraph that fills the screen as the start', () => {
    const document = createDocument(`
      <title>Visible Article</title>
      <main>
        <p id="first">A very long paragraph that the reader is partway through and still filling the screen.</p>
        <p id="second">The next paragraph only peeks in at the bottom of the screen.</p>
      </main>
    `);
    Object.defineProperty(document.defaultView, 'innerHeight', { value: 800, configurable: true });
    document.querySelector('#first').getBoundingClientRect = () => ({ top: -900, bottom: 700, left: 0, right: 400, width: 400, height: 1600 });
    document.querySelector('#second').getBoundingClientRect = () => ({ top: 720, bottom: 900, left: 0, right: 400, width: 400, height: 180 });

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(result.startPosition).toMatchObject({ anchorId: document.querySelector('#first').dataset.pagenarratorId });
  });

  it('can ignore the viewport start position when restarting from the top', () => {
    const document = createDocument(`
      <title>Visible Article</title>
      <main>
        <h1>Visible Article</h1>
        <p id="first">The earlier paragraph is above the viewport.</p>
        <p id="second">The visible paragraph should not become the restart point.</p>
      </main>
    `);
    Object.defineProperty(document.defaultView, 'innerHeight', { value: 700, configurable: true });
    document.querySelector('h1').getBoundingClientRect = () => ({ top: -160, bottom: -120, left: 0, right: 400, width: 400, height: 40 });
    document.querySelector('#first').getBoundingClientRect = () => ({ top: -80, bottom: -20, left: 0, right: 400, width: 400, height: 60 });
    document.querySelector('#second').getBoundingClientRect = () => ({ top: 120, bottom: 180, left: 0, right: 400, width: 400, height: 60 });

    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
      startMode: 'top',
    });

    expect(result.startPosition).toBeUndefined();
  });
});
