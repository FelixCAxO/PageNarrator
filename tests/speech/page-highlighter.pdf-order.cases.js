import { createDom, makeVisible, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('uses document-filtered PDF narration for repeated header words and restores it after a redraw', () => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-2" data-pagenarrator-pdf-text="Report. Report explains this result. Report.">
      <div class="textLayer" data-pagenarrator-pdf-order="true">
      <span data-pagenarrator-pdf-order="0" data-pagenarrator-pdf-narrated="true">Report</span>
      <span data-pagenarrator-pdf-order="1" data-pagenarrator-pdf-narrated="true">Report explains this result.</span>
      <span data-pagenarrator-pdf-order="2" data-pagenarrator-pdf-narrated="true">Report</span>
      </div>
    </section>`);
    const { document } = dom.window;
    const section = document.querySelector('section');
    makeVisible(section);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document, { pdfMode: true });
    const pdfNarration = { speech: 'Report explains this result.', narratedItemOrders: [1] };
    const assertBody = () => {
      expect(highlighter.highlightChunkByAnchor('pdf-page-2', pdfNarration.speech, { pdfNarration })).toEqual({ ok: true });
      for (const [index, word] of ['Report', 'explains', 'this', 'result'].entries()) {
        expect(highlighter.highlightWord(index)).toEqual({ ok: true });
        expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(word);
      }
      expect(section.querySelector('[data-pagenarrator-pdf-order="0"]').getAttribute('data-pagenarrator-pdf-narrated')).toBe('false');
      expect(section.querySelector('[data-pagenarrator-pdf-order="2"]').getAttribute('data-pagenarrator-pdf-narrated')).toBe('false');
      expect(section.querySelector('.textLayer').getAttribute('data-pagenarrator-pdf-narrated')).toBeNull();
    };
    assertBody();
    section.innerHTML = section.innerHTML.replaceAll('="false"', '="true"');
    assertBody();
    const fullNarration = { speech: 'Report. Report explains this result. Report.', narratedItemOrders: [0, 1, 2] };
    expect(highlighter.highlightChunkByAnchor('pdf-page-2', fullNarration.speech, { pdfNarration: fullNarration })).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(section.querySelector('[data-pagenarrator-pdf-order="0"]').getAttribute('data-pagenarrator-pdf-narrated')).toBe('true');
    expect(highlighter.highlightWord(5)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('Report');
  });

  it('builds PDF word ranges from extraction reading order instead of text-layer DOM order', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Verbatim transcripts were produced.">
          <span data-pagenarrator-pdf-order="2">Gamma three</span>
          <span data-pagenarrator-pdf-order="0">Alpha one</span>
          <span data-pagenarrator-pdf-order="3">Delta four</span>
          <span data-pagenarrator-pdf-order="1">Beta two</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'Alpha',
    });

    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'Beta',
    });
  });

  it('follows deferred-caption narration order without losing preceding table header words', () => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-6">
      <div class="textLayer" data-pagenarrator-pdf-order="true" data-pagenarrator-pdf-text="Table caption. SciFact ArguAna. nDCG 10 R 100. GenQREnsemble improves recall.">
        <span data-pagenarrator-pdf-order="0">Table caption.</span>
        <span data-pagenarrator-pdf-order="1">SciFact ArguAna.</span>
        <span data-pagenarrator-pdf-order="2">nDCG 10 R 100.</span>
        <span data-pagenarrator-pdf-order="3">GenQREnsemble improves recall.</span>
      </div>
    </section>`);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document, { pdfMode: true });
    const words = ['Table', 'caption', 'GenQREnsemble', 'improves', 'recall', 'SciFact', 'ArguAna', 'nDCG', '10', 'R', '100'];
    const pdfNarration = { speech: words.join(' '), narratedItemOrders: [0, 3, 1, 2] };
    expect(highlighter.highlightChunkByAnchor('pdf-page-6', pdfNarration.speech, { pdfNarration })).toEqual({ ok: true });
    for (const [index, word] of words.entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(word);
    }
    expect(document.querySelector('[data-pagenarrator-pdf-order="3"]').getAttribute('data-pagenarrator-pdf-narration-order')).toBe('1');
  });

  it('skips PDF symbol tokens in the spoken word index so later words do not shift', () => {
    const speechText = 'ID \u2217 , \u2217\u2217 ID Eugen Beck';
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1">
          <div data-pagenarrator-pdf-text="${speechText}">
            <span data-pagenarrator-pdf-order="0">ID</span>
            <span data-pagenarrator-pdf-order="1">\u2217</span>
            <span data-pagenarrator-pdf-order="2">,</span>
            <span data-pagenarrator-pdf-order="3">\u2217\u2217</span>
            <span data-pagenarrator-pdf-order="4">ID</span>
            <span data-pagenarrator-pdf-order="5">Eugen Beck</span>
          </div>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor(
      'pdf-page-1',
      speechText,
      { chunkText: speechText },
    )).toEqual({ ok: true });
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'Eugen',
    });
  });

  it('skips stray PDF DOM tokens instead of shifting later word marks', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Alpha beta gamma delta">
          <span data-pagenarrator-pdf-order="0">Alpha</span>
          <span data-pagenarrator-pdf-order="1">OCR</span>
          <span data-pagenarrator-pdf-order="2">beta gamma</span>
          <span data-pagenarrator-pdf-order="3">delta</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'beta',
    });

    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'gamma',
    });

    expect(highlighter.highlightWord(3)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'delta',
    });
  });

  it('resynchronizes PDF words after a long non-spoken citation or affiliation run', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Alpha beta">
          <span data-pagenarrator-pdf-order="0">Alpha</span>
          <span data-pagenarrator-pdf-order="1">Smith Department University Example Sweden ORCID 2025 affiliation</span>
          <span data-pagenarrator-pdf-order="2">beta</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'beta',
    });
  });

  it('resynchronizes after a dense non-narrated PDF figure region', () => {
    const figureLabels = Array.from({ length: 320 }, (_, index) => `label${index}`).join(' ');
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Alpha beta">
          <span data-pagenarrator-pdf-order="0">Alpha</span>
          <span data-pagenarrator-pdf-order="1" data-pagenarrator-pdf-narrated="false">${figureLabels}</span>
          <span data-pagenarrator-pdf-order="2">beta</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'beta',
    });
  });

  it('matches PDF ligature tokens during lookahead resync', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="office">
          <span data-pagenarrator-pdf-order="0">artifact</span>
          <span data-pagenarrator-pdf-order="1">of\uFB01ce</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'of\uFB01ce',
    });
  });

  it('maps PDF tokens using page speech context instead of filtering isolated parenthetical spans', () => {
    const dom = createDom('<section class="pdf-page" data-pagenarrator-id="pdf-page-1"></section>');
    const { document } = dom.window;
    const section = document.querySelector('section');
    const fragments = ['(unfinished', 'label', '(E)', 'The', 'user', 'name', 'and', 'password', '(E', 'other'];
    section.setAttribute('data-pagenarrator-pdf-text', fragments.join(' '));
    fragments.forEach((text, index) => {
      const span = document.createElement('span');
      span.setAttribute('data-pagenarrator-pdf-order', String(index));
      span.textContent = text;
      section.append(span);
    });
    makeVisible(section);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    for (const [index, text] of ['unfinished', 'label', 'E', 'The', 'user', 'name', 'and', 'password', 'E', 'other'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
    highlighter.dispose();
    dom.window.close();
  });

  it('highlights explicitly selected PDF cells while page narration still omits them', () => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Explanation before. Explanation after.">
      <span data-pagenarrator-pdf-order="0" data-pagenarrator-pdf-narration-order="0">Explanation before.</span>
      <span data-pagenarrator-pdf-order="1" data-pagenarrator-pdf-narration-order="3" data-pagenarrator-pdf-narrated="false">u1</span>
      <span data-pagenarrator-pdf-order="2" data-pagenarrator-pdf-narration-order="2" data-pagenarrator-pdf-narrated="false">5</span>
      <span data-pagenarrator-pdf-order="3" data-pagenarrator-pdf-narration-order="1">Explanation after.</span>
    </section>`);
    makeVisible(dom.window.document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);
    highlighter.highlightChunkByAnchor('pdf-page-1', 'u1', { chunkText: 'u1', domWordOffset: 2, pdfSelection: true });
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('u1');
    highlighter.highlightChunkByAnchor('pdf-page-1', null);
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('Explanation');
    highlighter.dispose();
    dom.window.close();
  });
});
