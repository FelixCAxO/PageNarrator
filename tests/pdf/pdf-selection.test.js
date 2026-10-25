import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  PDF_SELECTION_REQUIRED_MESSAGE,
  createPdfSelectionArticle,
  createPdfSelectionFromSelection,
} from '../../src/lib/pdf-selection.js';

function createSelectionDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <main>
      <section class="pdf-page" data-page-number="1" data-pagenarrator-id="pdf-page-1">
        <div class="textLayer" data-pagenarrator-pdf-text="One two three">
          <span data-pagenarrator-pdf-order="0">One two three</span>
        </div>
      </section>
      <section class="pdf-page" data-page-number="2" data-pagenarrator-id="pdf-page-2">
        <div class="textLayer" data-pagenarrator-pdf-text="Alpha beta gamma delta">
          <span data-pagenarrator-pdf-order="0">Alpha </span>
          <span data-pagenarrator-pdf-order="1">beta gamma delta</span>
        </div>
      </section>
      <section class="pdf-page" data-page-number="3" data-pagenarrator-id="pdf-page-3">
        <div class="textLayer" data-pagenarrator-pdf-text="Four five six">
          <span data-pagenarrator-pdf-order="0">Four five six</span>
        </div>
      </section>
    </main>
  `, { pretendToBeVisual: true });
  return dom;
}

function selectRange(dom, startNode, startOffset, endNode, endOffset) {
  const range = dom.window.document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('PDF selection chunks', () => {
  it('returns a PDF article error before playback when no viewer text is selected', () => {
    const article = createPdfSelectionArticle({
      id: 42,
      title: 'Report.pdf',
      url: 'chrome-extension://test/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Freport.pdf',
    }, null, {
      sourceUrl: 'https://example.test/report.pdf',
    });

    expect(article).toEqual({
      source: 'pdf',
      title: 'Report.pdf',
      text: '',
      chunks: [],
      url: 'https://example.test/report.pdf',
      tabId: 42,
      error: PDF_SELECTION_REQUIRED_MESSAGE,
    });
  });

  it('builds one anchored chunk for a single-page PDF selection', () => {
    const dom = createSelectionDom();
    const spans = dom.window.document.querySelectorAll('[data-page-number="2"] span');
    const selection = selectRange(dom, spans[1].firstChild, 0, spans[1].firstChild, 'beta gamma'.length);

    const pdfSelection = createPdfSelectionFromSelection(selection, {
      documentRef: dom.window.document,
      pageCount: 12,
    });

    expect(pdfSelection).toEqual({
      source: 'selection',
      text: 'beta gamma',
      pageNumber: 2,
      anchorId: 'pdf-page-2',
      pageCount: 12,
      chunks: [{
        type: 'pdf-selection',
        speech: 'beta gamma',
        text: 'beta gamma',
        anchorText: 'beta gamma',
        anchorId: 'pdf-page-2',
        pageNumber: 2,
        domWordOffset: 1,
        speechPrefixWords: 0,
      }],
    });
  });

  it('counts selection offsets with the same tokens as highlighting, excluding standalone punctuation and symbols', () => {
    const dom = createSelectionDom();
    const spans = dom.window.document.querySelectorAll('[data-page-number="2"] span');
    spans[0].textContent = 'Rating — matrix ↑ ';
    spans[1].textContent = 'u1';
    const selection = selectRange(dom, spans[1].firstChild, 0, spans[1].firstChild, 2);
    const result = createPdfSelectionFromSelection(selection, { documentRef: dom.window.document });
    expect(result.chunks[0]).toMatchObject({ text: 'u1', domWordOffset: 2 });
    dom.window.close();
  });

  it('groups a multi-page PDF selection into page-anchored chunks with page-local word offsets', () => {
    const dom = createSelectionDom();
    const pageOneText = dom.window.document.querySelector('[data-page-number="1"] span').firstChild;
    const pageThreeText = dom.window.document.querySelector('[data-page-number="3"] span').firstChild;
    const selection = selectRange(dom, pageOneText, 'One '.length, pageThreeText, 'Four five'.length);

    const pdfSelection = createPdfSelectionFromSelection(selection, {
      documentRef: dom.window.document,
      pageCount: 3,
    });

    expect(pdfSelection).toMatchObject({
      text: 'two three Alpha beta gamma delta Four five',
      pageNumber: 1,
      anchorId: 'pdf-page-1',
      pageCount: 3,
    });
    expect(pdfSelection.chunks).toEqual([
      expect.objectContaining({
        speech: 'two three',
        anchorId: 'pdf-page-1',
        pageNumber: 1,
        domWordOffset: 1,
      }),
      expect.objectContaining({
        speech: 'Alpha beta gamma delta',
        anchorId: 'pdf-page-2',
        pageNumber: 2,
        domWordOffset: 0,
      }),
      expect.objectContaining({
        speech: 'Four five',
        anchorId: 'pdf-page-3',
        pageNumber: 3,
        domWordOffset: 0,
      }),
    ]);
  });
});
