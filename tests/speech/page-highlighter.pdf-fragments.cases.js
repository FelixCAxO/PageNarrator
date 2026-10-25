import { createDom, makeVisible, installHighlightCapture, getLatestHighlight, normalizePdfSoftHyphenWord } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { annotatePdfTextLayer } from '../../src/lib/pdf-extraction.js';
import { findMergedPdfFragmentMatch } from '../../src/lib/page-highlighter-word-plan.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from '../pdf/pdf-page-model.fixtures.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('highlights split PDF words without intervening non-narrated furniture', () => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="documenting scenarios">
      <span data-pagenarrator-pdf-order="0">document-</span>
      <span data-pagenarrator-pdf-order="1" data-pagenarrator-pdf-narrated="false">20</span>
      <span data-pagenarrator-pdf-order="2">ing</span>
      <span data-pagenarrator-pdf-order="3">scenarios</span>
    </section>`);
    makeVisible(dom.window.document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);
    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('documenting');
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe('scenarios');
    highlighter.dispose();
    dom.window.close();
  });

  it.each(['<span>4.</span><span>9</span>', '<span>4</span><span> . </span><span>9</span>'])('highlights a fragmented PDF decimal and the following words: %s', decimal => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="Average 4.9 seconds then 16.5 seconds">
      <span>Average</span>${decimal}<span>seconds then</span><span>16</span><span>.</span><span>5</span><span>seconds</span>
    </section>`);
    const section = dom.window.document.querySelector('section');
    section.querySelectorAll('span').forEach((span, index) => span.setAttribute('data-pagenarrator-pdf-order', String(index)));
    makeVisible(section);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document);
    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    for (const [index, text] of ['Average', '4.9', 'seconds', 'then', '16.5', 'seconds'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text.replace(/\s+/gu, '')).toBe(text);
    }
    highlighter.dispose();
    dom.window.close();
  });

  it('does not invent a PDF decimal point across other content', () => {
    const dom = createDom('<span>4</span><span>label</span><span>9</span>');
    const entries = [...dom.window.document.querySelectorAll('span')].map(span => {
      const range = dom.window.document.createRange();
      range.selectNodeContents(span);
      return { text: span.textContent, range };
    });
    expect(findMergedPdfFragmentMatch(entries, 0, '4.9', text => text, ranges => ranges)).toBeNull();
    dom.window.close();
  });

  it('highlights every glyph of a repaired PDF word and then the next word', () => {
    const dom = createDom('<section data-pagenarrator-id="pdf-page-1"></section>');
    const { document } = dom.window;
    const section = document.querySelector('section');
    const items = [...'confidence', 'remains'].map((str, index) => ({
      str, transform: [1, 0, 0, 1, 100 + index * 6 + (str.length > 1 ? 4 : 0), 300],
      width: str.length * 5, height: 12,
    }));
    for (const item of items) {
      const span = document.createElement('span');
      span.textContent = item.str;
      section.append(span);
    }
    annotatePdfTextLayer(section, items);
    expect(section.getAttribute('data-pagenarrator-pdf-text')).toBe('confidence remains.');
    makeVisible(section);
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    for (const [index, text] of ['confidence', 'remains'].entries()) {
      expect(highlighter.highlightWord(index)).toEqual({ ok: true });
      expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
    }
    highlighter.dispose();
    dom.window.close();
  });

  it.each([
    ['reversed', '<span data-pagenarrator-pdf-order="1">fidence</span><span data-pagenarrator-pdf-order="0">con</span><span data-pagenarrator-pdf-order="2">remains</span>', ['confidence', 'remains']],
    ['interleaved', '<span data-pagenarrator-pdf-order="0">con</span><span data-pagenarrator-pdf-order="3">later</span><span data-pagenarrator-pdf-order="1">fidence</span><span data-pagenarrator-pdf-order="2">remains</span>', ['confidence', 'remains', 'later']],
  ])('keeps repaired PDF word fragments separate when DOM text is %s', (_name, spans, words) => {
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="${words.join(' ')}">${spans}</section>`);
    makeVisible(dom.window.document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document, { pdfMode: true });
    try {
      expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
      for (const [index, word] of words.entries()) {
        expect(highlighter.highlightWord(index)).toEqual({ ok: true });
        expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(word);
      }
    } finally {
      highlighter.dispose();
      dom.window.close();
    }
  });

  it.each([
    ['complete source coverage', {}, true],
    ['missing offset', { domWordOffset: undefined }, false],
    ['negative offset', { domWordOffset: -1 }, false],
    ['fractional offset', { domWordOffset: 0.5 }, false],
    ['missing narration', { pdfNarration: undefined }, false],
    ['missing narration orders', { pdfNarration: { speech: 'Confidence remains' } }, false],
    ['missing source word', { chunkText: 'Confidence absent remains', pdfNarration: { speech: 'Confidence absent remains', narratedItemOrders: [0, 1, 2] } }, false],
    ['different narration word', { chunkText: 'Confidence differs' }, false],
    ['PDF source selection', { pdfSelection: true }, false],
  ])('grounds source-mapped PDF fragments only with complete narration: %s', (_name, overrides, grounded) => {
    const speech = 'Confidence remains';
    const dom = createDom(`<section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="${speech}"><span data-pagenarrator-pdf-order="0">Con</span><span data-pagenarrator-pdf-order="1">fidence</span><span data-pagenarrator-pdf-order="2"> remains</span></section>`);
    makeVisible(dom.window.document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(dom.window.document, { pdfMode: true });
    try {
      expect(highlighter.highlightChunkByAnchor('pdf-page-1', speech, {
        chunkText: speech,
        domWordOffset: 0,
        pdfNarration: { speech, narratedItemOrders: [0, 1, 2] },
        reportGrounding: true,
        ...overrides,
      })).toEqual({ ok: true, grounded, fallback: !grounded });
      if (grounded) {
        expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')?.text).toBe('Confidenceremains');
        for (const [index, text] of ['Confidence', 'remains'].entries()) {
          expect(highlighter.highlightWord(index)).toEqual({ ok: true });
          expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text).toBe(text);
        }
      }
    } finally {
      highlighter.dispose();
      dom.window.close();
    }
  });

  it('maps a repaired PDF word back to adjacent unhyphenated text-layer fragments', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="applications remain available">
          <span data-pagenarrator-pdf-order="0">appli</span>
          <span data-pagenarrator-pdf-order="1">cations</span>
          <span data-pagenarrator-pdf-order="2">remain available</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toMatchObject({
      name: 'pagenarrator-word-0',
    });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0').text.replace(/\s+/gu, '')).toBe('applications');
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'remain',
    });
  });

  it('preserves a period when one spoken PDF token spans two DOM words', () => {
    const dom = createDom(`<body><section class="pdf-page" data-pagenarrator-id="pdf-page-1"
      data-pagenarrator-pdf-text="Dec. 4.2013. Enrolling">
      <span data-pagenarrator-pdf-order="0">Dec. </span>
      <span data-pagenarrator-pdf-order="1">4. </span>
      <span data-pagenarrator-pdf-order="2">2013. </span>
      <span data-pagenarrator-pdf-order="3">Enrolling</span></section></body>`);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0').text.replace(/\s+/gu, '')).toBe('4.2013');
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0').text).toBe('Enrolling');
  });

  it('counts PDF soft-hyphen line wraps as one spoken word', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1">
          <span data-pagenarrator-pdf-order="0">Verbatim tran-</span>
          <span data-pagenarrator-pdf-order="1">scripts were produced.</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor(
      'pdf-page-1',
      'Verbatim transcripts were produced.',
      { chunkText: 'Verbatim transcripts were produced.' },
    )).toEqual({ ok: true });
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0').name).toBe('pagenarrator-word-0');
    expect(normalizePdfSoftHyphenWord(getLatestHighlight(highlighted, 'pagenarrator-word-0').text)).toBe('transcripts');
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'were',
    });
  });

  it('uses chunk-local text for a PDF active range while keeping page-wide word indices', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1">
          <span data-pagenarrator-pdf-order="0">First chunk words.</span>
          <span data-pagenarrator-pdf-order="1">Second chunk words.</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor(
      'pdf-page-1',
      'First chunk words. Second chunk words.',
      { chunkText: 'Second chunk words.' },
    )).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')).toEqual({
      name: 'pagenarrator-chunk',
      text: 'Second chunk words.',
    });

    expect(highlighter.highlightWord(3)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'Second',
    });
  });

  it('keeps PDF chunk highlights in reading order without swallowing interleaved DOM text', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1">
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

    expect(highlighter.highlightChunkByAnchor(
      'pdf-page-1',
      'Alpha one Beta two Gamma three Delta four',
      { chunkText: 'Alpha one Beta two' },
    )).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')).toEqual({
      name: 'pagenarrator-chunk',
      text: 'Alpha oneBeta two',
    });
  });

  it('uses the split chunk word offset to choose the later duplicate PDF text range', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1">
          <span data-pagenarrator-pdf-order="0" data-copy="first">Repeat section words.</span>
          <span data-pagenarrator-pdf-order="1">Middle bridge words.</span>
          <span data-pagenarrator-pdf-order="2" data-copy="second">Repeat section words.</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(range) {
        this.range = range;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({
            name,
            text: highlight.range.toString(),
            copy: highlight.range.startContainer.parentElement?.dataset.copy || '',
          });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor(
      'pdf-page-1',
      'Repeat section words. Middle bridge words. Repeat section words.',
      {
        chunkText: 'Repeat section words.',
        domWordOffset: 6,
      },
    )).toEqual({ ok: true });

    expect(getLatestHighlight(highlighted, 'pagenarrator-chunk')).toEqual({
      name: 'pagenarrator-chunk',
      text: 'Repeat section words.',
      copy: 'second',
    });
  });

  it('maps a preserved compound hyphen across PDF line fragments', () => {
    const dom = createDom(`
      <body>
        <section class="pdf-page" data-pagenarrator-id="pdf-page-1" data-pagenarrator-pdf-text="real-world settings">
          <span data-pagenarrator-pdf-order="0">real-</span>
          <span data-pagenarrator-pdf-order="1">world settings</span>
        </section>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('section'));
    const highlighted = installHighlightCapture();
    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('pdf-page-1', null)).toEqual({ ok: true });
    expect(highlighter.highlightWord(0)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')?.text.replace(/\s+/gu, '')).toBe('real-world');
    expect(highlighter.highlightWord(1)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'settings',
    });
  });
  it.each([
    ['CC-BY 4.0', '4.0', ', see', 'https://example.test/license', null],
    ['Creative Commons Attribution 3.0', '3.0', '. The inline threshold remains 0.', null, 'The inline threshold remains 0.'],
    ['CC-BY 4.0', '4.0', ', see https://example.test/license. The linked threshold remains 0.', null, 'The linked threshold remains 0.'],
  ])('omits whole decimal license metadata while preserving body text and raw source: %s %s %s', (license, version, suffix, url, inlineProse) => {
    const label = `License: ${license}${suffix}`;
    const body = 'The release version is 2.1 and the following result is 0.';
    const items = [
      item('The summary remains readable.', 54, 680, 220),
      item(label, 54, 640, 300),
      ...(url ? [item(url, 356, 640, 200)] : []),
      item(body, 54, 600, 300),
    ];
    const bodyIndex = items.length - 1;
    const model = createPdfPageModel(items);
    expect(model.speech).not.toMatch(/License|CC-BY|Creative Commons|Attribution|see|https:|example\.test|test\/license|[34]\.0/u);
    expect(model.speech).toContain(body);
    if (inlineProse) expect(model.speech).toContain(inlineProse);
    expect(model.anchorText).toContain(label);
    if (url) expect(model.anchorText).toContain(url);
    const spoken = tokenizeSpokenWords(model.speech).map(token => token.text);
    expect(spoken).toEqual([
      'The', 'summary', 'remains', 'readable',
      ...(inlineProse ? tokenizeSpokenWords(inlineProse).map(token => token.text) : []),
      'The', 'release', 'version', 'is', '2.1', 'and', 'the', 'following', 'result', 'is', '0',
    ]);

    const dom = createDom('<section class="pdf-page" data-pagenarrator-id="pdf-page-1"><div class="textLayer"></div></section>');
    const { document } = dom.window, section = document.querySelector('section'), layer = document.querySelector('.textLayer');
    for (const [index, source] of items.entries()) {
      const span = document.createElement('span'); span.textContent = source.str; span.dataset.sourceItem = String(index); layer.append(span);
    }
    const annotations = annotatePdfTextLayer(layer, items);
    const orders = new Map(annotations.map(annotation => [annotation.originalIndex, annotation.order]));
    const captured = new Map();
    globalThis.Highlight = class TestHighlight { constructor(...ranges) { this.ranges = ranges; } };
    globalThis.CSS = { highlights: { set: (name, value) => captured.set(name, value.ranges), delete: name => captured.delete(name) } };
    makeVisible(section);
    const highlighter = createPageHighlighter(document, { pdfMode: true });
    try {
      expect(layer.children[1].textContent).toBe(label);
      expect(layer.children[1].getAttribute('data-pagenarrator-pdf-narrated')).toBe(String(Boolean(inlineProse)));
      const rawVersion = document.createRange();
      rawVersion.setStart(layer.children[1].firstChild, label.indexOf(version));
      rawVersion.setEnd(layer.children[1].firstChild, label.indexOf(version) + version.length);
      expect(rawVersion.toString()).toBe(version);
      expect(rawVersion.startContainer).toBe(layer.children[1].firstChild);
      expect(model.anchorText).toContain(label);
      expect(highlighter.highlightChunkByAnchor('pdf-page-1', model.anchorText, {
        chunkText: model.speech, domWordOffset: 0, reportGrounding: true,
        pdfNarration: { speech: model.speech, narratedItemOrders: model.narratedOriginalIndices.map(index => orders.get(index)) },
      })).toEqual({ ok: true, grounded: true, fallback: false });
      for (const text of ['2.1', '0']) {
        expect(highlighter.highlightWord(spoken.lastIndexOf(text))).toEqual({ ok: true });
        const ranges = captured.get('pagenarrator-word-0');
        expect(ranges?.map(range => range.toString()).join('')).toBe(text);
        expect(ranges).toHaveLength(1);
        expect(ranges[0].startContainer).toBe(layer.children[bodyIndex].firstChild);
        expect(ranges[0].endContainer).toBe(layer.children[bodyIndex].firstChild);
        expect(ranges[0].startOffset).toBe(body.indexOf(text));
        expect(ranges[0].endOffset).toBe(body.indexOf(text) + text.length);
      }
      if (inlineProse) {
        expect(highlighter.highlightWord(4)).toEqual({ ok: true });
        const inline = captured.get('pagenarrator-word-0');
        expect(inline?.map(range => range.toString()).join('')).toBe('The');
        expect(inline).toHaveLength(1);
        expect(inline[0].startContainer).toBe(layer.children[1].firstChild);
        expect(inline[0].startOffset).toBe(label.indexOf(inlineProse));
      }
      expect(layer.children[1].textContent).toBe(label);
      expect(layer.children[bodyIndex].textContent).toBe(body);
    } finally {
      highlighter.dispose(); dom.window.close();
    }
  });

  it.each([
    ['License: CC-BY. The inline threshold remains 0.', 'The inline threshold remains 0.'],
    ['License: Creative Commons', null],
  ])('retains unambiguous metadata filtering and following prose: %s', (metadata, inlineProse) => {
    const model = createPdfPageModel([
      item('The summary remains readable.', 54, 680, 220),
      item(metadata, 54, 640, 300),
      item('The following result is 0.', 54, 600, 220),
    ]);
    expect(model.speech).toContain('The summary remains readable.');
    expect(model.speech).toContain('The following result is 0.');
    if (inlineProse) expect(model.speech).toContain(inlineProse);
    expect(model.speech).not.toMatch(/License|CC-BY|Creative Commons/u);
  });

});
