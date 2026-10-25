import { createDocument } from './article-extraction.fixtures.js';

import { describe, expect, it } from 'vitest';
import { chooseArticleExtraction } from "../../src/lib/article-extraction.js";
import { isReferenceTextElement } from '../../src/lib/core/text-noise-filter.js';

describe('article extraction priority', () => {
  it.each(['paragraph', 'loose fallback'])('retains superscript units in %s extraction', (kind) => {
    const text = 'The plot covers 50 <abbr title="metres">m</abbr><sup>2</sup> of habitat<sup class="reference">8</sup>.';
    const document = createDocument(kind === 'paragraph' ? `<main><p>${text}</p></main>` : `<body>${text}</body>`);
    const result = chooseArticleExtraction(document, { startMode: 'top', articleFallback: {
      isArticleDocument: () => false, parse: () => null,
    } });
    expect(result.text).toMatch(/m\s*2/u);
    expect(result.text).not.toContain('8');
  });

  it('omits social signup panels and icon-only article reactions while retaining prose and named controls', () => {
    const document = createDocument(`<main><article>
      <h1>Wildlife observations</h1><p>Primary reporting describes pollinators visiting flowers.</p>
      <button aria-label="Clap button for article likes"><svg></svg></button>
      <button aria-label="Like this article"><svg></svg></button>
      <button>Like bees, butterflies visit flowers</button><button aria-label="Close menu">X</button>
      <a href="/report">Download the original report</a>
      <section id="social-signup-new-id"><h2>Receive updates</h2><p>Subscribe for news and events.</p>
        <form><label>Email address<input type="email"></label><button>Sign up</button></form>
        <article><h2>Follow us on social media</h2><a href="/social" aria-label="Our Facebook page"><svg></svg></a></article>
      </section><p>Closing reporting preserves the observed flower sequence.</p>
    </article></main>`);
    const result = chooseArticleExtraction(document, { startMode: 'top' });
    for (const text of ['Primary reporting', 'Closing reporting', 'Like bees, butterflies', 'Close menu', 'Download the original report']) expect(result.text).toContain(text);
    expect(result.text).not.toMatch(/Clap button|Like this article|Receive updates|Subscribe for|Email address|Sign up|Follow us|Our Facebook/u);
  });

  it('re-evaluates a social signup panel when its email form is replaced with article prose', () => {
    const document = createDocument(`<main><article><p>Primary article observations remain complete.</p>
      <section id="social-signup-live"><p>New observations describe the local plants.</p><form><input type="email"></form></section>
    </article></main>`);
    expect(chooseArticleExtraction(document, { startMode: 'top' }).text).not.toContain('New observations');
    document.querySelector('form').remove();
    expect(chooseArticleExtraction(document, { startMode: 'top' }).text).toContain('New observations');
  });

  it('omits labeled related-image cards while retaining primary paragraphs and linked headings', () => {
    const document = createDocument(`<main><article>
      <p>Primary article prose explains the scientific observations.</p>
      <a href="#section" aria-label="Section"><h3>Article section</h3></a>
      <a href="/guide" aria-label="Guide"><img alt=""><h3>Detailed guide</h3><p>Useful linked prose explains the process.</p></a>
      <a href="/related" aria-label="Read more"><img alt=""><h3>Related guide</h3></a>
    </article></main>`);
    const result = chooseArticleExtraction(document, { startMode: 'top' });
    expect(result.text).toContain('Primary article prose');
    expect(result.text).toContain('Article section');
    expect(result.text).toContain('Useful linked prose');
    expect(result.text).not.toContain('Related guide');
    expect(result.text).not.toContain('Read more');
  });

  it('does not flatten ordinary container text while checking for reference markers', () => {
    const element = createDocument('<article>Long article body.</article>').querySelector('article');
    Object.defineProperty(element, 'textContent', { get() { throw new Error('unexpected container text scan'); } });
    expect(isReferenceTextElement(element)).toBe(false);
  });

  it.each(['paragraph', 'loose fallback'])('keeps reference-class prose links and labels in %s text', (kind) => {
    const text = 'The implementation uses <a class="reference internal" href="/guide">the implementation guide</a>, <a class="reference external" href="https://example.org/cpu">CPU</a>, <a class="reference internal" href="#api">API</a>, and a <span class="reference">label</span> to explain the process<span class="reference">[7]</span><sup class="reference">8</sup><a role="doc-noteref" href="#n9">9</a>.';
    const document = createDocument(kind === 'paragraph' ? `<main><p>${text}</p></main>` : `<body>${text}</body>`);
    const result = chooseArticleExtraction(document, { startMode: 'top', articleFallback: {
      isArticleDocument: () => false, parse: () => null,
    } });
    expect(result.text).toContain('the implementation guide, CPU, API, and a label to explain the process.');
    expect(result.text).not.toMatch(/[789]/u);
  });

  it('preserves standalone link-only pages as structured controls', () => {
    const document = createDocument('<a href="/first">First guide</a><a href="/second">Second guide</a>');
    const result = chooseArticleExtraction(document, { startMode: 'top' });
    expect(result.source).toBe('reading-model');
    expect(result.chunks.map(chunk => chunk.speech)).toEqual(['Link: First guide.', 'Link: Second guide.']);
  });

  it.each(['nav', 'div role="navigation"'])(
    'omits a heading labeling an adjacent %s while preserving article headings', (navigation) => {
      const tag = navigation.split(' ')[0];
      const document = createDocument(`<main><article>
        <h1>Article title</h1><p>Useful article prose explains the current scientific observations.</p>
        <h2>Categories</h2><p>These categories describe the observations in the article.</p>
        <div><h3 id="taxonomy-label">Browse related topics</h3>
          <${navigation} aria-labelledby="other-label taxonomy-label"><a href="/topic">Topic</a></${tag}>
        </div>
        <h2 id="section-label">Further research</h2>
        <nav aria-labelledby="a-different-label"><a href="/other">Other</a></nav>
        <p>Follow-up observations can test the scientific explanation.</p>
      </article></main>`);
      const result = chooseArticleExtraction(document, { startMode: 'top' });
      expect(result.text).toContain('Categories');
      expect(result.text).toContain('Further research');
      expect(result.text).toContain('Follow-up observations');
      expect(result.text).not.toContain('Browse related topics');
    },
  );

  it('re-evaluates navigation heading labels after a DOM update', () => {
    const document = createDocument(`<main><article>
      <p>Useful article prose explains the current scientific observations.</p>
      <h2 id="section-label">New observations</h2>
      <nav aria-labelledby="section-label"><a href="/topic">Related topic</a></nav>
    </article></main>`);
    expect(chooseArticleExtraction(document).text).not.toContain('New observations');
    document.querySelector('nav').setAttribute('aria-labelledby', 'another-label');
    expect(chooseArticleExtraction(document).text).toContain('New observations');
  });

  it.each([
    '--panel-opacity: 0.1; --panel-display: none',
    'opacity: 0.15',
    'opacity: .25',
    'opacity: 50%',
  ])('reads visible content whose inline style is %s', (style) => {
    const document = createDocument('<main><article><p>Visible reporting describes the exhibition and the visiting artists.</p></article></main>');
    document.documentElement.setAttribute('style', style);

    expect(chooseArticleExtraction(document).text).toContain('Visible reporting');
  });

  it.each(['opacity: 0', 'opacity: 0.0', 'opacity: 0%', 'display: none', 'visibility: hidden'])(
    'excludes content hidden by %s', (style) => {
      const document = createDocument('<main><article><p>Hidden reporting describes the exhibition and the visiting artists.</p></article></main>');
      document.documentElement.setAttribute('style', style);

      expect(chooseArticleExtraction(document).text).toBe('');
    },
  );

  it('falls back to body cleanup when neither the structured model nor article fallback succeed', () => {
    const document = createDocument(`
      <title>Plain Page</title>
      <body>
        <script>console.log('hi')</script>
        <nav>menu items</nav>
        <header>Site header</header>
        <div>${'word '.repeat(80)}</div>
        <footer>Site footer</footer>
        <form><input type="text" name="email" /></form>
      </body>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => false,
        parse: () => null,
      },
    });

    expect(result.source).toBe('fallback');
    expect(result.title).toBe('Plain Page');
    expect(result.text).toContain('word');
    expect(result.chunks).toEqual([expect.objectContaining({
      speech: expect.stringContaining('word'),
      anchorId: expect.stringMatching(/\d+/),
      speechPrefixWords: 0,
    })]);
    expect(result.text).not.toContain('console.log');
  });

  it('keeps data-nosnippet article bodies readable and anchorable', () => {
    const articleText = [
      'An outbreak report has enough visible article text to be narrated aloud.',
      'The page marks the body as no snippet for search engines, but it is still the primary story.',
    ].join(' ');
    const document = createDocument(`
      <title>No Snippet Story</title>
      <main>
        <article>
          <div data-nosnippet>
            <p>${articleText}</p>
          </div>
        </article>
      </main>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => true,
        parse: () => ({
          title: 'No Snippet Story',
          textContent: articleText,
        }),
      },
    });

    expect(result.text).toContain(articleText);
    expect(result.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        speech: articleText,
        anchorText: articleText,
        anchorId: document.querySelector('p').dataset.pagenarratorId,
      }),
    ]));
  });

  it('cleans fallback body text without cloning the entire body', () => {
    const document = createDocument(`
      <title>Loose Text Page</title>
      <body>
        Readable loose text that is not inside a paragraph but is still worth narrating.
        <nav>menu items</nav>
        More loose readable text after noisy page furniture.
      </body>
    `);
    document.body.cloneNode = () => {
      throw new Error('body clone should not be used for fallback cleanup');
    };

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => false,
        parse: () => null,
      },
    });

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Readable loose text');
    expect(result.text).toContain('More loose readable text');
    expect(result.text).not.toContain('menu items');
  });

  it('keeps fallback body cleanup from reading elevated reference links', () => {
    const document = createDocument(`
      <title>Loose Reference Page</title>
      <body>
        Readable loose text quotes the open letter<a href="#note-7" style="vertical-align: super; font-size: 0.75em;">7</a>,
        then continues through the public archive.
      </body>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => false,
        parse: () => null,
      },
    });

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Readable loose text quotes the open letter, then continues through the public archive.');
    expect(result.text).not.toContain('letter7');
    expect(result.text).not.toContain('7, then');
  });

  it('filters icons, private-use glyphs, and symbol-only nodes from fallback body cleanup', () => {
    const document = createDocument(`
      <title>Loose Icon Page</title>
      <body>
        Readable loose article text should remain audible for fallback narration.
        <button><svg><title>Facebook</title></svg></button>
        <i class="icon">&#xE001;</i>
        <p>***</p>
        More loose article text should also remain audible after icons.
      </body>
    `);

    const result = chooseArticleExtraction(document, {
      articleFallback: {
        isArticleDocument: () => false,
        parse: () => null,
      },
    });

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Readable loose article text should remain audible for fallback narration.');
    expect(result.text).toContain('More loose article text should also remain audible after icons.');
    expect(result.text).not.toContain('Facebook');
    expect(result.text).not.toContain('\uE001');
    expect(result.text).not.toContain('***');
  });

  it('returns the URL of the document being narrated', () => {
    const document = createDocument(`<title>P</title><main><p>${'word '.repeat(40)}</p></main>`);
    const result = chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });
    expect(result.url).toBe('https://example.test/article');
  });

  it('marks article extraction start and end for pre-TTS latency attribution', () => {
    const document = createDocument(`<title>P</title><main><p>${'word '.repeat(40)}</p></main>`);
    const marks = [];
    document.defaultView.performance.mark = (name) => marks.push(name);

    chooseArticleExtraction(document, {
      articleFallback: { isArticleDocument: () => false, parse: () => null },
    });

    expect(marks).toEqual(expect.arrayContaining(['pn:extract:start', 'pn:extract:end']));
  });
});
