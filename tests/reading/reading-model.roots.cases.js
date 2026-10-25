import { createDocument, read } from './reading-model.fixtures.js';
import { describe, expect, it } from 'vitest';

import { buildReadingModel, extractReadableArticle, renderReadingModelForSpeech } from "../../src/lib/reading-model.js";

describe('reading model extraction', () => {
  it('prefers the Ghost markdown article body over promo blocks in the article wrapper', () => {
    const speech = read(`
      <title>Dot Product in Deep Learning</title>
      <main>
        <article class="post-full">
          <section class="post-full-content">
            <center><a><img alt="DSA Takeover Cheatsheet"></a></center>
            <p style="text-align: center;"><a>Open-Source Internship opportunity by OpenGenus for programmers. Apply now.</a></p>
            <div class="kg-card-markdown">
              <p>In this article at OpenGenus, we have explored dot product in deep learning.</p>
              <h2>Table of Contents</h2>
              <ol><li>Dot Product</li></ol>
            </div>
          </section>
        </article>
      </main>
    `);

    expect(speech).toContain('In this article at OpenGenus, we have explored dot product in deep learning.');
    expect(speech).toContain('Table of Contents:');
    expect(speech).not.toContain('DSA Takeover Cheatsheet');
    expect(speech).not.toContain('Open-Source Internship opportunity');
  });

  it('chooses the focused nested article root instead of every readable block in a broad main', () => {
    const speech = read(`
      <title>Focused reporting</title>
      <main>
        <section class="promo">
          <h2>Subscribe for more briefings</h2>
          <p>Promo copy should not be the first thing a listener hears.</p>
        </section>
        <article>
          <h1>Focused reporting</h1>
          <p>The investigation begins with the main findings and gives listeners the article body first.</p>
          <p>Reporters then explain the supporting evidence in a second paragraph with concrete details.</p>
        </article>
        <div class="comments">
          <h2>Comments</h2>
          <p>A reader comment repeats nearby keywords but is not part of the article narrative.</p>
          <p>Another comment should stay out of the narrated article root.</p>
        </div>
      </main>
    `);

    expect(speech).toContain('The investigation begins with the main findings');
    expect(speech).toContain('Reporters then explain the supporting evidence');
    expect(speech).not.toContain('Subscribe for more briefings');
    expect(speech).not.toContain('Promo copy should not be');
    expect(speech).not.toContain('A reader comment repeats');
    expect(speech).not.toContain('Another comment should stay out');
  });

  it.each(['before', 'after'])('retains unwrapped primary prose when an author article is %s it', (position) => {
    const biography = '<article><h3>About the author</h3><p>This author biography belongs to a separate teaser and should not replace the primary story.</p></article>';
    const prose = Array.from({ length: 8 }, (_, index) => `<p>Primary paragraph ${index + 1} explains the investigation, its evidence, methods and useful consequences for readers.</p>`).join('');
    const speech = read(`<title>Primary story</title>
      <div><h1>Primary story</h1>${position === 'before' ? biography : ''}
        <div>${prose.slice(0, prose.indexOf('<p>Primary paragraph 5'))}<h2>Further findings</h2>${prose.slice(prose.indexOf('<p>Primary paragraph 5'))}</div>
        ${position === 'after' ? biography : ''}
      </div>`);
    for (let index = 1; index <= 8; index++) expect(speech).toContain(`Primary paragraph ${index}`);
    expect(speech).toContain('Further findings:');
    expect(speech).not.toContain('author biography');
    expect(speech.indexOf('Primary paragraph 4')).toBeLessThan(speech.indexOf('Further findings:'));
    expect(speech.indexOf('Further findings:')).toBeLessThan(speech.indexOf('Primary paragraph 5'));
  });

  it('keeps a focused encyclopedia root when a reference-heavy paragraph container scores higher', () => {
    const references = Array.from({ length: 30 }, (_, index) => `<p>Reference entry ${index + 1} describes a separate publication.</p>`).join('');
    const speech = read(`<title>Encyclopedia topic</title><h1>Encyclopedia topic</h1>
      <div class="mw-parser-output"><p>This is the primary encyclopedia explanation.</p>
        ${'<aside>Supplementary navigation</aside>'.repeat(25)}
        <div class="references">${references}</div>
      </div>`);
    expect(speech).toContain('This is the primary encyclopedia explanation.');
  });

  it('emits highlight anchors without synthetic narration prefixes', () => {
    const document = createDocument(`
      <title>Setup Guide</title>
      <main>
        <h1>Setup Guide</h1>
        <h2>Why structure matters</h2>
        <ol>
          <li>Install the extension</li>
          <li>Open a webpage</li>
        </ol>
      </main>
    `);
    const article = extractReadableArticle(document);
    const titleId = document.querySelector('h1').dataset.pagenarratorId;
    const headingId = document.querySelector('h2').dataset.pagenarratorId;
    const listId = document.querySelector('ol').dataset.pagenarratorId;

    expect(titleId).toMatch(/\d+/);
    expect(headingId).toMatch(/\d+/);
    expect(listId).toMatch(/\d+/);

    expect(article.chunks).toContainEqual({
      type: 'page-title',
      speech: 'Setup Guide.',
      text: 'Setup Guide.',
      anchorText: 'Setup Guide',
      anchorId: titleId,
      speechPrefixWords: 0,
      globalDomWordStartIndex: 0,
    });
    expect(article.chunks).toContainEqual({
      type: 'heading',
      speech: 'Why structure matters:',
      text: 'Why structure matters:',
      anchorText: 'Why structure matters',
      anchorId: headingId,
      speechPrefixWords: 0,
      globalDomWordStartIndex: 0,
    });
    expect(article.chunks.some((chunk) => chunk.type === 'list-item')).toBe(false);
    expect(article.chunks).toContainEqual({
      type: 'list',
      speech: 'List of 2 items: Install the extension, Open a webpage.',
      text: 'List of 2 items: Install the extension, Open a webpage.',
      anchorText: 'Install the extension Open a webpage',
      anchorId: listId,
      speechPrefixWords: 4,
      globalDomWordStartIndex: 0,
    });
    expect(article.text).toBe(renderReadingModelForSpeech(buildReadingModel(createDocument(`
      <title>Setup Guide</title>
      <main>
        <h1>Setup Guide</h1>
        <h2>Why structure matters</h2>
        <ol>
          <li>Install the extension</li>
          <li>Open a webpage</li>
        </ol>
      </main>
    `))));
  });

  it('anchors the spoken page title to a visible article header heading', () => {
    const document = createDocument(`
      <title>Bias in Machine learning - Example</title>
      <main>
        <article>
          <header>
            <h1>Bias in Machine learning</h1>
          </header>
          <p>The article body explains model bias with concrete examples.</p>
        </article>
      </main>
    `);
    const article = extractReadableArticle(document);
    const titleId = document.querySelector('h1').dataset.pagenarratorId;

    expect(titleId).toMatch(/\d+/);
    expect(article.chunks[0]).toEqual({
      type: 'page-title',
      speech: 'Bias in Machine learning.',
      text: 'Bias in Machine learning.',
      anchorText: 'Bias in Machine learning',
      anchorId: titleId,
      speechPrefixWords: 0,
      globalDomWordStartIndex: 0,
    });
  });

  it('builds a lazy chunk iterable and does not scan headings outside the chosen root before iteration starts', () => {
    const document = createDocument(`
      <title>Rooted article</title>
      <main>
        <article>
          <h1>Rooted article</h1>
          <p>The story stays focused inside the article root.</p>
        </article>
      </main>
      <aside>
        <h1 id="promo">Rooted article</h1>
      </aside>
    `);
    const outsideHeading = document.querySelector('#promo');
    let outsideHeadingTouched = false;
    const originalGetComputedStyle = document.defaultView.getComputedStyle.bind(document.defaultView);
    document.defaultView.getComputedStyle = (element) => {
      if (element === outsideHeading) {
        outsideHeadingTouched = true;
        throw new Error('outside-root heading should not be measured');
      }
      return originalGetComputedStyle(element);
    };
    outsideHeading.getBoundingClientRect = () => {
      outsideHeadingTouched = true;
      throw new Error('outside-root heading should not be measured');
    };

    const model = buildReadingModel(document);

    expect(typeof model.chunks?.[Symbol.iterator]).toBe('function');
    expect(outsideHeadingTouched).toBe(false);
    expect(model.chunks[Symbol.iterator]().next().value).toMatchObject({
      type: 'page-title',
      text: 'Rooted article.',
    });
    expect(outsideHeadingTouched).toBe(false);
  });
});
