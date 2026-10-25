import { createDocument, read } from './reading-model.fixtures.js';
import { describe, expect, it } from 'vitest';

import { extractReadableArticle, extractReadableText, renderReadingModelForSpeechChunks } from "../../src/lib/reading-model.js";

it.each(['”', '’', ')]'])('preserves sentence punctuation before closing %s without adding a second stop', (closing) => {
  const text = `The woodland remains quiet.${closing}`;
  expect(read(`<main><p>${text}</p></main>`)).toBe(text);
});

it.each([
  '你好！今天我们一起阅读一个关于安静花园的小故事。',
  'こんにちは。今日は静かな庭についての短い物語を読みます。',
  'नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।',
  '準備はできましたか？',
  'さあ、読みましょう！',
  '読み上げの内容：',
  '次の項目に続きます；',
  '「静かな庭を読みます。」',
  '“庭は静かです！”',
  '“एक शांत बगीचे की कहानी।”',
  'هل الحديقة هادئة؟',
])('preserves terminal punctuation and DOM anchors: %s', (text) => {
  const document = createDocument(`<main><p>${text}</p></main>`);
  const article = extractReadableArticle(document);
  const paragraph = document.querySelector('p');

  expect(article.text).toBe(text);
  expect(article.chunks).toHaveLength(1);
  expect(paragraph.dataset.pagenarratorId).toMatch(/^\d+$/);
  expect(article.chunks[0]).toMatchObject({
    type: 'paragraph',
    speech: text,
    anchorText: text,
    anchorId: paragraph.dataset.pagenarratorId,
    speechPrefixWords: 0,
    globalDomWordStartIndex: 0,
  });
  expect(paragraph.textContent).toBe(text);
});

it('still supplies a stop for unterminated Western prose', () => {
  expect(read('<main><p>The woodland remains quiet</p></main>')).toBe('The woodland remains quiet.');
});

describe('reading model extraction', () => {
  it('retains repeated plain-text blocks within the same chat turn', () => {
    const article = extractReadableArticle(createDocument(`<main>
      <section data-testid="conversation-turn-1"><div data-message-author-role="user">
        <div class="whitespace-pre-wrap">Keep both instructions.</div>
        <div class="whitespace-pre-wrap">Keep both instructions.</div>
      </div></section>
    </main>`));
    expect(article.chunks.filter(chunk => chunk.anchorText === 'Keep both instructions.')).toHaveLength(2);
  });

  it.each(['p', 'blockquote', 'div role="paragraph"'])('preserves repeated instructions in separate %s source blocks', (tag) => {
    const close = tag.split(' ')[0];
    const article = extractReadableArticle(createDocument(`<main>
      <h2>Creation</h2><${tag}>You must not:</${close}><ul><li>Remove vegetation.</li></ul>
      <h2>Restoration</h2><${tag}>You must not:</${close}><ul><li>Drain the pond.</li></ul>
    </main>`));
    const instructions = article.chunks.filter(chunk => chunk.anchorText === 'You must not:');
    expect(instructions).toHaveLength(2);
    expect(new Set(instructions.map(chunk => chunk.anchorId)).size).toBe(2);
    expect(article.text.indexOf('Restoration')).toBeLessThan(article.text.lastIndexOf('You must not:'));
    expect(article.text.lastIndexOf('You must not:')).toBeLessThan(article.text.indexOf('Drain the pond'));
  });

  it('preserves unmarked exponents while excluding explicitly marked and linked footnotes', () => {
    const article = extractReadableArticle(createDocument(`<main><p>
      Area is 50 <abbr title="metres">m</abbr><sup>2</sup>, with x<sup>3</sup> and 10<sup>-2</sup>.
      The source remains readable<sup class="reference">8</sup><sup><a href="#note-9">9</a></sup>.
    </p></main>`));
    expect(article.text).toContain('Area is 50 m2, with x3 and 10-2.');
    expect(article.text).toContain('The source remains readable.');
    expect(article.text).not.toMatch(/readable[89]/u);
  });

  it('omits media fallback and an explicit social widget while retaining descriptions and prose', () => {
    const article = extractReadableArticle(createDocument(`<main>
      <h1>An illustrated guide</h1>
      <figure><video><p>Enable JavaScript to view this video.</p></video>
        <figcaption>The demonstration explains the process.</figcaption></figure>
      <audio><p>Your browser does not support this audio.</p></audio>
      <div id="social"><h2>Social links</h2><a href="https://example.test/social"><img alt="Social platform logo"></a></div>
      <section id="social-science"><p>Social science explains how communities communicate.</p></section>
      <section id="social"><p>Social policy remains meaningful prose.</p><a><img alt="Community Logo"></a></section>
      <p>The video transcript describes every important step.</p>
    </main>`));
    expect(article.text).toContain('The demonstration explains the process.');
    expect(article.text).toContain('Social science explains how communities communicate.');
    expect(article.text).toContain('Social policy remains meaningful prose.');
    expect(article.text).toContain('The video transcript describes every important step.');
    expect(article.text).not.toMatch(/Enable JavaScript|does not support|Social links|Social platform logo/u);
  });

  it.each(['print', 'share'])('excludes an explicit %s page action without losing prose or resources', action => {
    const article = extractReadableArticle(createDocument(`<main>
      <h1>Practical guide</h1>
      <p>Print and share the results after reviewing the evidence.</p>
      <a data-action="${action.toUpperCase()}" aria-label="${action} this page" href="#${action}">${action}</a>
      <a href="/guide">Resource guide</a>
      <a data-action="shareholder" href="/ownership">Ownership details</a>
    </main>`));
    expect(article.text).toContain('Print and share the results after reviewing the evidence.');
    expect(article.text).toContain('Resource guide');
    expect(article.text).toContain('Ownership details');
    expect(article.chunks.some(chunk => chunk.anchorText === `${action} this page`)).toBe(false);
  });

  it.each([
    ['paragraph', '<p>Use TOKEN_PLACEHOLDER for the next operation.</p>'],
    ['heading', '<h2>Using TOKEN_PLACEHOLDER</h2>'],
    ['quote', '<blockquote>Use TOKEN_PLACEHOLDER for the next operation.</blockquote>'],
    ['list', '<ul><li>Use TOKEN_PLACEHOLDER for the next operation.</li></ul>'],
    ['definition', '<dl><dt>Operation</dt><dd>Use TOKEN_PLACEHOLDER for the next operation.</dd></dl>'],
    ['caption', '<figure><figcaption>Use TOKEN_PLACEHOLDER for the next operation.</figcaption></figure>'],
    ['table', '<table><tr><th>Operation</th></tr><tr><td>Use TOKEN_PLACEHOLDER next.</td></tr></table>'],
    ['ARIA paragraph', '<div role="paragraph">Use TOKEN_PLACEHOLDER for the next operation.</div>'],
    ['ARIA heading', '<div role="heading">Using TOKEN_PLACEHOLDER</div>'],
    ['button', '<button>Use TOKEN_PLACEHOLDER now</button>'],
    ['standalone link', '<a href="/operation">Use TOKEN_PLACEHOLDER now</a>'],
  ])('reads linked inline code once within its %s owner', (_name, html) => {
    const code = '<code>requestDevice()</code>';
    const inline = _name === 'standalone link' ? code : `<a href="/api">${code}</a>`;
    const document = createDocument(`<main>${html.replace('TOKEN_PLACEHOLDER', inline)}</main>`);
    const article = extractReadableArticle(document);
    expect(article.chunks.filter(chunk => chunk.type === 'code')).toEqual([]);
    expect(article.text.match(/requestDevice\(\)/gu)).toHaveLength(1);
  });

  it('retains freestanding code and complete preformatted code alongside inline code', () => {
    const article = extractReadableArticle(createDocument(`<main>
      <p>Use <a href="/api"><code>requestDevice()</code></a> in this paragraph.</p>
      <div><code>standaloneCall()</code></div>
      <pre><code>const result = requestDevice();\nconsole.log(result);</code></pre>
    </main>`));
    expect(article.chunks.map(chunk => chunk.type)).toEqual(['paragraph', 'code', 'code']);
    expect(article.chunks[1].speech).toBe('standaloneCall()');
    expect(article.chunks[2].anchorText).toBe('const result = requestDevice();\nconsole.log(result);');
  });

  it('prioritizes the page title and semantic main article structure', () => {
    const speech = read(`
      <!doctype html>
      <title>Better Reading</title>
      <header><a href="/">Home</a></header>
      <nav><a href="/pricing">Pricing</a><a href="/login">Login</a></nav>
      <main>
        <article>
          <h1>Better Reading</h1>
          <p>The narrator starts with meaningful content.</p>
          <section>
            <h2>Why structure matters</h2>
            <p>Headings and paragraphs give listeners orientation.</p>
          </section>
        </article>
      </main>
      <footer>Terms Privacy Contact</footer>
    `);

    expect(speech).toBe([
      'Better Reading.',
      'The narrator starts with meaningful content.',
      'Why structure matters:',
      'Headings and paragraphs give listeners orientation.',
    ].join('\n\n'));
    expect(speech).not.toContain('Pricing');
    expect(speech).not.toContain('Terms');
  });

  it('extractReadableText returns the narrated article text without page furniture', () => {
    const text = extractReadableText(createDocument(`
      <title>Readable wrapper</title>
      <nav>Home Pricing Account</nav>
      <main>
        <h1>Readable wrapper</h1>
        <p>The direct text helper should use the same structured article model.</p>
      </main>
      <footer>Contact and policies</footer>
    `));

    expect(text).toBe([
      'Readable wrapper.',
      'The direct text helper should use the same structured article model.',
    ].join('\n\n'));
    expect(text).not.toContain('Pricing');
    expect(text).not.toContain('Contact');
  });

  it('groups lists with item counts and stable item rhythm', () => {
    const speech = read(`
      <title>Setup Guide</title>
      <main>
        <h1>Setup Guide</h1>
        <p>Follow these steps.</p>
        <ol>
          <li>Install the extension</li>
          <li>Open a webpage</li>
          <li>Press read aloud</li>
        </ol>
      </main>
    `);

    expect(speech).not.toContain('List with 3 items.');
    expect(speech).toContain('List of 3 items: Install the extension, Open a webpage, Press read aloud.');
    expect(speech).not.toContain('First:');
  });

  it('renders headings and ordered lists as continuous speech instead of newline-forced queue holes', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Flow Guide</title>
      <main>
        <h1>Flow Guide</h1>
        <h2>Setup</h2>
        <p>Follow these steps.</p>
        <ol>
          <li>Install the extension</li>
          <li>Open a webpage</li>
          <li>Press read aloud</li>
        </ol>
      </main>
    `));

    expect(article.chunks.map((chunk) => chunk.type)).toEqual([
      'page-title',
      'heading',
      'paragraph',
      'list',
    ]);
    expect(article.chunks[1].speech).toBe('Setup:');
    expect(article.chunks[3].speech).toBe('List of 3 items: Install the extension, Open a webpage, Press read aloud.');
    expect(article.chunks[3].speech).not.toContain('\n');
  });

  it('drops whitespace-only rendered chunks before global DOM word offsets are assigned', () => {
    const chunks = renderReadingModelForSpeechChunks({
      chunks: [
        { type: 'heading', text: '   ' },
        { type: 'paragraph', text: 'Readable content' },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].speech).toBe('Readable content.');
    expect(chunks[0].globalDomWordStartIndex).toBe(0);
  });

  it('reads definition lists as term and definition text instead of standalone inner links', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Techniques</title>
      <main>
        <h1>Techniques</h1>
        <p>Les méthodes principales sont présentées dans cette section.</p>
        <dl>
          <dt><a href="/wiki/Apprentissage_supervisé">Apprentissage supervisé</a></dt>
          <dd>Un <a href="/wiki/Jeu_de_données">jeu de données</a> annoté est utilisé pour entraîner l'algorithme.</dd>
        </dl>
      </main>
    `));

    expect(article.chunks.map((chunk) => chunk.type)).toEqual([
      'page-title',
      'paragraph',
      'list-item',
      'list-item',
    ]);
    expect(article.text).toContain('\nApprentissage supervisé.');
    expect(article.text).toContain("\nUn jeu de données annoté est utilisé pour entraîner l'algorithme.");
    expect(article.chunks).not.toContainEqual(expect.objectContaining({
      type: 'link',
      speech: 'jeu de données.',
    }));
  });

  it('keeps list items even when an item repeats the page title', () => {
    const speech = read(`
      <title>Dot Product in Deep Learning</title>
      <main>
        <div class="kg-card-markdown">
          <h2>Table of Contents</h2>
          <ol>
            <li>What is Deep Learning?</li>
            <li>Dot Product</li>
            <li>Dot Product in Neural Network</li>
            <li>Dot Product in Deep Learning</li>
            <li>Dot Product Use Cases</li>
          </ol>
        </div>
      </main>
    `);

    expect(speech).not.toContain('List with 5 items.');
    expect(speech).toContain('Dot Product in Deep Learning');
    expect(speech).toContain('Dot Product Use Cases');
  });

  it('keeps OpenGenus-style code articles complete and anchored', () => {
    const document = createDocument(`
      <title>Add operation in Deep Learning</title>
      <main>
        <article class="post-full">
          <section class="post-full-content">
            <p><a>Open-Source Internship opportunity by OpenGenus for programmers. Apply now.</a></p>
            <div class="kg-card-markdown">
              <p>TensorFlow is a popular open-source library for machine learning and deep learning tasks.</p>
              <h3>Why to add Layers in a machine learning model ?</h3>
              <p>Adding layers can bring several benefits.</p>
              <ol>
                <li>Increased Model Capacity: By adding layers, the model can learn complex patterns.</li>
                <li>Hierarchical Feature Extraction: Each layer can learn different levels of features.</li>
                <li>Transfer Learning: Deep models can be pre-trained and fine-tuned.</li>
              </ol>
              <h3>Mathematical Expression:</h3>
              <p>The layers.Add operation computes a new tensor C.</p>
              <pre><code class="language-python">C = A + B</code></pre>
              <h3>Python Code:</h3>
              <p>The following python code adds the tensors x and y:</p>
              <pre><code class="language-python">import tensorflow as tf

# Define input tensors
tensor_a = tf.constant([1, 2, 3])
tensor_b = tf.constant([4, 5, 6])

output_tensor = tf.layers.Add()([tensor_a, tensor_b])</code></pre>
            </div>
          </section>
        </article>
      </main>
    `);

    const article = extractReadableArticle(document);
    const codeChunks = article.chunks.filter((chunk) => chunk.type === 'code');

    expect(article.text).toContain('Add operation in Deep Learning.');
    expect(article.text).toContain('List of 3 items: Increased Model Capacity: By adding layers, the model can learn complex patterns');
    expect(article.text).toContain('C = A + B');
    expect(article.text).toContain('import tensorflow as tf');
    expect(article.text).toContain('tensor_b = tf.constant([4, 5, 6])');
    expect(article.text).not.toContain('Open-Source Internship opportunity');
    expect(codeChunks).toHaveLength(2);
    expect(codeChunks[0]).toMatchObject({
      speech: 'C = A + B',
      anchorText: 'C = A + B',
      anchorId: document.querySelector('pre').dataset.pagenarratorId,
      speechPrefixWords: 0,
    });
    expect(codeChunks[1].anchorId).toBe(document.querySelectorAll('pre')[1].dataset.pagenarratorId);
  });
});
