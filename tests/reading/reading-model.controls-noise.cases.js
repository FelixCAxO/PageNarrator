import { createDocument, read } from './reading-model.fixtures.js';
import { describe, expect, it } from 'vitest';

import { extractReadableArticle } from "../../src/lib/reading-model.js";

describe('reading model extraction', () => {
  it('reads linked card text once and retains text that differs from its accessible label', () => {
    const document = createDocument(`<main><article><p>Primary article reporting remains intact.</p>
      <a href="/guide"><h3>Woodland guide</h3><p>Explore the varied woodland landscapes.</p></a>
    </article></main>`);
    for (const label of ['', 'Open the complete guide', 'Explore the varied woodland landscapes.']) {
      document.querySelector('a').setAttribute('aria-label', label);
      const text = extractReadableArticle(document).text;
      expect(text).toContain('Primary article reporting');
      expect(text.split('Explore the varied woodland landscapes.')).toHaveLength(2);
      expect(text.split('Woodland guide')).toHaveLength(2);
      if (label) expect(text).toContain(label);
    }
  });

  it('keeps paragraph and heading text inside an inline link in its enclosing block', () => {
    const document = createDocument('<main><blockquote>Read <a href="/guide"><span role="heading">the woodland guide</span></a> for detailed observations.</blockquote></main>');
    const text = extractReadableArticle(document).text;
    expect(text.split('the woodland guide')).toHaveLength(2);
    expect(text).toContain('Read the woodland guide for detailed observations.');
  });

  it('filters share-icon widgets in custom elements without dropping adjacent prose', () => {
    const document = createDocument(`<main><article>
      <p>Birds navigate using several natural cues.</p>
      <site-share class="layout share-icons"><a href="/share" aria-label="Share on Facebook">Facebook</a>
        <a href="mailto:" aria-label="Email">Send via Email</a><button>Copy link</button></site-share>
      <p>The return migration follows seasonal changes.</p>
    </article></main>`);
    const article = extractReadableArticle(document);
    expect(article.text).toContain('Birds navigate');
    expect(article.text).toContain('return migration');
    expect(article.text).not.toMatch(/Facebook|Send via|Copy link|Email/u);
    const widget = document.querySelector('site-share');
    widget.classList.remove('share-icons');
    widget.innerHTML = '<p>New observations explain the seasonal return.</p>';
    expect(extractReadableArticle(document).text).toContain('New observations explain');
  });

  it.each(['explicit', 'wrapping'])('anchors a %s form label to its visible text after replacement', (kind) => {
    const document = createDocument(`<main><p>Primary reporting explains the observations.</p><form>${kind === 'explicit'
      ? '<label for="feedback">What did you like?</label><textarea id="feedback"></textarea>'
      : '<label>What did you like?<textarea id="feedback"></textarea></label>'}</form></main>`);
    for (const text of ['What did you like?', 'How could this improve?']) {
      const chunk = extractReadableArticle(document).chunks.find(chunk => chunk.type === 'form-field');
      const anchor = document.querySelector(`[data-pagenarrator-id="${chunk.anchorId}"]`);
      expect(anchor.tagName).toBe('LABEL');
      expect(chunk.anchorText).toBe(text);
      expect(anchor.textContent).toBe(text);
      const field = document.getElementById('feedback');
      document.querySelector('label').replaceChildren('How could this improve?');
      if (kind === 'wrapping') document.querySelector('label').append(field);
    }
  });

  it('retains an accessible control label when it differs from the visible label', () => {
    const document = createDocument('<main><form><label for="email">Email</label><input id="email" aria-label="Work email address"></form></main>');
    const chunk = extractReadableArticle(document).chunks.find(chunk => chunk.type === 'form-field');
    expect(chunk.anchorText).toBe('Work email address');
    expect(document.querySelector(`[data-pagenarrator-id="${chunk.anchorId}"]`).tagName).toBe('INPUT');
  });

  it('keeps meaningful links and controls without flooding paragraphs with link announcements', () => {
    const speech = read(`
      <title>Account</title>
      <main>
        <p>Read the full guide on <a href="/docs">our documentation page</a>.</p>
        <a href="/download">Download report</a>
        <button aria-label="Close menu">X</button>
        <form>
          <label for="email">Email address</label>
          <input id="email" type="email" />
          <button>Subscribe</button>
        </form>
      </main>
    `);

    expect(speech).toContain('Read the full guide on our documentation page.');
    expect(speech).toContain('Download report.');
    expect(speech).toContain('Close menu.');
    expect(speech).toContain('Email address.');
    expect(speech).toContain('Subscribe.');
    expect(speech).not.toContain('Link: our documentation page');
    expect(speech).not.toContain('Button: X.');
  });

  it('skips elevated reference links without dropping normal inline link text', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Open Letter</title>
      <main>
        <article>
          <h1>Open Letter</h1>
          <p>The open letter<a href="#note-7" style="vertical-align: super; font-size: 0.75em;">7</a>, published by the authors, cites the <a href="/archive">public archive</a>.</p>
        </article>
      </main>
    `));

    expect(article.text).toContain('The open letter, published by the authors, cites the public archive.');
    expect(article.text).not.toContain('letter7');
    expect(article.text).not.toContain('7, published');
    expect(article.chunks.find((chunk) => chunk.type === 'paragraph')).toMatchObject({
      anchorText: 'The open letter, published by the authors, cites the public archive.',
    });
  });

  it('excludes share widgets while preserving surrounding article prose', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Nature Signal</title>
      <main>
        <article>
          <h1>Nature Signal</h1>
          <p>The discovery paragraph must remain audible.</p>
          <div class="c-article-share-box" data-component="article-share" data-track="share-bar">
            <p>Share this article</p>
            <ul>
              <li><a href="/facebook"><svg><title>Share on Facebook</title></svg></a></li>
              <li><a href="/twitter"><svg><title>Tweet this article</title></svg></a></li>
              <li><button><svg><title>Copy link</title></svg></button></li>
            </ul>
          </div>
          <p>The closing paragraph must remain audible.</p>
        </article>
      </main>
    `));

    expect(article.text).toContain('The discovery paragraph must remain audible.');
    expect(article.text).toContain('The closing paragraph must remain audible.');
    expect(article.text).not.toMatch(/share on|share this|tweet this|copy link|facebook/i);
  });

  it('suppresses icon-only controls and private-use glyphs while keeping named controls', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Controls</title>
      <main>
        <p>The article sentence remains.</p>
        <a href="/facebook"><svg><title>Facebook</title></svg></a>
        <a href="/aria-facebook" aria-label="Facebook"><svg aria-hidden="true"></svg></a>
        <a href="/share" aria-label="Share"><svg aria-hidden="true"></svg></a>
        <a href="/raw-glyph" aria-label="Facebook">\uE002</a>
        <a href="/share-facebook" aria-label="Share on Facebook"><svg aria-hidden="true"></svg></a>
        <a href="/share-linkedin" title="Share on LinkedIn"><svg aria-hidden="true"></svg></a>
        <a href="/share-email" aria-label="Share by email"><svg aria-hidden="true"></svg></a>
        <button title="Share by email"><svg aria-hidden="true"></svg></button>
        <button aria-label="Facebook"><svg aria-hidden="true"></svg></button>
        <button aria-label="Share on Facebook"><svg aria-hidden="true"></svg></button>
        <button aria-label="Share">\uE001</button>
        <button><i class="icon">\uE001</i></button>
        <a href="/download">Download report</a>
        <button aria-label="Close menu">X</button>
      </main>
    `));

    expect(article.text).toContain('The article sentence remains.');
    expect(article.text).toContain('Download report.');
    expect(article.text).toContain('Close menu.');
    expect(article.text).not.toContain('Facebook');
    expect(article.text).not.toContain('Share.');
    expect(article.text).not.toContain('Share on');
    expect(article.text).not.toContain('LinkedIn');
    expect(article.text).not.toContain('Share by');
    expect(article.text).not.toContain('\uE001');
  });

  it('drops symbol-only chunks before they reach rendered speech', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Symbols</title>
      <main>
        <p>The narrative paragraph remains readable.</p>
        <p>***</p>
        <button>!!!</button>
      </main>
    `));

    expect(article.text).toContain('The narrative paragraph remains readable.');
    expect(article.text).not.toContain('***');
    expect(article.text).not.toContain('!!!');
  });

  it('extracts share-heavy article markup deterministically', () => {
    const html = `
      <title>Repeatable Article</title>
      <main>
        <article>
          <h1>Repeatable Article</h1>
          <p>The first paragraph remains stable.</p>
          <div class="article-share-tools">
            <a href="/mail"><svg><title>Share by email</title></svg></a>
          </div>
          <p>The second paragraph remains stable.</p>
        </article>
      </main>
    `;

    const first = extractReadableArticle(createDocument(html)).chunks.map((chunk) => chunk.speech);
    const second = extractReadableArticle(createDocument(html)).chunks.map((chunk) => chunk.speech);

    expect(second).toEqual(first);
    expect(first.join('\n')).not.toMatch(/share by email/i);
  });

  it('does not treat ordinary words containing share as widget classes', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Housing Analysis</title>
      <main>
        <article>
          <h1>Housing Analysis</h1>
          <section class="timeshare-analysis">
            <p>The timeshare analysis paragraph is real article text.</p>
          </section>
          <section data-component="timeshare-analysis">
            <p>The data component timeshare paragraph is also real article text.</p>
          </section>
          <section data-component="shareholder-analysis">
            <p>The data component shareholder paragraph is real article text.</p>
          </section>
          <section class="market-share-analysis">
            <p>The market share analysis paragraph is real article text.</p>
          </section>
          <section class="share-price-analysis">
            <p>The share price analysis paragraph is real article text.</p>
          </section>
          <section class="political-social-analysis">
            <p>The political social analysis paragraph is real article text.</p>
          </section>
          <section class="anti-social-behavior-analysis">
            <p>The anti social behavior analysis paragraph is real article text.</p>
          </section>
          <section class="political_social_analysis">
            <p>The underscore political social analysis paragraph is real article text.</p>
          </section>
          <section class="social_science">
            <p>The underscore social science paragraph is real article text.</p>
          </section>
          <section data-component="market-share-analysis">
            <p>The data component market share paragraph is real article text.</p>
          </section>
          <section data-testid="share-price-analysis">
            <p>The data test id share price paragraph is real article text.</p>
          </section>
          <section data-component="market share analysis">
            <p>The spaced data component market share paragraph is real article text.</p>
          </section>
          <section data-test-id="market share analysis">
            <p>The spaced data test id market share paragraph is real article text.</p>
          </section>
          <section data-track="stock share analysis">
            <p>The spaced data track stock share paragraph is real article text.</p>
          </section>
        </article>
      </main>
    `));

    expect(article.text).toContain('The timeshare analysis paragraph is real article text.');
    expect(article.text).toContain('The data component timeshare paragraph is also real article text.');
    expect(article.text).toContain('The data component shareholder paragraph is real article text.');
    expect(article.text).toContain('The market share analysis paragraph is real article text.');
    expect(article.text).toContain('The share price analysis paragraph is real article text.');
    expect(article.text).toContain('The political social analysis paragraph is real article text.');
    expect(article.text).toContain('The anti social behavior analysis paragraph is real article text.');
    expect(article.text).toContain('The underscore political social analysis paragraph is real article text.');
    expect(article.text).toContain('The underscore social science paragraph is real article text.');
    expect(article.text).toContain('The data component market share paragraph is real article text.');
    expect(article.text).toContain('The data test id share price paragraph is real article text.');
    expect(article.text).toContain('The spaced data component market share paragraph is real article text.');
    expect(article.text).toContain('The spaced data test id market share paragraph is real article text.');
    expect(article.text).toContain('The spaced data track stock share paragraph is real article text.');
  });

  it('does not narrate symbol-only table headers, cells, or captions', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Table Symbols</title>
      <main>
        <p>The article paragraph remains.</p>
        <table>
          <caption>***</caption>
          <tr><th>***</th></tr>
          <tr><td>!!!</td></tr>
        </table>
      </main>
    `));

    expect(article.text).toContain('The article paragraph remains.');
    expect(article.text).not.toContain('Table.');
    expect(article.text).not.toContain('***');
    expect(article.text).not.toContain('!!!');
  });

  it('keeps French Wikipedia article flow ahead of MediaWiki chrome', () => {
    const article = extractReadableArticle(createDocument(`
      <title>Intelligence artificielle — Wikipédia</title>
      <body class="mediawiki mw-parser-output-client">
        <main id="content" class="mw-body">
          <header class="mw-body-header vector-page-titlebar">
            <button>masquer</button>
            <nav class="vector-page-toolbar">
              <a href="/wiki/Discussion:Intelligence_artificielle">Discussion</a>
              <a href="/w/index.php?title=Intelligence_artificielle&action=edit">Voir le texte source</a>
            </nav>
            <h1 id="firstHeading">Intelligence artificielle</h1>
          </header>
          <div id="bodyContent">
            <aside class="vector-toc">
              <button>masquer</button>
              <a href="#Définition">Définition</a>
            </aside>
            <div class="mw-parser-output">
              <table class="infobox">
                <tbody>
                  <tr><th>Partie de</th><td>Informatique, nouvelles technologies, raisonnement</td></tr>
                </tbody>
              </table>
              <p class="plainlinks">modifier - modifier le code - modifier Wikidata</p>
              <p>
                L'intelligence artificielle (IA) est l'ensemble des systèmes informatiques capables
                d'effectuer des tâches typiquement associées à l'intelligence.
              </p>
              <p>
                L'IA est un domaine de l'informatique qui s'appuie sur des fondements mathématiques
                et des concepts issus des sciences cognitives.
              </p>
              <h2><span>Définition</span><span class="mw-editsection">modifier</span></h2>
              <div class="hatnote">Article détaillé : Réglementation de l'intelligence artificielle</div>
              <p>
                L’expression « intelligence artificielle » a été introduite en 1956 par John McCarthy
                pour décrire une discipline de recherche.
              </p>
            </div>
          </div>
        </main>
      </body>
    `));

    const spoken = article.chunks.map((chunk) => chunk.speech);

    expect(spoken.slice(0, 5)).toEqual([
      'Intelligence artificielle.',
      "L'intelligence artificielle (IA) est l'ensemble des systèmes informatiques capables d'effectuer des tâches typiquement associées à l'intelligence.",
      "L'IA est un domaine de l'informatique qui s'appuie sur des fondements mathématiques et des concepts issus des sciences cognitives.",
      'Définition:',
      "L’expression « intelligence artificielle » a été introduite en 1956 par John McCarthy pour décrire une discipline de recherche.",
    ]);
    expect(article.text).not.toContain('masquer');
    expect(article.text).not.toContain('Voir le texte source');
    expect(article.text).not.toContain('modifier');
    expect(article.text).not.toContain('Wikidata');
    expect(article.text).not.toContain('Partie de');
    expect(article.text).not.toContain('Réglementation de l');
  });
});
