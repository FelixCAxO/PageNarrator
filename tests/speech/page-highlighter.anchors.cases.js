import { createDom, makeVisible, makeTextRangeGeometry, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it.each(['anchor', 'search'])('includes unit exponents and excludes footnotes in %s word ranges', (mode) => {
    const dom = createDom('<p data-pagenarrator-id="units">Area is <abbr title="metres">m</abbr><sup>2</sup> with x<sup>3</sup><sup class="reference">8</sup>.</p>');
    const { document } = dom.window;
    for (const element of document.querySelectorAll('p, abbr, sup')) makeVisible(element);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    const speech = 'Area is m2 with x3.';
    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('units', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, text] of ['Area', 'is', 'm2', 'with', 'x3'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
    highlighter.dispose();
    dom.window.close();
  });

  it.each(['anchor', 'search'])('keeps temperature units and following words aligned in %s highlighting', (mode) => {
    const dom = createDom('<p data-pagenarrator-id="temperatures">Below 25°C, honey changes. Above 36<span>°</span>F, the next words remain aligned.</p>');
    const { document } = dom.window;
    for (const element of document.querySelectorAll('p, span')) makeVisible(element);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    const speech = 'Below 25°C, honey changes. Above 36°F, the next words remain aligned.';
    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('temperatures', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, word] of ['Below', '25', 'C', 'honey', 'changes', 'Above', '36', 'F', 'the', 'next', 'words', 'remain', 'aligned'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(word);
    }
    highlighter.dispose();
    dom.window.close();
  });

  it.each(['anchor', 'search'])('keeps prose reference links and excludes note markers using %s highlighting', (mode) => {
    const dom = createDom('<p data-pagenarrator-id="references">See <a class="reference external" href="/guide">CPU</a> and <span class="reference">API</span><span class="reference">[7]</span><sup class="reference">8</sup><a role="doc-noteref" href="#n9">9</a> documentation.</p>');
    const { document } = dom.window;
    for (const element of document.querySelectorAll('p, a, span, sup')) makeVisible(element);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    const speech = 'See CPU and API documentation.';
    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('references', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, text] of ['See', 'CPU', 'and', 'API', 'documentation'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
  });

  it('flashes and clears an anchored section for resume confirmation', () => {
    vi.useFakeTimers();
    const dom = createDom(`
      <body>
        <main>
          <p data-pagenarrator-id="resume-target">Resume here.</p>
        </main>
      </body>
    `);
    const target = dom.window.document.querySelector('[data-pagenarrator-id="resume-target"]');
    makeVisible(target);
    const highlighter = createPageHighlighter(dom.window.document);

    expect(highlighter.flashResumeSectionByAnchor('resume-target', null)).toEqual({ ok: true });
    expect(target.classList.contains('pagenarrator-resume-flash')).toBe(true);

    vi.advanceTimersByTime(1500);

    expect(target.classList.contains('pagenarrator-resume-flash')).toBe(false);
  });

  it('draws a visible chunk region overlay when the matched range has no compact block element', () => {
    const dom = createDom(`
      <body>
        <main>
          <span>Intro text before the readable passage.</span>
          <span>Read this exact passage out loud now.</span>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('main'));
    for (const element of document.querySelectorAll('span')) makeVisible(element);
    makeTextRangeGeometry(dom.window, {
      top: 140,
      left: 90,
      right: 390,
      bottom: 170,
      width: 300,
      height: 30,
    });

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Read this exact passage out loud now.')).toEqual({ ok: true });

    const overlay = document.querySelector('[data-pagenarrator-region]');
    expect(overlay).not.toBeNull();
    expect(overlay.style.display).toBe('block');
    expect(overlay.style.left).toBe('86px');
    expect(overlay.style.top).toBe('136px');
    expect(overlay.style.width).toBe('308px');
    expect(overlay.style.height).toBe('38px');
  });

  it('highlights a chunk by DOM anchor instead of the first duplicate text match', () => {
    const dom = createDom(`
      <body>
        <aside><p>Install the extension</p></aside>
        <main>
          <ol data-pagenarrator-id="list-1">
            <li data-pagenarrator-id="item-1">Install the extension</li>
            <li>Open a webpage</li>
          </ol>
        </main>
      </body>
    `);
    const { document } = dom.window;
    const sidebar = document.querySelector('aside p');
    const list = document.querySelector('ol');
    const item = document.querySelector('li');
    makeVisible(sidebar, { top: 20, left: 20, right: 220, bottom: 50, width: 200, height: 30 });
    makeVisible(list, { top: 200, left: 80, right: 360, bottom: 280, width: 280, height: 80 });
    makeVisible(item, { top: 210, left: 110, right: 320, bottom: 240, width: 210, height: 30 });

    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(range) {
        this.range = range;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({ name, text: highlight.range.toString() });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('item-1', 'Install the extension')).toEqual({ ok: true });
    expect(item.classList.contains('pagenarrator-current-block')).toBe(true);
    expect(sidebar.classList.contains('pagenarrator-current-block')).toBe(false);

    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(highlighted.at(-1)).toEqual({ name: 'pagenarrator-word-0', text: 'Install' });

    expect(highlighter.highlightChunkByAnchor('list-1', null)).toEqual({ ok: true });
    expect(list.classList.contains('pagenarrator-current-block')).toBe(true);
  });

  it('builds word ranges from an anchored block when inline text parents have no box', () => {
    const dom = createDom(`
      <body>
        <main>
          <a data-pagenarrator-id="story-1"><span>Breaking news headline</span></a>
        </main>
      </body>
    `);
    const { document } = dom.window;
    const link = document.querySelector('a');
    const span = document.querySelector('span');
    makeVisible(link, { top: 80, left: 40, right: 340, bottom: 112, width: 300, height: 32 });
    span.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });

    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(range) {
        this.range = range;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({ name, text: highlight.range.toString() });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('story-1', 'Breaking news headline')).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(highlighted.at(-1)).toEqual({ name: 'pagenarrator-word-0', text: 'news' });
  });

  it.each(['anchor', 'search'])('keeps inline fragments in one spoken word using %s highlighting', (mode) => {
    const dom = createDom('<p data-pagenarrator-id="inline">An <code>if</code>-statement uses <em>multi</em><b>line</b> conditions.</p>');
    const { document } = dom.window;
    for (const element of document.querySelectorAll('p, code, em, b')) makeVisible(element);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    const speech = 'An if-statement uses multiline conditions.';

    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('inline', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, text] of ['An', 'if-statement', 'uses', 'multiline', 'conditions'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
  });

  it.each(['anchor', 'search'])('preserves article word indices around spaced dashes using %s highlighting', (mode) => {
    const speech = 'Populations-- including song-birds-- feed near surface- water and hardwood- riparian forests.';
    const dom = createDom(`<p data-pagenarrator-id="dashes">${speech}</p>`);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('dashes', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, text] of ['Populations', 'including', 'song-birds', 'feed', 'near', 'surface', 'water', 'and', 'hardwood', 'riparian', 'forests'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
  });

  it.each(['anchor', 'search'])('preserves word boundaries around math operators using %s highlighting', (mode) => {
    const dom = createDom('<p data-pagenarrator-id="operators">Use error=True and lower+offset, then continue.</p>');
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    const speech = document.querySelector('p').textContent;
    expect(mode === 'anchor' ? highlighter.highlightChunkByAnchor('operators', speech) : highlighter.highlightChunk(speech)).toEqual({ ok: true });
    for (const [index, text] of ['Use', 'error', 'True', 'and', 'lower', 'offset', 'then', 'continue'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
  });

  it('collapses whitespace across inline node boundaries during fallback search', () => {
    const dom = createDom('<p>Read <em> this </em> sentence.</p>');
    const { document } = dom.window;
    for (const element of document.querySelectorAll('p, em')) makeVisible(element);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('Read this sentence.')).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('this');
  });

  it.each([
    ['inline whitespace', '<span>one</span> <b>two</b>', ['one', 'two']],
    ['block boundaries', '<p>one</p><p>two</p>', ['one', 'two']],
    ['table cells', '<table><tr><td>one</td><td>two</td></tr></table>', ['one', 'two']],
    ['nested line break', '<span>one<br></span><b>two</b>', ['one', 'two']],
  ])('preserves %s in anchored word ranges', (_label, html, words) => {
    const dom = createDom(`<div data-pagenarrator-id="boundaries">${html}</div>`);
    const { document } = dom.window;
    makeVisible(document.querySelector('div'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('boundaries', words.join(' '))).toEqual({ ok: true });
    for (const [index, text] of words.entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
  });

  it('omits stylesheet-hidden descendants from anchored word ranges', () => {
    const dom = createDom('<style>.mobileonly { display: none; }</style><ul data-pagenarrator-id="menu"><li>Home</li><li class="mobileonly"><a>Menu</a></li><li>About</li></ul>');
    const { document } = dom.window;
    makeVisible(document.querySelector('ul'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('menu', 'Home About')).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('About');
  });

  it('keeps French Wikipedia edit controls out of anchored word ranges', () => {
    const dom = createDom(`
      <body>
        <main>
          <h2 data-pagenarrator-id="fr-heading">
            <span>Définition</span>
            <span class="mw-editsection">modifier</span>
          </h2>
          <p data-pagenarrator-id="fr-paragraph">
            L'intelligence artificielle est l'ensemble des systèmes.
          </p>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('h2'));
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('fr-heading', 'Définition')).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'Définition',
    });

    expect(highlighter.highlightChunkByAnchor('fr-paragraph', "L'intelligence artificielle est l'ensemble des systèmes.")).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: "L'intelligence",
    });
    expect(highlighter.highlightWord(3)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: "l'ensemble",
    });
  });

  it('uses selected-text word offsets inside block anchors', () => {
    const dom = createDom(`
      <body>
        <p data-pagenarrator-id="sel-1">Ignore these words. But first of all lets answer one fundamental question.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('sel-1', 'But first of all lets answer one fundamental question.', {
      chunkText: 'But first of all lets answer one fundamental question.',
      domWordOffset: 3,
    })).toEqual({ ok: true });
    expect(highlighter.highlightWord(3)).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'But',
    });
  });
});
