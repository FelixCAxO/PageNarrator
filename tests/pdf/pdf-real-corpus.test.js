import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import {
  annotatePdfTextLayer,
  configurePdfWorker,
} from '../../src/lib/pdf-extraction.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import { chunkText } from '../../src/lib/speech-chunks.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { OPEN_SOURCE_PDF_CORPUS } from '../fixtures/open-pdf-corpus.js';

const RUN_REAL_PDF_CORPUS = process.env.PN_REAL_PDF_CORPUS === '1';
const REAL_CORPUS_LIMIT = Number.parseInt(process.env.PN_REAL_PDF_LIMIT || '', 10);
const FETCH_TIMEOUT_MS = 45000;
const LIVE_TEST_TIMEOUT_MS = 420000;
const PDF_MAGIC = '%PDF-';

const realCorpusIt = RUN_REAL_PDF_CORPUS ? it : it.skip;

describe('real open PDF corpus highlighting', () => {
  afterEach(() => {
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('keeps a full-scope corpus of 100 real public PDFs', () => {
    expect(OPEN_SOURCE_PDF_CORPUS).toHaveLength(100);
    expect(new Set(OPEN_SOURCE_PDF_CORPUS.map((pdf) => pdf.id)).size).toBe(100);

    for (const pdf of OPEN_SOURCE_PDF_CORPUS) {
      expect(pdf).toMatchObject({
        id: expect.stringMatching(/^\d{4}\.\d{4,5}v\d+$/),
        title: expect.any(String),
        published: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        source: 'Fixed versioned arXiv URL selection; licenses not inferred',
        url: expect.stringMatching(/^https:\/\/arxiv\.org\/pdf\/\d{4}\.\d{4,5}v\d+$/),
      });
      expect(pdf.url).toBe(`https://arxiv.org/pdf/${pdf.id}`);
    }
  });

  realCorpusIt('marks split sections and spoken words across real PDF.js text layers', async () => {
    const selectedPdfs = Number.isFinite(REAL_CORPUS_LIMIT) && REAL_CORPUS_LIMIT > 0
      ? OPEN_SOURCE_PDF_CORPUS.slice(0, REAL_CORPUS_LIMIT)
      : OPEN_SOURCE_PDF_CORPUS;
    const results = [];

    for (const pdf of selectedPdfs) {
      results.push(await evaluatePdfHighlighting(pdf));
    }

    const failures = results.flatMap((result) => result.failures);
    const sectionFailures = failures.filter((failure) => failure.reason.includes('Section'));
    const wordFailures = failures.filter((failure) => failure.reason.includes('Word'));
    const sectionsChecked = results.reduce((sum, result) => sum + result.sectionsChecked, 0);
    const wordsChecked = results.reduce((sum, result) => sum + result.wordsChecked, 0);
    const sectionAccuracy = (sectionsChecked - sectionFailures.length) / Math.max(1, sectionsChecked);
    const wordAccuracy = (wordsChecked - wordFailures.length) / Math.max(1, wordsChecked);

    expect(sectionsChecked).toBeGreaterThanOrEqual(selectedPdfs.length * 2);
    expect(wordsChecked).toBeGreaterThanOrEqual(sectionsChecked * 2);
    expect(sectionAccuracy, formatCorpusScore({
      selectedPdfs,
      sectionAccuracy,
      wordAccuracy,
      failures,
    })).toBeGreaterThanOrEqual(0.98);
    expect(wordAccuracy, formatCorpusScore({
      selectedPdfs,
      sectionAccuracy,
      wordAccuracy,
      failures,
    })).toBeGreaterThanOrEqual(0.95);
  }, LIVE_TEST_TIMEOUT_MS);
});

async function evaluatePdfHighlighting(pdf) {
  const bytes = await fetchPdfBytes(pdf);
  const page = await extractFirstReadablePage(bytes);
  const chunks = chunkText([{
    type: 'pdf-page',
    speech: page.speech,
    text: page.anchorText,
    anchorText: page.anchorText,
    anchorId: `pdf-page-${page.pageNumber}`,
    speechPrefixWords: 0,
    pageNumber: page.pageNumber,
  }], 360, { targetMinLen: 180 });
  const sections = chunks.slice(0, 2);
  const dom = createPdfTextLayerDom(page);
  const captured = installHighlightCapture();
  const highlighter = createPageHighlighter(dom.window.document);
  const failures = [];
  let sectionsChecked = 0;
  let wordsChecked = 0;

  if (sections.length < 2) {
    failures.push({ id: pdf.id, reason: `Expected at least 2 speech sections, got ${sections.length}` });
  }

  for (const section of sections) {
    const sectionResult = highlighter.highlightChunkByAnchor(section.anchorId, section.anchorText, {
      chunkText: section.speech,
      domWordOffset: section.domWordOffset,
    });
    sectionsChecked += 1;

    if (!sectionResult.ok) {
      failures.push({ id: pdf.id, reason: 'Section highlight failed', section: section.speech });
      continue;
    }

    const overlay = dom.window.document.querySelector('[data-pagenarrator-region="active"]');
    if (overlay?.style.display !== 'block') {
      failures.push({ id: pdf.id, reason: 'Section overlay was not visible', section: section.speech });
    }

    for (const wordIndex of chooseWordIndices(section.speech)) {
      const domWordIndex = getDomWordIndexForSpeechWord(section, wordIndex);
      const expectedToken = tokenizeSpokenWords(section.speech)[wordIndex]?.text;
      const wordResult = highlighter.highlightWord(domWordIndex);
      const actualToken = getLatestWordHighlight(captured)?.text;
      wordsChecked += 1;

      if (!expectedToken || !wordResult.ok || normalizeToken(actualToken) !== normalizeToken(expectedToken)) {
        failures.push({
          id: pdf.id,
          reason: 'Word highlight mismatch',
          pageNumber: page.pageNumber,
          domWordIndex,
          expected: expectedToken,
          actual: actualToken,
          section: section.speech,
        });
      }
    }
  }

  return {
    id: pdf.id,
    sectionsChecked,
    wordsChecked,
    failures,
  };
}

async function fetchPdfBytes(pdf) {
  const response = await fetch(pdf.url, {
    headers: { accept: 'application/pdf' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Could not download ${pdf.id}: ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!hasPdfMagic(bytes)) throw new Error(`Downloaded file is not a PDF: ${pdf.id}`);
  return bytes;
}

async function extractFirstReadablePage(bytes) {
  configurePdfWorker(pdfjs);
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableWorker: true,
    useSystemFonts: true,
    enableScripting: false,
  });
  const document = await loadingTask.promise;

  try {
    const maxPages = Math.min(document.numPages, 5);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const model = createPdfPageModel(content.items, { pageView: page.view, direction: content.dir });
      page.cleanup();

      if (tokenizeSpokenWords(model.speech).length >= 80 && model.orderedItems.length >= 40) {
        return {
          pageNumber,
          items: content.items,
          anchorText: model.anchorText,
          speech: model.speech,
        };
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  throw new Error('No readable PDF page found in the first 5 pages.');
}

function createPdfTextLayerDom(page) {
  const dom = new JSDOM('<body><section class="pdf-page"><div class="textLayer"></div></section></body>', {
    pretendToBeVisual: true,
    url: 'https://example.test/pdf-viewer.html',
  });
  const { document } = dom.window;
  const section = document.querySelector('section');
  const textLayer = document.querySelector('.textLayer');

  section.dataset.pagenarratorId = `pdf-page-${page.pageNumber}`;
  Object.defineProperty(dom.window, 'innerHeight', { value: 900, configurable: true });
  dom.window.scrollBy = () => {};
  section.getBoundingClientRect = () => ({
    top: 100,
    left: 60,
    right: 760,
    bottom: 880,
    width: 700,
    height: 780,
  });
  makeTextRangeGeometry(dom.window, {
    top: 120,
    left: 80,
    right: 720,
    bottom: 300,
    width: 640,
    height: 180,
  });

  for (const item of page.items) {
    if (!normalizeSpeech(item.str)) continue;
    const span = document.createElement('span');
    span.textContent = normalizeSpeech(item.str);
    textLayer.appendChild(span);
  }

  annotatePdfTextLayer(textLayer, page.items);
  return dom;
}

function makeTextRangeGeometry(window, rect) {
  const originalCreateRange = window.document.createRange.bind(window.document);
  window.document.createRange = () => {
    const range = originalCreateRange();
    range.getBoundingClientRect = () => rect;
    range.getClientRects = () => [rect];
    return range;
  };
}

function installHighlightCapture() {
  const captured = [];
  globalThis.Highlight = class TestHighlight {
    constructor(range) {
      this.range = range;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        captured.push({ name, text: highlight.range.toString() });
      },
      delete() {},
    },
  };
  return captured;
}

function chooseWordIndices(text) {
  const tokens = tokenizeSpokenWords(text);
  const wordLike = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => /[\p{L}\p{N}]/u.test(token.text));
  const lastIndex = Math.max(0, wordLike.length - 1);
  return [...new Set([
    wordLike[0]?.index,
    wordLike[Math.min(2, lastIndex)]?.index,
    wordLike[Math.floor(lastIndex / 2)]?.index,
    wordLike[lastIndex]?.index,
  ].filter(Number.isFinite))];
}

function getLatestWordHighlight(captured) {
  return [...captured].reverse().find((entry) => entry.name === 'pagenarrator-word-0') || null;
}

function hasPdfMagic(bytes) {
  const text = new TextDecoder().decode(bytes.slice(0, PDF_MAGIC.length));
  return text === PDF_MAGIC;
}

function normalizeSpeech(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return normalizeSpeech(value)
    .toLowerCase()
    .replace(/-\s+(?=\p{Ll})/gu, '')
    .replace(/(\p{L})-(?=\p{Ll})/gu, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-');
}

function formatCorpusScore({ selectedPdfs, sectionAccuracy, wordAccuracy, failures }) {
  return [
    `${selectedPdfs.length} PDFs checked`,
    `section accuracy: ${formatPercent(sectionAccuracy)}`,
    `word accuracy: ${formatPercent(wordAccuracy)}`,
    `sample failures: ${JSON.stringify(failures.slice(0, 10), null, 2)}`,
  ].join('\n');
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
