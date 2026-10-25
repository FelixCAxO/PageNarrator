import { createDocument, read } from './reading-model.fixtures.js';
import { describe, expect, it } from 'vitest';

import { buildReadingModel, extractReadableArticle, getDomWordIndexForSpeechWord, renderReadingModelForSpeechChunks } from "../../src/lib/reading-model.js";

describe('reading model extraction', () => {
  it('reads MathJax-rendered formulas once by ignoring hidden assistive math mirrors', () => {
    const speech = read(`
      <title>Dot Product</title>
      <main>
        <p>
          For example, if we have the two vectors
          <mjx-container class="MathJax">
            <mjx-assistive-mml aria-hidden="true">
              <math><mi>v</mi><mo>=</mo><mrow><mo>[</mo><mi>v1</mi><mo>,</mo><mi>v2</mi><mo>,</mo><mi>v3</mi><mo>]</mo></mrow></math>
            </mjx-assistive-mml>
            <mjx-math><mjx-mi>v</mjx-mi><mjx-mo>=</mjx-mo><mjx-mrow>[v1,v2,v3]</mjx-mrow></mjx-math>
          </mjx-container>
          and
          <span class="MathJax">
            <span class="MJX_Assistive_MathML" aria-hidden="true">w=[w1,w2,w3]</span>
            <span>w=[w1,w2,w3]</span>
          </span>
          their dot product is
          <mjx-container class="MathJax">
            <mjx-assistive-mml aria-hidden="true">
              <math><mi>v</mi><mo>⋅</mo><mi>w</mi><mo>=</mo><mi>v1w1</mi><mo>+</mo><mi>v2w2</mi><mo>+</mo><mi>v3w3</mi></math>
            </mjx-assistive-mml>
            <mjx-math><mjx-mi>v</mjx-mi><mjx-mo>⋅</mjx-mo><mjx-mi>w</mjx-mi><mjx-mo>=</mjx-mo><mjx-mi>v1w1</mjx-mi><mjx-mo>+</mjx-mo><mjx-mi>v2w2</mjx-mi><mjx-mo>+</mjx-mo><mjx-mi>v3w3</mjx-mi></mjx-math>
          </mjx-container>.
          Essentially, the entries are multiplied and added together.
        </p>
      </main>
    `);

    expect(speech).toContain('For example, if we have the two vectors v=[v1,v2,v3] and w=[w1,w2,w3] their dot product is v⋅w=v1w1+v2w2+v3w3.');
    expect(speech).not.toContain('v=[v1,v2,v3] v=[v1,v2,v3]');
    expect(speech).not.toContain('w=[w1,w2,w3] w=[w1,w2,w3]');
  });

  it('deduplicates multiple visible MathJax formula renderings inside one inline math container', () => {
    const speech = read(`
      <title>Dot Product</title>
      <main>
        <p>
          Basically, a single unit in a neural network can have a input of
          <span class="MathJax">
            <span>v1,...,vn</span>
            <span>v1,...,vn</span>
            <span>{v1,...,vn}</span>
          </span>.
          To process this input, we can use a vector filled with weights
          <mjx-container>
            <mjx-math>w1,...,wn</mjx-math>
            <mjx-math>w1,...,wn</mjx-math>
            <mjx-math>{w1,...,wn}</mjx-math>
          </mjx-container>
          to determine how strong we want the connection of each input to be.
        </p>
      </main>
    `);

    expect(speech).toContain('Basically, a single unit in a neural network can have a input of v1,...,vn. To process this input, we can use a vector filled with weights w1,...,wn to determine how strong we want the connection of each input to be.');
    expect(speech).not.toContain('v1,...,vnv1,...,vn');
    expect(speech).not.toContain('w1,...,wnw1,...,wn');
  });

  it('includes meaningful media descriptions, captions, and table summaries', () => {
    const speech = read(`
      <title>Launch Metrics</title>
      <main>
        <figure>
          <img src="chart.png" alt="Chart showing sales increasing in 2026">
          <figcaption>Sales increased after launch.</figcaption>
        </figure>
        <table>
          <caption>Plan prices</caption>
          <tr><th>Name</th><th>Price</th></tr>
          <tr><td>Basic</td><td>$5</td></tr>
          <tr><td>Pro</td><td>$9</td></tr>
        </table>
      </main>
    `);

    expect(speech).toContain('Chart showing sales increasing in 2026.');
    expect(speech).toContain('Sales increased after launch.');
    expect(speech).toContain('Table: Plan prices. 2 columns: Name and Price.');
    expect(speech).toContain('Name, Basic - Price, $5.');
    expect(speech).toContain('Name, Pro - Price, $9.');
  });

  it('skips image alt text that is technical, decorative, duplicated, or too long', () => {
    const speech = read(`
      <title>Gallery</title>
      <main>
        <img alt="IMG_4823.jpg">
        <img alt="e8b4f9a2">
        <img alt="Loading">
        <figure>
          <img alt="Sales increased after launch">
          <figcaption>Sales increased after launch.</figcaption>
        </figure>
        <img alt="${'Detailed duplicate wording '.repeat(20)}">
        <img alt="Chart showing sales increasing in 2026">
      </main>
    `);

    expect(speech).not.toContain('IMG_4823');
    expect(speech).not.toContain('e8b4f9a2');
    expect(speech).not.toContain('Loading');
    expect(speech.match(/Sales increased after launch/g)).toHaveLength(1);
    expect(speech).toContain('Chart showing sales increasing in 2026.');
  });

  it('anchors table rows to raw cell text instead of spoken header prefixes', () => {
    const document = createDocument(`
      <title>Launch Metrics</title>
      <main>
        <table>
          <caption>Plan prices</caption>
          <tr><th>Name</th><th>Price</th></tr>
          <tr><td>Basic</td><td>$5</td></tr>
        </table>
      </main>
    `);
    const chunks = renderReadingModelForSpeechChunks(buildReadingModel(document));
    const tableId = document.querySelector('table').dataset.pagenarratorId;
    const rowId = document.querySelectorAll('tr')[1].dataset.pagenarratorId;

    expect(tableId).toMatch(/\d+/);
    expect(rowId).toMatch(/\d+/);

    expect(chunks).toContainEqual({
      type: 'table',
      speech: 'Table: Plan prices. 2 columns: Name and Price.',
      text: 'Table: Plan prices. 2 columns: Name and Price.',
      anchorText: 'Plan prices Name Price',
      anchorId: tableId,
      speechPrefixWords: 0,
      speechWordMap: [-1, 0, 1, -1, -1, 2, -1, 3],
      globalDomWordStartIndex: 0,
    });
    expect(chunks).toContainEqual({
      type: 'table-row',
      speech: 'Name, Basic - Price, $5.',
      text: 'Name, Basic - Price, $5.',
      anchorText: 'Basic $5',
      anchorId: rowId,
      parentAnchorId: tableId,
      speechPrefixWords: 0,
      speechWordMap: [-1, 0, -1, 1],
      globalDomWordStartIndex: 0,
    });
  });

  it('maps spoken word timings to DOM words without article speech prefixes', () => {
    const heading = renderReadingModelForSpeechChunks(buildReadingModel(createDocument(`
      <title>Setup Guide</title>
      <main>
        <h2>Why structure matters</h2>
      </main>
    `))).find((chunk) => chunk.type === 'heading');

    expect(getDomWordIndexForSpeechWord(heading, 0)).toBe(0);
    expect(getDomWordIndexForSpeechWord(heading, 1)).toBe(1);
    expect(getDomWordIndexForSpeechWord(heading, 2)).toBe(2);
    expect(getDomWordIndexForSpeechWord('Plain fallback text.', 1)).toBe(1);
  });

  it('maps split structured chunks to their offset inside the anchored DOM text', () => {
    const chunk = {
      anchorText: 'The first sentence. The second sentence.',
      speechPrefixWords: 0,
      domWordOffset: 3,
    };

    expect(getDomWordIndexForSpeechWord(chunk, 0)).toBe(3);
    expect(getDomWordIndexForSpeechWord(chunk, 2)).toBe(5);
  });

  it('uses precomputed global DOM word starts instead of mutable chunk offsets', () => {
    const chunk = {
      anchorText: 'The first sentence. The second sentence.',
      speechPrefixWords: 1,
      domWordOffset: 99,
      globalDomWordStartIndex: 3,
    };

    expect(getDomWordIndexForSpeechWord(chunk, 1)).toBe(3);
    expect(getDomWordIndexForSpeechWord(chunk, 3)).toBe(5);
  });

  it('maps split PDF chunks to their offset inside the rendered page text', () => {
    const chunk = {
      type: 'pdf-page',
      anchorText: 'The first sentence. The second sentence.',
      speechPrefixWords: 0,
      domWordOffset: 3,
    };

    expect(getDomWordIndexForSpeechWord(chunk, 0)).toBe(3);
    expect(getDomWordIndexForSpeechWord(chunk, 2)).toBe(5);
  });

  it('resumes the anchor counter from existing data-pagenarrator-id values so re-extraction never collides', () => {
    const document = createDocument(`
      <title>Setup Guide</title>
      <main>
        <h2 data-pagenarrator-id="42">Why structure matters</h2>
        <p>Headings and paragraphs give listeners orientation.</p>
      </main>
    `);

    const article = extractReadableArticle(document);
    const paragraph = document.querySelector('p');

    expect(paragraph.dataset.pagenarratorId).toBe('43');
    expect(article.chunks.find((chunk) => chunk.type === 'heading').anchorId).toBe('42');
    expect(article.chunks.find((chunk) => chunk.type === 'paragraph').anchorId).toBe('43');
  });

  it('skips hidden, noisy, and irrelevant page furniture', () => {
    const speech = read(`
      <title>Clean Page</title>
      <main>
        <div class="cookie">Accept all cookies</div>
        <div class="ad">Sponsored content</div>
        <p hidden>Invisible text</p>
        <p style="display: none">Also invisible</p>
        <p aria-hidden="true">Decorative duplicate</p>
        <aside>Related stories repeated everywhere</aside>
        <p>The readable sentence remains.</p>
      </main>
    `);

    expect(speech).toContain('The readable sentence remains.');
    expect(speech).not.toContain('Accept all cookies');
    expect(speech).not.toContain('Sponsored content');
    expect(speech).not.toContain('Invisible text');
    expect(speech).not.toContain('Decorative duplicate');
    expect(speech).not.toContain('Related stories');
  });
});
