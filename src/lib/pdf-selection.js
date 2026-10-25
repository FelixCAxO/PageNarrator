import { PDF_TEXT_LAYER_ORDER_ATTRIBUTE } from './pdf-extraction.js';
import { tokenizeSpokenWords } from './speech-tokenization.js';

export const PDF_SELECTION_REQUIRED_MESSAGE = 'Select text in the PageNarrator PDF viewer first.';
const PDF_PAGE_SELECTOR = '[data-page-number]';

export function createPdfSelectionFromSelection(selection, {
  documentRef = globalThis.document,
  pageCount = 0,
} = {}) {
  const selectedText = normalizeText(selection?.toString?.() ?? '');
  if (!selectedText || !selection?.rangeCount || !documentRef?.querySelectorAll) return null;

  const ranges = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!range?.collapsed) ranges.push(range);
  }
  if (!ranges.length) return null;

  const chunks = [...documentRef.querySelectorAll(PDF_PAGE_SELECTOR)]
    .sort((a, b) => getPageNumberFromElement(a) - getPageNumberFromElement(b))
    .flatMap((pageEl) => createSelectionChunkForPage(pageEl, ranges, documentRef) || []);
  if (!chunks.length) return null;

  const text = normalizeText(chunks.map((chunk) => chunk.text).join(' ')) || selectedText;
  const firstChunk = chunks[0];
  return {
    source: 'selection',
    text,
    pageNumber: firstChunk.pageNumber,
    anchorId: firstChunk.anchorId,
    pageCount: normalizePageCount(pageCount),
    chunks,
  };
}

export function createPdfSelectionArticle(tab = {}, pdfSelection = null, { sourceUrl = '' } = {}) {
  const text = normalizeText(pdfSelection?.text);
  const url = sourceUrl || tab?.url || tab?.pendingUrl || '';
  if (!text) {
    return {
      source: 'pdf',
      title: tab?.title || 'Selected text',
      text: '',
      chunks: [],
      url,
      tabId: tab?.id,
      error: PDF_SELECTION_REQUIRED_MESSAGE,
    };
  }

  const chunks = normalizeSelectionChunks(pdfSelection);
  const firstChunk = chunks[0] || {};
  return {
    source: 'pdf',
    title: tab?.title || 'Selected text',
    text,
    chunks,
    url,
    tabId: tab?.id,
    pageCount: normalizePageCount(pdfSelection?.pageCount),
    startPosition: {
      source: 'selection',
      text,
      ...(firstChunk.anchorId ? { anchorId: firstChunk.anchorId } : {}),
      ...(firstChunk.pageNumber ? { pageNumber: firstChunk.pageNumber } : {}),
    },
  };
}

function createSelectionChunkForPage(pageEl, ranges, documentRef) {
  const pageNumber = getPageNumberFromElement(pageEl);
  if (!pageNumber) return null;

  const selectedParts = [];
  const prefixParts = [];
  let foundSelectionOnPage = false;

  for (const node of getOrderedTextNodes(pageEl, documentRef)) {
    const segments = getSelectedTextNodeSegments(node, ranges, documentRef);
    if (!segments.length) {
      if (!foundSelectionOnPage) prefixParts.push(node.nodeValue || '');
      continue;
    }

    if (!foundSelectionOnPage) {
      prefixParts.push((node.nodeValue || '').slice(0, segments[0].start));
      foundSelectionOnPage = true;
    }

    for (const segment of segments) {
      selectedParts.push((node.nodeValue || '').slice(segment.start, segment.end));
    }
  }

  const text = normalizeText(selectedParts.join(' '));
  if (!text) return null;

  const anchorId = pageEl.dataset?.pagenarratorId || `pdf-page-${pageNumber}`;
  return {
    type: 'pdf-selection',
    speech: text,
    text,
    anchorText: text,
    anchorId,
    pageNumber,
    domWordOffset: countWords(prefixParts.join(' ')),
    speechPrefixWords: 0,
  };
}

function getSelectedTextNodeSegments(node, ranges, documentRef) {
  const value = node.nodeValue || '';
  const segments = ranges.flatMap((range) => {
    if (!rangeIntersectsNode(range, node, documentRef)) return [];

    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : value.length;
    const safeStart = Math.max(0, Math.min(value.length, start));
    const safeEnd = Math.max(0, Math.min(value.length, end));
    return safeEnd > safeStart ? [{ start: safeStart, end: safeEnd }] : [];
  });

  return mergeSegments(segments);
}

function rangeIntersectsNode(range, node, documentRef) {
  if (typeof range.intersectsNode === 'function') {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  const nodeRange = documentRef.createRange();
  nodeRange.selectNodeContents(node);
  const win = documentRef.defaultView || globalThis;
  return range.compareBoundaryPoints(win.Range.END_TO_START, nodeRange) < 0
    && range.compareBoundaryPoints(win.Range.START_TO_END, nodeRange) > 0;
}

function mergeSegments(segments) {
  const sorted = segments
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (!previous || segment.start > previous.end) {
      merged.push({ ...segment });
      continue;
    }
    previous.end = Math.max(previous.end, segment.end);
  }

  return merged;
}

function getOrderedTextNodes(element, documentRef) {
  const win = documentRef.defaultView || globalThis;
  const nodes = [];
  const walker = documentRef.createTreeWalker(element, win.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue?.trim()
        ? win.NodeFilter.FILTER_ACCEPT
        : win.NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node);
  }

  if (!element.querySelector?.(`[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`)) return nodes;

  return nodes
    .map((node, index) => ({
      node,
      index,
      order: getPdfTextNodeOrder(node),
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

function getPdfTextNodeOrder(node) {
  const element = node.parentElement?.closest?.(`[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`);
  const order = Number.parseInt(element?.getAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE) || '', 10);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function normalizeSelectionChunks(pdfSelection) {
  const chunks = Array.isArray(pdfSelection?.chunks) ? pdfSelection.chunks : [];
  if (chunks.length) {
    return chunks
      .map((chunk) => ({
        type: 'pdf-selection',
        speech: normalizeText(chunk?.speech ?? chunk?.text),
        text: normalizeText(chunk?.text ?? chunk?.speech),
        anchorText: normalizeText(chunk?.anchorText ?? chunk?.text ?? chunk?.speech),
        ...(chunk?.anchorId ? { anchorId: chunk.anchorId } : {}),
        ...(getSafePageNumber(chunk?.pageNumber) ? { pageNumber: getSafePageNumber(chunk.pageNumber) } : {}),
        domWordOffset: getSafeWordOffset(chunk?.domWordOffset),
        speechPrefixWords: 0,
      }))
      .filter((chunk) => chunk.text);
  }

  const text = normalizeText(pdfSelection?.text);
  const pageNumber = getSafePageNumber(pdfSelection?.pageNumber);
  const anchorId = pdfSelection?.anchorId || (pageNumber ? `pdf-page-${pageNumber}` : null);
  return [{
    type: 'pdf-selection',
    speech: text,
    text,
    anchorText: text,
    ...(anchorId ? { anchorId } : {}),
    ...(pageNumber ? { pageNumber } : {}),
    domWordOffset: 0,
    speechPrefixWords: 0,
  }].filter((chunk) => chunk.text);
}

function getPageNumberFromElement(pageEl) {
  return getSafePageNumber(pageEl?.dataset?.pageNumber);
}

function getSafePageNumber(value) {
  const pageNumber = Math.trunc(Number(value));
  return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 0;
}

function getSafeWordOffset(value) {
  const offset = Math.trunc(Number(value));
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function normalizePageCount(value) {
  const pageCount = Math.trunc(Number(value));
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 0;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function countWords(value) {
  return tokenizeSpokenWords(value, { includeNonSpoken: true }).length;
}
