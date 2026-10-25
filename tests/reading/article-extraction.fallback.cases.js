import { createDocument } from './article-extraction.fixtures.js';

import { describe, expect, it } from 'vitest';
import { chooseArticleExtraction } from "../../src/lib/article-extraction.js";

describe('article extraction priority', () => {
  it('falls back to article fallback when the structured model has nothing readable', () => {
    const document = createDocument(`
      <title>Plain</title>
      <body>
        <div>${'word '.repeat(80)}</div>
      </body>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'article fallback Title',
          byline: 'Author',
          textContent: 'Recovered article text from article fallback.',
        }),
      },
    });

    expect(result.source).toBe('article-fallback');
    expect(result.title).toBe('article fallback Title');
    expect(result.byline).toBe('Author');
    expect(result.text).toBe('Recovered article text from article fallback.');
    expect(result.chunks).toBeUndefined();
  });

  it('uses article fallback when it recovers a substantially better article than noisy structured output', () => {
    const document = createDocument(`
      <title>Portal Page</title>
      <main>
        <section>
          <h1>Portal Page</h1>
          <p>Login subscribe share cookie advertisement login subscribe share cookie advertisement.</p>
          <p>Share this page and subscribe before reading.</p>
        </section>
      </main>
    `);
    const recovered = [
      'The recovered article opens with the actual report and gives listeners the main finding.',
      'It continues with enough detail to clearly outrank the portal furniture and sharing prompts.',
      'The final sentence keeps the article focused on the story instead of account actions.',
    ].join(' ');

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'Recovered Story',
          byline: 'Reporter',
          textContent: recovered,
        }),
      },
    });

    expect(result.source).toBe('article-fallback');
    expect(result.title).toBe('Recovered Story');
    expect(result.byline).toBe('Reporter');
    expect(result.text).toBe(recovered);
  });

  it('keeps inline code in its complete paragraph when article fallback wins', () => {
    const prose = 'Use requestDevice() to create the logical device before submitting rendering commands.';
    const background = 'Recovered article context explains how the implementation works in detail. '.repeat(10).trim();
    const example = 'const device = await requestDevice();';
    const document = createDocument(`<main>
      <div>${background}</div>
      <p>Use <code>requestDevice()</code> to create the logical device before submitting rendering commands.</p>
      <pre><code>${example}</code></pre>
    </main>`);
    const result = chooseArticleExtraction(document, { startMode: 'top', articleFallback: {
      isArticleDocument: () => true,
      parse: () => ({ textContent: [background, prose, example].join('\n\n') }),
    } });
    expect(result.source).toBe('article-fallback');
    expect(result.chunks).toContainEqual(expect.objectContaining({
      type: 'paragraph', speech: prose, anchorId: document.querySelector('p').dataset.pagenarratorId,
    }));
    expect(result.chunks.filter(chunk => chunk.type === 'code')).toHaveLength(1);
    expect(result.chunks.find(chunk => chunk.type === 'code').anchorText).toBe(example);
  });

  it('keeps code blocks as anchored chunks when article fallback genuinely wins', () => {
    const document = createDocument(`
      <title>Developer Portal</title>
      <main>
        <div>
          Recovered article text explains the implementation in enough detail for narration.
          It continues with setup context that is not wrapped in article paragraphs.
          <pre><code>const result = add(1, 2);
console.log(result);</code></pre>
        </div>
      </main>
    `);
    const recovered = [
      'Recovered article text explains the implementation in enough detail for narration.',
      'It continues with setup context that is not wrapped in article paragraphs.',
      'const result = add(1, 2);\nconsole.log(result);',
    ].join('\n\n');

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'Developer Portal',
          textContent: recovered,
        }),
      },
    });

    expect(result.source).toBe('article-fallback');
    expect(result.chunks).toContainEqual(expect.objectContaining({
      type: 'code',
      speech: 'const result = add(1, 2);\nconsole.log(result);',
      anchorText: 'const result = add(1, 2);\nconsole.log(result);',
      anchorId: document.querySelector('pre').dataset.pagenarratorId,
    }));
  });

  it('filters private-use glyphs from raw article fallback text when no anchors are recovered', () => {
    const document = createDocument(`
      <title>Readable Fallback</title>
      <body>
        <div>${'portal '.repeat(80)}</div>
      </body>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'Readable Fallback',
          textContent: [
            'Recovered article text remains audible.',
            'Share on Facebook',
            '\uE001 ***',
          ].join('\n\n'),
        }),
      },
    });

    expect(result.source).toBe('article-fallback');
    expect(result.text).toBe('Recovered article text remains audible.');
    expect(result.text).not.toContain('\uE001');
    expect(result.text).not.toContain('***');
    expect(result.chunks).toBeUndefined();
  });

  it('does not clone the page for article fallback when structured extraction is already strong', () => {
    const document = createDocument(`
      <title>Long Structured Story</title>
      <main>
        <article>
          <h1>Long Structured Story</h1>
          ${Array.from({ length: 8 }, (_, index) => (
            `<p>Paragraph ${index + 1} contains ${'substantial article language '.repeat(60)}</p>`
          )).join('')}
        </article>
      </main>
    `);
    const calls = [];

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => {
          calls.push('isArticleDocument');
          return true;
        },
        parse: () => {
          calls.push('parse');
          return {
            title: 'article fallback should not run',
            textContent: 'article fallback should not be needed.',
          };
        },
      },
    });

    expect(result.source).toBe('reading-model');
    expect(result.text).toContain('substantial article language');
    expect(calls).toEqual([]);
  });

  it('keeps a short structured article on the reading-model path without speculative article fallback', () => {
    const document = createDocument(`
      <title>Short article</title>
      <main>
        <article>
          <h1>Short article</h1>
          <p>${'A compact but real article paragraph. '.repeat(6)}</p>
        </article>
      </main>
    `);
    const calls = [];

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => {
          calls.push('isArticleDocument');
          return true;
        },
        parse: () => {
          calls.push('parse');
          return {
            title: 'article fallback should not run',
            textContent: 'Recovered text',
          };
        },
      },
    });

    expect(result.source).toBe('reading-model');
    expect(result.text).toContain('Short article.');
    expect(calls).toEqual([]);
  });

  it('passes the likely article root to article fallback so adapters can avoid full-document clones', () => {
    const document = createDocument(`
      <title>Portal Page</title>
      <body>
        <nav>${'navigation '.repeat(80)}</nav>
        <main>
          <article id="story">
            <h1>Story</h1>
            <p>Subscribe login share.</p>
            <p>Cookie banner prompt.</p>
          </article>
        </main>
      </body>
    `);
    const roots = [];

    chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: (_doc, options) => {
          roots.push(options?.root);
          return {
            title: 'Recovered Story',
            textContent: `${'Recovered article text '.repeat(80)}`,
          };
        },
      },
    });

    expect(roots).toEqual([document.querySelector('#story')]);
  });

  it('keeps a complete structured queue for OpenGenus-style code articles instead of switching to noisy article fallback text', () => {
    const document = createDocument(`
      <title>Add operation in Deep Learning</title>
      <main>
        <article class="post-full">
          <section class="post-full-content">
            <p><a>Open-Source Internship opportunity by OpenGenus for programmers. Apply now.</a></p>
            <div class="kg-card-markdown">
              <p>TensorFlow is a popular open-source library for machine learning and deep learning tasks.</p>
              <p>In this article at OpenGenus, we will dive into the TensorFlow layers.Add operation.</p>
              <h3>Why to add Layers in a machine learning model ?</h3>
              <p>Adding layers can bring several benefits.</p>
              <ol>
                <li>Increased Model Capacity: By adding layers, the model can learn complex patterns.</li>
                <li>Hierarchical Feature Extraction: Each layer can learn different levels of features.</li>
                <li>Improved Model Performance: Deeper models can achieve better performance.</li>
                <li>Transfer Learning: Deep models can be pre-trained and fine-tuned.</li>
              </ol>
              <h3>Mathematical Expression:</h3>
              <p>The layers.Add operation computes a new tensor C.</p>
              <pre><code>C = A + B</code></pre>
              <h3>Python Code:</h3>
              <p>The following python code adds the tensors x and y:</p>
              <pre><code>import tensorflow as tf
tensor_a = tf.constant([1, 2, 3])
tensor_b = tf.constant([4, 5, 6])
output_tensor = tf.layers.Add()([tensor_a, tensor_b])</code></pre>
            </div>
          </section>
        </article>
      </main>
    `);
    const fallbackText = [
      'Open-Source Internship opportunity by OpenGenus for programmers. Apply now.',
      'TensorFlow is a popular open-source library for machine learning and deep learning tasks.',
      'In this article at OpenGenus, we will dive into the TensorFlow layers.Add operation.',
      'Why to add Layers in a machine learning model ?',
      'Increased Model Capacity: By adding layers, the model can learn complex patterns.',
      'Hierarchical Feature Extraction: Each layer can learn different levels of features.',
      'Improved Model Performance: Deeper models can achieve better performance.',
      'Transfer Learning: Deep models can be pre-trained and fine-tuned.',
      'C = A + B',
      [
        'import tensorflow as tf',
        'tensor_a = tf.constant([1, 2, 3])',
        'tensor_b = tf.constant([4, 5, 6])',
        'output_tensor = tf.layers.Add()([tensor_a, tensor_b])',
      ].join('\n'),
    ].join('\n\n');

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'Add operation in Deep Learning',
          textContent: fallbackText,
        }),
      },
    });

    expect(result.source).toBe('reading-model');
    expect(result.text).toBe(result.chunks.map((chunk) => chunk.speech).join('\n\n'));
    expect(result.text).toContain('Add operation in Deep Learning.');
    expect(result.text).toContain('Transfer Learning: Deep models can be pre-trained and fine-tuned.');
    expect(result.text).toContain('C = A + B');
    expect(result.text).toContain('output_tensor = tf.layers.Add()([tensor_a, tensor_b])');
    expect(result.text).not.toContain('Open-Source Internship opportunity');
    expect(result.chunks.filter((chunk) => chunk.type === 'code')).toHaveLength(2);
  });
});
