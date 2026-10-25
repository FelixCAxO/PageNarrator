import { getNoiseSelector } from '../dom-selectors.js';
import { extractChatTurnSpeechChunks, extractReadableArticle } from './reading-model.js';
import { normalizeCodeText } from '../text-normalization.js';
import { needsTextNodeSeparator } from '../page-highlighter-search-index.js';
import { chunkText } from '../speech-chunks.js';
import {
  isNavigationHeadingElement,
  isReferenceTextElement,
  isShareWidgetLabel,
  isSpeakableSourceText,
  isTextlessIconElement,
  stripPrivateUseCharacters,
} from './text-noise-filter.js';
import {
  findChatTurns,
  findCurrentChatTurn,
  getChatTurn,
  getChatTurnNumber,
  revealChatTurn,
} from './chat-transcript.js';

export { hasChatTurns, hasNumberedChatTurns, revealChatTranscriptStart } from './chat-transcript.js';

const NOISE_SELECTOR = getNoiseSelector({ surface: 'article' });
const TEXT_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, blockquote, pre, code, li, figcaption, td, th, label, button, a, div, section, article, main';

export function chooseArticleExtraction(document, { articleFallback, readSelection = false, startMode = 'viewport' } = {}) {
  markExtraction(document, 'pn:extract:start');
  try {
    const article = chooseArticleExtractionResult(document, { articleFallback, readSelection, startMode });
    return { ...article, totalReadableWordCount: getTotalReadableWordCount(article) };
  } finally {
    markExtraction(document, 'pn:extract:end');
  }
}

export async function* iterateArticleSpeechChunks(article, speechChunkOptions = {}) {
  const maxLen = normalizePositiveInteger(speechChunkOptions?.maxLen);
  const targetMinLen = normalizeNonNegativeInteger(speechChunkOptions?.targetMinLen);
  let afterShortHeading = false;

  for (const block of getArticleSpeechBlocks(article)) {
    const chunks = typeof block === 'string'
      ? chunkText(block, maxLen, { targetMinLen })
      : chunkText([block], maxLen, { targetMinLen });
    for (const chunk of chunks) {
      if (afterShortHeading) {
        // Shorten only the first buffered chunk, keeping long passages inexpensive.
        yield* chunkText(typeof chunk === 'string' ? chunk : [chunk], maxLen, {
          targetMinLen, initialMaxChunkLength: 120, initialTargetMinLength: 80,
        });
        afterShortHeading = false;
      } else {
        yield chunk;
      }
    }
    afterShortHeading = ['page-title', 'heading'].includes(block?.type)
      && String(block?.speech ?? block?.text ?? '').length < targetMinLen;
  }
}

/**
 * Streams a chat transcript whose app only renders turns near the viewport (ChatGPT). Turns are
 * numbered, so a missing number between or after the extracted turns is revealed (scrolled into
 * the DOM) and extracted when the stream reaches it, instead of being skipped.
 * @param {Document} document
 * @param {any} article
 * @param {any} [speechChunkOptions]
 * @param {Parameters<typeof revealChatTurn>[2]} [revealOptions]
 */
export async function* iterateChatTranscriptSpeechChunks(document, article, speechChunkOptions = {}, revealOptions = {}) {
  const maxLen = normalizePositiveInteger(speechChunkOptions?.maxLen);
  const targetMinLen = normalizeNonNegativeInteger(speechChunkOptions?.targetMinLen);
  const chunkBlock = (block) => chunkText(typeof block === 'string' ? block : [block], maxLen, { targetMinLen });
  let lastNumber = null;

  async function* revealTurns(from, to) {
    for (let number = from; number <= to; number += 1) {
      const turn = await revealChatTurn(document, number, revealOptions);
      if (!turn) {
        if (to === Number.POSITIVE_INFINITY) return;
        continue;
      }
      lastNumber = number;
      for (const block of extractChatTurnSpeechChunks(document, [turn])) yield* chunkBlock(block);
    }
  }

  for (const block of getArticleSpeechBlocks(article)) {
    const number = getChunkChatTurnNumber(document, block);
    if (number !== null && lastNumber !== null && number > lastNumber + 1) {
      yield* revealTurns(lastNumber + 1, number - 1);
    }
    if (number !== null) lastNumber = Math.max(lastNumber ?? number, number);
    yield* chunkBlock(block);
  }

  if (lastNumber !== null) yield* revealTurns(lastNumber + 1, Number.POSITIVE_INFINITY);
}

function getChunkChatTurnNumber(document, block) {
  const anchorId = typeof block === 'string' ? '' : block?.anchorId;
  const element = anchorId ? getAnchoredElement(document, anchorId) : null;
  return element ? getChatTurnNumber(getChatTurn(element)) : null;
}

function chooseArticleExtractionResult(document, { articleFallback, readSelection = false, startMode = 'viewport' } = {}) {
  const url = document.defaultView?.location?.href || document.location?.href || '';
  const title = document.title;
  const selectionInfo = getSelectionInfo(document);

  if (readSelection) {
    if (!selectionInfo.text) {
      return {
        source: 'selection',
        title,
        text: '',
        chunks: [],
        url,
        error: 'Select text on the page first.',
      };
    }

    const chunks = extractSelectionChunks(document, selectionInfo) || [];
    const fallbackChunk = chunks.length ? null : anchorSelection(document, selectionInfo.text, selectionInfo.range);
    const selectedChunks = chunks.length ? chunks : fallbackChunk ? [fallbackChunk] : undefined;
    const firstChunk = selectedChunks?.[0];
    const selectedText = chunks.length ? chunks.map((chunk) => chunk.speech).join(' ') : selectionInfo.text;
    return withStartPosition(document, {
      source: 'selection',
      title,
      text: selectedText,
      chunks: selectedChunks,
      url,
    }, {
      source: 'selection',
      anchorId: firstChunk?.anchorId || null,
      text: selectedText,
    });
  }

  const structured = extractReadableArticle(document);
  const structuredChunks = Array.isArray(structured.chunks) ? structured.chunks : [];
  const hasStructuredContent = structuredChunks.some((chunk) => chunk.type !== 'page-title');
  const hasStructuredCodeBlock = structuredChunks.some((chunk) => chunk.type === 'code');
  const structuredScore = scoreArticleText(structured.text);
  const structuredChunkCount = structuredChunks.length;
  const shouldTryArticleFallback = !hasStructuredContent
    || (!structured.isChat && hasStructuredCodeBlock && structuredScore < 1200)
    || (!structured.isChat && structuredChunkCount >= 3 && structuredScore < 1200);
  const fallbackResult = shouldTryArticleFallback
    ? extractFallbackArticle(document, articleFallback, {
      title,
      url,
      root: findLikelyArticleRoot(document, structured.chunks),
    })
    : null;

  if (hasStructuredContent) {
    if (fallbackResult) {
      const fallbackScore = scoreArticleText(fallbackResult.text);
      if (fallbackScore > structuredScore * 1.25) return withStartPosition(document, fallbackResult, null, { startMode });
    }

    if (structuredChunks.every((chunk) => chunk.type === 'link' || chunk.type === 'page-title')) {
      const bodyText = cleanupBodyTextWithoutClone(document);
      const linkText = structuredChunks.filter((chunk) => chunk.type === 'link').map((chunk) => chunk.anchorText).join(' ');
      // Bare prose around inline links must not become a links-only reading.
      if (scoreArticleText(bodyText) > scoreArticleText(linkText)) {
        return withStartPosition(document, { source: 'fallback', title, text: bodyText, url }, null, { startMode });
      }
    }

    return withStartPosition(document, {
      source: 'reading-model',
      title,
      text: structured.text,
      chunks: structured.chunks,
      url,
      ...(structured.isChat ? { chat: true } : {}),
    }, null, { startMode });
  }

  if (fallbackResult) return withStartPosition(document, fallbackResult, null, { startMode });

  const chunks = extractAnchoredTextBlocks(document);
  const text = chunks.length
    ? chunks.map((chunk) => chunk.speech).join('\n\n')
    : cleanupBodyTextWithoutClone(document);
  if (!text.trim()) {
    return {
      source: 'empty',
      title,
      text: '',
      chunks: [],
      url,
      error: 'No readable article text was found.',
    };
  }
  return withStartPosition(document, { source: 'fallback', title, text, chunks: chunks.length ? chunks : undefined, url }, null, { startMode });
}

function markExtraction(document, name) {
  const marker = document?.defaultView?.performance || globalThis.performance;
  try {
    marker?.mark?.(name);
  } catch {
    // Performance marks are diagnostic only.
  }
}

function extractFallbackArticle(document, articleFallback, { title, url, root = null }) {
  if (!articleFallback?.isArticleDocument?.(document)) return null;
  const article = articleFallback.parse(document, { root });
  const recovered = sanitizeExtractedText(article?.textContent);
  if (!recovered) return null;

  const anchored = extractAnchoredTextBlocks(document, recovered);
  return {
    source: 'article-fallback',
    title: article.title || title,
    byline: article.byline || null,
    text: recovered,
    chunks: anchored.length ? anchored : undefined,
    url,
  };
}

function findLikelyArticleRoot(document, chunks = []) {
  const rootSelector = 'article, main, [role="main"], .post-full, .post-full-content';
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const anchorId = chunk?.anchorId;
    const element = anchorId ? getAnchoredElement(document, anchorId) : null;
    const root = element?.closest?.(rootSelector);
    if (root && root !== document.body && root !== document.documentElement) return root;
  }

  const article = document.querySelector('article');
  if (article) return article;

  const main = document.querySelector('main, [role="main"]');
  return main && main !== document.body && main !== document.documentElement ? main : null;
}

function withStartPosition(document, article, explicitStart = null, { startMode = 'viewport' } = {}) {
  if (explicitStart) {
    return {
      ...article,
      startPosition: pruneStartPosition(explicitStart),
    };
  }

  if (startMode === 'top') return article;

  const chatStartPosition = getChatStartPosition(document, article?.chunks);
  const startPosition = chatStartPosition === undefined
    ? getViewportStartPosition(document, article?.chunks)
    : chatStartPosition;
  return startPosition ? { ...article, startPosition } : article;
}

function getSelectionInfo(document) {
  const selection = document.defaultView?.getSelection?.();
  const text = String(selection || '').replace(/\s+/g, ' ').trim();
  const range = selection?.rangeCount > 0 ? selection.getRangeAt(0) : null;
  return { text, range };
}

// Returns undefined when the page is not a chat (use the generic viewport start), or null when
// the conversation start is on screen so reading begins at the top like any other page.
function getChatStartPosition(document, chunks = []) {
  if (!Array.isArray(chunks) || !chunks.length) return undefined;
  const turns = findChatTurns(document);
  if (!turns.length) return undefined;

  const win = document.defaultView;
  const viewportHeight = Number(win?.innerHeight) || document.documentElement?.clientHeight || 0;
  const turn = findCurrentChatTurn(turns, viewportHeight);
  if (!turn) return undefined;

  const chunk = chunks.find((candidate) => {
    const element = candidate?.anchorId ? getAnchoredElement(document, candidate.anchorId) : null;
    return element && getChatTurn(element) === turn;
  });
  if (!chunk) return undefined;
  if (turn === turns[0] && turn.getBoundingClientRect().top >= 0) return null;

  return pruneStartPosition({
    source: 'chat-turn',
    anchorId: chunk.anchorId,
    text: getChunkStartText(chunk),
  });
}

function getViewportStartPosition(document, chunks = []) {
  if (!Array.isArray(chunks) || !chunks.length) return null;

  const win = document.defaultView;
  const viewportHeight = Number(win?.innerHeight) || document.documentElement?.clientHeight || 0;
  if (!viewportHeight) return null;

  const candidates = [];
  const seenAnchors = new Set();
  for (const chunk of chunks) {
    const anchorId = chunk?.anchorId;
    if (!anchorId || seenAnchors.has(anchorId)) continue;
    seenAnchors.add(anchorId);

    const element = getAnchoredElement(document, anchorId);
    const rect = element?.getBoundingClientRect?.();
    if (!isUsableViewportRect(rect, viewportHeight)) continue;

    candidates.push({
      anchorId,
      chunk,
      element,
      top: Math.max(0, rect.top),
      visibleTop: rect.top,
    });
  }

  const sorted = candidates.sort((a, b) => {
    if (a.top !== b.top) return a.top - b.top;
    return a.visibleTop - b.visibleTop;
  });
  // A block that started above the fold with only its last lines showing has already been read;
  // start at the next block instead (same rule as the chat "previous answer tail").
  const candidate = isThinTopTail(sorted[0], viewportHeight) && sorted[1] ? sorted[1] : sorted[0];
  if (!candidate) return null;

  return pruneStartPosition({
    source: 'viewport',
    anchorId: candidate.anchorId,
    text: getViewportStartText(document, candidate.element) || getChunkStartText(candidate.chunk),
  });
}

function isThinTopTail(candidate, viewportHeight) {
  if (!candidate || candidate.visibleTop >= 0) return false;
  const rect = candidate.element.getBoundingClientRect();
  const visibleHeight = Math.min(rect.bottom, viewportHeight);
  return visibleHeight < Math.min(viewportHeight * 0.3, rect.height * 0.5);
}

function isUsableViewportRect(rect, viewportHeight) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < viewportHeight;
}

function getViewportStartText(document, element) {
  const range = getViewportCaretRange(document, element);
  if (!range || !element.contains(range.startContainer)) return '';
  return normalizeText(readTextFromRangeStart(element, range.startContainer, range.startOffset).slice(0, 400));
}

function getViewportCaretRange(document, element) {
  const win = document.defaultView;
  const rect = element?.getBoundingClientRect?.();
  if (!win || !rect || rect.width <= 0 || rect.height <= 0) return null;

  const x = clamp(rect.left + Math.min(48, Math.max(8, rect.width * 0.18)), 0, Math.max(0, win.innerWidth || rect.right) - 1);
  const y = clamp(Math.max(8, rect.top + 4), 0, Math.max(0, win.innerHeight || rect.bottom) - 1);

  const position = document.caretPositionFromPoint?.(x, y);
  if (position?.offsetNode) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    return range;
  }

  return document.caretRangeFromPoint?.(x, y) || null;
}

function readTextFromRangeStart(root, startNode, startOffset) {
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  let reading = false;
  const parts = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!reading && node !== startNode) continue;
    if (!reading) {
      reading = true;
      parts.push((node.nodeValue || '').slice(startOffset));
      continue;
    }
    parts.push(node.nodeValue || '');
    if (parts.join(' ').length >= 400) break;
  }

  return parts.join(' ');
}

function getChunkStartText(chunk) {
  return normalizeText(chunk?.anchorText ?? chunk?.text ?? chunk?.speech ?? '');
}

function getAnchoredElement(document, anchorId) {
  return document.querySelector(`[data-pagenarrator-id="${cssEscape(anchorId)}"]`);
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function pruneStartPosition(position) {
  return Object.fromEntries(
    Object.entries(position || {}).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreArticleText(text) {
  const value = normalizeText(text);
  const words = value.split(/\s+/).filter(Boolean).length;
  const linky = (value.match(/\b(login|subscribe|share|cookie|advertisement)\b/gi) || []).length;
  return words - linky * 12;
}

function anchorSelection(document, selectionText, selectionRange = null) {
  const range = selectionRange;
  if (range && !range.collapsed) {
    const anchorId = nextAnchorId(document, 'sel');
    const span = document.createElement('span');
    span.dataset.pagenarratorId = anchorId;
    try {
      range.surroundContents(span);
      return createChunk(selectionText, anchorId);
    } catch {
      const block = closestTextBlock(range.startContainer);
      if (block?.dataset) {
        block.dataset.pagenarratorId ||= anchorId;
        return createChunk(selectionText, block.dataset.pagenarratorId);
      }
    }
  }

  const textNodeMatch = findTextNodeContaining(document, selectionText);
  if (textNodeMatch) {
    const { node, start, end } = textNodeMatch;
    const anchorId = nextAnchorId(document, 'sel');
    const rangeForText = document.createRange();
    rangeForText.setStart(node, start);
    rangeForText.setEnd(node, end);
    const span = document.createElement('span');
    span.dataset.pagenarratorId = anchorId;
    rangeForText.surroundContents(span);
    return createChunk(selectionText, anchorId);
  }

  return null;
}

function extractSelectionChunks(document, selectionInfo) {
  const range = selectionInfo?.range;
  if (!range || range.collapsed) return [];

  const groups = collectSelectedTextBlocks(document, range);
  return groups.flatMap((group) => {
    const text = readSourceTextRange(group.block, group.startNode, group.startOffset, group.endNode, group.endOffset);
    if (!text) return [];

    const anchorId = ensureSelectionAnchor(document, group.block);
    const domWordOffset = countWords(readTextBeforeRangeStart(group.block, group.startNode, group.startOffset));
    return createChunk(text, anchorId, { domWordOffset });
  });
}

function collectSelectedTextBlocks(document, range) {
  const root = document.body || document.documentElement;
  const nodeFilter = document.defaultView.NodeFilter;
  const groups = new Map();
  const walker = document.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return nodeFilter.FILTER_REJECT;
      if (shouldRejectTextNode(node)) return nodeFilter.FILTER_REJECT;
      if (!range.intersectsNode?.(node)) return nodeFilter.FILTER_REJECT;
      return nodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = closestTextBlock(node);
    if (!block || block === document.body || block === document.documentElement) continue;

    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (startOffset >= endOffset) continue;

    if (!groups.has(block)) {
      groups.set(block, {
        block,
        startNode: node,
        startOffset,
        endNode: node,
        endOffset,
      });
      continue;
    }

    const group = groups.get(block);
    group.endNode = node;
    group.endOffset = endOffset;
  }

  return [...groups.values()];
}

function ensureSelectionAnchor(document, block) {
  if (!block?.dataset) return null;
  block.dataset.pagenarratorId ||= nextAnchorId(document, 'sel');
  return block.dataset.pagenarratorId;
}

function readTextBeforeRangeStart(block, startNode, startOffset) {
  return readSourceTextRange(block, null, 0, startNode, startOffset);
}

function readSourceTextRange(block, startNode, startOffset, endNode, endOffset) {
  const document = block.ownerDocument;
  const walker = document.createTreeWalker(block, document.defaultView.NodeFilter.SHOW_TEXT);
  const parts = [];
  let previousNode = null;
  let reading = !startNode;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!reading && node !== startNode) continue;
    reading = true;
    if (node.nodeValue && !shouldRejectTextNode(node)) {
      const text = node.nodeValue.slice(node === startNode ? startOffset : 0, node === endNode ? endOffset : undefined);
      if (text) {
        if (needsTextNodeSeparator(previousNode, node)) parts.push(' ');
        parts.push(text);
        previousNode = node;
      }
    }
    if (node === endNode) break;
  }

  return normalizeText(parts.join(''));
}

function extractAnchoredTextBlocks(document, preferredText = '') {
  const preferred = normalizeText(preferredText).toLowerCase();
  const blocks = new Map();
  let previousNode = null;
  let anchorCounter = getInitialAnchorCounter(document);
  const nextLocalAnchorId = (prefix = '') => {
    anchorCounter += 1;
    return prefix ? `${prefix}-${anchorCounter}` : String(anchorCounter);
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, document.defaultView.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue && !shouldRejectTextNode(node)
        ? document.defaultView.NodeFilter.FILTER_ACCEPT : document.defaultView.NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = closestTextBlock(node);
    if (block?.matches('a')) block = block.parentElement?.closest(TEXT_BLOCK_SELECTOR) || block;
    if (!block || block === document.body || block === document.documentElement) continue;
    if (!blocks.has(block)) blocks.set(block, []);
    if (!block.matches('pre, code') && needsTextNodeSeparator(previousNode, node)) blocks.get(block).push(' ');
    blocks.get(block).push(node.nodeValue);
    previousNode = node;
  }

  const chunks = [];
  for (const [block, pieces] of blocks) {
    const isCodeBlock = block.matches?.('pre, code');
    const text = isCodeBlock ? normalizeCodeText(pieces.join('')) : normalizeText(pieces.join(''));
    if (!isSpeakableSourceText(text) || text.length < 24) continue;
    const comparableText = normalizeText(text).toLowerCase();
    if (preferred && !preferred.includes(comparableText) && !comparableText.includes(preferred)) continue;
    block.dataset.pagenarratorId ||= nextLocalAnchorId();
    chunks.push(createChunk(text, block.dataset.pagenarratorId, { preserveCode: isCodeBlock }));
  }

  return chunks;
}

function createChunk(text, anchorId, options = {}) {
  const normalized = options.preserveCode ? normalizeCodeText(text) : normalizeText(text);
  const domWordOffset = Number(options.domWordOffset);
  const chunk = {
    type: options.preserveCode ? 'code' : 'paragraph',
    speech: normalized,
    text: normalized,
    anchorText: normalized,
    anchorId,
    speechPrefixWords: 0,
  };
  if (Number.isFinite(domWordOffset) && domWordOffset > 0) {
    chunk.domWordOffset = Math.trunc(domWordOffset);
  }
  return chunk;
}

function closestTextBlock(node) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  const pre = element?.closest?.('pre');
  if (pre) return pre;
  const code = element?.closest?.('code');
  const prose = code?.parentElement?.closest?.('p, blockquote, li, dt, dd, figcaption, td, th, h1, h2, h3, h4, h5, h6, [role="paragraph"], [role="heading"]');
  if (prose) return prose;
  return element?.closest?.(TEXT_BLOCK_SELECTOR) || null;
}

function findTextNodeContaining(document, text) {
  const normalizedNeedle = normalizeText(text);
  const walker = document.createTreeWalker(document.body || document.documentElement, document.defaultView.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const source = node.nodeValue || '';
    const start = source.indexOf(normalizedNeedle);
    if (start !== -1) return { node, start, end: start + normalizedNeedle.length };
  }
  return null;
}

function cleanupBodyTextWithoutClone(document) {
  const root = document.body || document.documentElement;
  const parts = [];
  const nodeFilter = document.defaultView.NodeFilter;
  const walker = document.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return nodeFilter.FILTER_REJECT;
      if (shouldRejectTextNode(node)) return nodeFilter.FILTER_REJECT;
      return nodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.nodeValue);
  }

  return normalizeText(parts.join(' '));
}

function normalizeText(value) {
  return stripPrivateUseCharacters(String(value || ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .trim();
}

function sanitizeExtractedText(value) {
  const lines = stripPrivateUseCharacters(String(value || ''))
    .split(/\r?\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => isSpeakableSourceText(line) && !isShareWidgetLabel(line));
  const text = lines.join('\n\n').trim();
  return text.replace(/(?:^|\s)[^\p{L}\p{N}\s]+$/u, '').trim();
}

function shouldRejectTextNode(node) {
  const text = node.nodeValue?.trim() || '';
  if (text && !isSpeakableSourceText(text) && !/^[.,!?;:'"…\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Pd}]+$/u.test(text)) return true;
  const parent = node.parentElement;
  if (!parent || parent.closest(NOISE_SELECTOR)) return true;
  return hasIgnoredTextAncestor(parent);
}

function hasIgnoredTextAncestor(element) {
  for (let node = element; node; node = node.parentElement) {
    if (isTextlessIconElement(node)) return true;
    if (isNavigationHeadingElement(node)) return true;
    if (isReferenceTextElement(node)) return true;
    if (node.hasAttribute?.('hidden')) return true;
    if (node.getAttribute?.('aria-hidden') === 'true') return true;

    if (node.style?.display === 'none' || node.style?.visibility === 'hidden'
      || Number.parseFloat(node.style?.opacity || '') === 0) return true;
  }
  return false;
}

function countWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function getTotalReadableWordCount(article) {
  if (Array.isArray(article?.chunks) && article.chunks.length) {
    return article.chunks.reduce((total, chunk) => total + countWords(chunk?.speech ?? chunk?.text ?? chunk), 0);
  }
  return countWords(article?.text);
}

function getArticleSpeechBlocks(article = {}) {
  if (Array.isArray(article.chunks)) {
    if (article.chunks.length) return article.chunks;
    return splitArticleText(article.text);
  }

  if (isIterable(article.chunks)) return article.chunks;

  return splitArticleText(article.text);
}

function splitArticleText(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function isIterable(value) {
  return typeof value === 'object'
    && value !== null
    && typeof value[Symbol.iterator] === 'function';
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeNonNegativeInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function nextAnchorId(document, prefix = '') {
  const next = getInitialAnchorCounter(document) + 1;
  return prefix ? `${prefix}-${next}` : String(next);
}

function getInitialAnchorCounter(document) {
  return [...document.querySelectorAll('[data-pagenarrator-id]')]
    .map((element) => String(element.dataset.pagenarratorId || '').match(/\d+$/)?.[0])
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
}
