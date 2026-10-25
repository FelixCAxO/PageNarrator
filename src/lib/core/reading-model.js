// @ts-check
import { getNoiseSelector } from '../dom-selectors.js';
import { normalizeCodeText } from '../text-normalization.js';
import { tokenizeSpokenWords } from '../speech-tokenization.js';
import { isNumericMatrix, numericMatrixLabel } from '../numeric-matrix.js';
import {
  isNavigationHeadingElement,
  isReferenceTextElement,
  isShareWidgetLabel,
  isSpeakableSourceText,
  isTextlessIconElement,
  stripPrivateUseCharacters,
} from './text-noise-filter.js';
export { isReferenceTextElement } from './text-noise-filter.js';
import {
  CHAT_PLAIN_TEXT_SELECTOR,
  findChatTranscriptRoot,
  findChatTurns,
  getChatRoleLabel,
  getChatTurn,
  isChatPlainTextBlock,
  isVisuallyHiddenChatElement,
} from './chat-transcript.js';

const LANDMARK_ROOTS = [
  '.kg-card-markdown',
  '.post-full-content .kg-card-markdown',
  '.mw-parser-output',
  'main',
  'article',
  '[role="main"]',
  '.main',
  '#main',
  '.content',
  '#content',
];

const READABLE_SELECTOR = [
  '[role="heading"]',
  '[role="paragraph"]',
  '[role="list"]',
  '[role="table"]',
  '[role="grid"]',
  '[role="treegrid"]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'dl',
  'figcaption',
  'img',
  'table',
  'form',
  'button',
  'a[href]',
].join(',');

const NOISE_SELECTOR = getNoiseSelector({ surface: 'web' });

const HIDDEN_TEXT_SELECTOR = [
  'script',
  'style',
  'template',
  'noscript',
  'mjx-assistive-mml',
  '.MJX_Assistive_MathML',
  '.MathJax_Preview',
  '.MathJax_SVG_Hidden',
  '.mw-editsection',
  '.mw-indicator',
  '.mw-indicators',
  'sup.reference',
  '[data-mjx-hidden]',
  '[aria-hidden="true"]',
  '[hidden]',
].join(',');

const MATH_CONTAINER_SELECTOR = [
  'mjx-container',
  '.MathJax',
  '.MathJax_Display',
  '.katex',
].join(',');

const CONTAINER_SELECTOR = 'article, section, main, div, body';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const TABLE_SELECTOR = 'table, [role="table"], [role="grid"], [role="treegrid"]';
const TABLE_CELL_SELECTOR = 'th, td, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
const ANCHOR_ID_ATTRIBUTE = 'pagenarratorId';

/**
 * @param {Document} document
 * @param {{ onlyChatTurns?: Element[] }} [options] Restrict a chat read to these turns (turns
 *   rendered after extraction started) and skip the page title.
 */
export function buildReadingModel(document, { onlyChatTurns } = {}) {
  const chatTurns = onlyChatTurns || findChatTurns(document);
  const isChat = chatTurns.length > 0;
  const turnFilter = onlyChatTurns ? new Set(onlyChatTurns) : null;
  const root = (isChat && findChatTranscriptRoot(chatTurns)) || findReadingRoot(document);
  const title = turnFilter ? '' : normalizeText(document?.title);
  let anchorCounter = getInitialAnchorCounter(document);
  const chunks = createLazyChunkArray(() => {
    const rawChunks = [];
    const seen = new Set();

    const anchorElement = (element, chunk) => {
      if (!element?.dataset) return chunk;
      if (!element.dataset[ANCHOR_ID_ATTRIBUTE]) {
        anchorCounter += 1;
        element.dataset[ANCHOR_ID_ATTRIBUTE] = String(anchorCounter);
      }
      return { ...chunk, anchorId: element.dataset[ANCHOR_ID_ATTRIBUTE] };
    };

    if (title) {
      const titleAnchor = findTitleAnchorElement(root, title);
      const titleText = getReadableText(titleAnchor) || title;
      rawChunks.push(anchorElement(titleAnchor, { type: 'page-title', text: titleText }));
      seen.add(textKey(titleText));
    }

    let currentChatTurn = null;
    const selector = isChat ? `${READABLE_SELECTOR},${CHAT_PLAIN_TEXT_SELECTOR}` : READABLE_SELECTOR;
    for (const element of root.querySelectorAll(selector)) {
      if (!shouldConsiderElement(element)) continue;
      if (hasReadableAncestor(element)) continue;

      if (isChat) {
        // Chat mode reads message turns only: no composer, sidebar rail, or copy/like buttons.
        const turn = getChatTurn(element);
        if (!turn || element.matches('button, form')) continue;
        if (turnFilter && !turnFilter.has(turn)) continue;
        if (isVisuallyHiddenChatElement(element)) continue;
        if (turn !== currentChatTurn) {
          // Repeated prompts and per-turn role labels ("You said:") are real content in a chat.
          currentChatTurn = turn;
          seen.clear();
          pushUnique(rawChunks, seen, anchorElement(turn, { type: 'chat-role', text: getChatRoleLabel(turn) }));
        }
        if (element.matches(CHAT_PLAIN_TEXT_SELECTOR)) {
          if (isChatPlainTextBlock(element)) {
            pushUnique(rawChunks, seen, anchorElement(element, { type: 'paragraph', text: getReadableText(element) }), { allowDuplicate: true });
          }
          continue;
        }
      }

      if (element.matches(HEADING_SELECTOR)) {
        pushUnique(rawChunks, seen, anchorElement(element, {
          type: 'heading',
          level: Number(element.getAttribute('aria-level') || element.tagName.slice(1)) || 2,
          text: getReadableText(element),
        }));
        continue;
      }

      if (element.matches('p, blockquote, figcaption, [role="paragraph"]')) {
        pushUnique(rawChunks, seen, anchorElement(element, {
          type: element.matches('figcaption') ? 'caption' : element.matches('blockquote') ? 'quote' : 'paragraph',
          text: getReadableText(element),
        }), { allowDuplicate: !element.matches('figcaption') });
        continue;
      }

      if (element.matches('pre, code')) {
        appendCodeBlock(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('ul, ol, [role="list"]')) {
        appendList(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('dl')) {
        appendDefinitionList(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('img')) {
        appendImage(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches(TABLE_SELECTOR)) {
        appendTable(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('form')) {
        appendForm(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('button')) {
        appendButton(rawChunks, seen, element, anchorElement);
        continue;
      }

      if (element.matches('a[href]')) {
        appendStandaloneLink(rawChunks, seen, element, anchorElement);
      }
    }

    const interactiveMode = shouldUseInteractiveLabels(rawChunks);
    return cleanRenderedChunks(rawChunks
      .flatMap((chunk) => renderChunk(chunk, { interactiveMode })));
  });

  return { title, chunks, isChat };
}

export function renderReadingModelForSpeech(model) {
  return renderReadingModelForSpeechChunks(model)
    .map((chunk) => chunk.speech)
    .join('\n\n');
}

export function renderReadingModelForSpeechChunks(model) {
  const chunks = Array.isArray(model?.chunks)
    ? model.chunks
    : Array.from(model?.chunks || []);
  if (chunks.some((chunk) => chunk && typeof chunk.speech === 'string')) {
    return cleanRenderedChunks(chunks)
      .map(withGlobalDomWordStartIndex);
  }
  const interactiveMode = shouldUseInteractiveLabels(chunks);
  return cleanRenderedChunks(chunks
    .flatMap((chunk) => renderChunk(chunk, { interactiveMode })))
    .map(withGlobalDomWordStartIndex);
}

export function getDomWordIndexForSpeechWord(chunk, speechWordIndex) {
  const numericIndex = Number(speechWordIndex);
  if (!Number.isFinite(numericIndex)) return -1;
  if (typeof chunk === 'string') return Math.max(0, Math.trunc(numericIndex));
  if (!chunk || chunk.anchorText == null) return -1;
  if (Array.isArray(chunk.speechWordMap)) {
    const mapped = chunk.speechWordMap[Math.trunc(numericIndex)];
    return Number.isInteger(mapped) && mapped >= 0 ? mapped : -1;
  }
  const domIndex = getGlobalDomWordStartIndex(chunk) + Math.trunc(numericIndex) - getSpeechPrefixWords(chunk);
  return domIndex >= 0 ? domIndex : -1;
}

export function extractReadableArticle(document) {
  const model = buildReadingModel(document);
  const chunks = renderReadingModelForSpeechChunks(model);
  return {
    title: model.title,
    text: chunks.map((chunk) => chunk.speech).join('\n\n'),
    chunks,
    isChat: model.isChat,
  };
}

/**
 * Speech chunks for chat turns that appeared after the first extraction (virtualized chats).
 * @param {Document} document
 * @param {Element[]} turns
 */
export function extractChatTurnSpeechChunks(document, turns) {
  if (!turns.length) return [];
  return renderReadingModelForSpeechChunks(buildReadingModel(document, { onlyChatTurns: turns }));
}

export function extractReadableText(document) {
  return extractReadableArticle(document).text;
}

function findReadingRoot(document) {
  const landmarkCandidates = [
    ...new Set(
      LANDMARK_ROOTS
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .filter(shouldConsiderElement),
    ),
  ];

  if (landmarkCandidates.length) {
    // Untitled article cards can be biographies or teasers beside unwrapped prose.
    const candidates = landmarkCandidates.every((element) => element.matches('article') && !element.querySelector('h1'))
      ? [...new Set([...landmarkCandidates, ...[...document.querySelectorAll('p')]
        .map((paragraph) => paragraph.parentElement)
        .filter((element) => element?.matches(CONTAINER_SELECTOR))])].filter(shouldConsiderElement)
      : landmarkCandidates;
    return candidates
      .map((element) => ({ element, score: scoreContainer(element) }))
      .sort((a, b) => b.score - a.score)[0].element;
  }

  const bestContainer = [...document.querySelectorAll(CONTAINER_SELECTOR)]
    .filter(shouldConsiderElement)
    .map((element) => ({
      element,
      score: scoreContainer(element),
    }))
    .sort((a, b) => b.score - a.score)[0];

  return bestContainer?.element || document.body || document.documentElement;
}

function findTitleAnchorElement(root, title) {
  const titleKey = textKey(title);
  if (!titleKey) return null;

  const document = root.ownerDocument;
  const rootCandidates = getTitleCandidates(root, titleKey);
  if (rootCandidates.length) {
    return chooseBestTitleCandidate(rootCandidates);
  }

  const documentCandidates = document ? getTitleCandidates(document, titleKey) : [];
  return chooseBestTitleCandidate(documentCandidates);
}

function getTitleCandidates(scope, titleKey) {
  return [...scope.querySelectorAll(HEADING_SELECTOR)]
    .filter(isVisibleTitleCandidate)
    .map((heading, index) => ({
      heading,
      index,
      key: textKey(getReadableText(heading)),
      level: Number(heading.tagName.slice(1)) || 6,
    }))
    .filter((candidate) => candidate.key && titleMatchesHeading(titleKey, candidate.key));
}

function chooseBestTitleCandidate(candidates) {
  return candidates
    .sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return a.index - b.index;
    })[0]?.heading || null;
}

function titleMatchesHeading(titleKey, headingKey) {
  return headingKey === titleKey
    || titleKey.startsWith(`${headingKey} - `)
    || titleKey.startsWith(`${headingKey} | `)
    || titleKey.endsWith(` - ${headingKey}`)
    || titleKey.endsWith(` | ${headingKey}`)
    || (headingKey.length >= 8 && titleKey.includes(headingKey));
}

function isVisibleTitleCandidate(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.hasAttribute('hidden')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;

  if (element.style?.display === 'none' || element.style?.visibility === 'hidden'
    || Number.parseFloat(element.style?.opacity || '') === 0) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

  const win = element.ownerDocument.defaultView;
  if (win && !/jsdom/i.test(win.navigator?.userAgent || '')) {
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width <= 0 && rect.height <= 0) return false;
  }

  return true;
}

function scoreContainer(element) {
  const blocks = element.querySelectorAll('h1, h2, h3, p, li, blockquote, table, figure').length;
  const textLength = normalizeText(element.textContent).length;
  const noisy = element.querySelectorAll(NOISE_SELECTOR).length;
  const boilerplate = (normalizeText(element.textContent).match(/\b(login|subscribe|share|cookie|advertisement|comments?|related|promo)\b/gi) || []).length;
  const semanticBoost = element.matches('article, .kg-card-markdown, .post-full-content, .mw-parser-output, [itemprop~="articleBody"]') ? 900 : 0;
  const nestedFocusedPenalty = !element.matches('.kg-card-markdown, .mw-parser-output, [itemprop~="articleBody"]')
    && element.querySelector('.kg-card-markdown, .mw-parser-output, [itemprop~="articleBody"]')
    ? 850
    : 0;
  const broadRootPenalty = element.matches('main, [role="main"], body')
    && element.querySelector('article, .kg-card-markdown, .mw-parser-output, [itemprop~="articleBody"]')
    ? 700
    : 0;
  return semanticBoost
    + blocks * 80
    + Math.min(textLength, 4000)
    - noisy * 220
    - boilerplate * 80
    - nestedFocusedPenalty
    - broadRootPenalty;
}

function appendList(chunks, seen, list, anchorElement) {
  const items = [...list.querySelectorAll('li, [role="listitem"]')]
    .filter((child) => child.parentElement.closest('ul, ol, [role="list"]') === list)
    .filter(shouldConsiderElement)
    .map((child) => ({ element: child, text: getReadableText(child) }))
    .filter((item) => isSpeakableSourceText(item.text));

  if (!items.length) return;

  chunks.push(anchorElement(list, {
    type: 'list',
    count: items.length,
    itemCount: items.length,
    ordered: list.matches('ol'),
    items: items.map((item) => item.text),
    text: items.map((item) => item.text).join(' '),
  }));
}

function appendDefinitionList(chunks, seen, list, anchorElement) {
  const items = [...list.querySelectorAll('dt, dd')]
    .filter((child) => child.parentElement.closest('dl') === list)
    .filter(shouldConsiderElement)
    .map((child) => ({ element: child, text: getReadableText(child) }))
    .filter((item) => item.text);

  items.forEach(({ element, text }, index) => {
    pushUnique(chunks, seen, anchorElement(element, { type: 'list-item', index, text }), { allowDuplicate: true });
  });
}

function appendCodeBlock(chunks, seen, codeElement, anchorElement) {
  const text = getCodeText(codeElement);
  if (!text) return;
  pushUnique(chunks, seen, anchorElement(codeElement, { type: 'code', text }), { preserveCode: true });
}

function appendImage(chunks, seen, image, anchorElement) {
  const text = normalizeText(
    image.getAttribute('alt') ||
    image.getAttribute('aria-label') ||
    image.getAttribute('title'),
  );
  if (!isUsefulImageAlt(text, image)) return;
  pushUnique(chunks, seen, anchorElement(image, { type: 'image', text }));
}

function appendTable(chunks, seen, table, anchorElement) {
  const rows = [...(table.rows || table.querySelectorAll('[role="row"]'))]
    .filter((row) => row.closest(TABLE_SELECTOR) === table)
    .filter(shouldConsiderElement)
    .map((row) => ({
      element: row,
      elements: [...row.querySelectorAll(TABLE_CELL_SELECTOR)]
        .filter((cell) => cell.closest('tr, [role="row"]') === row && cell.closest(TABLE_SELECTOR) === table),
    }))
    .map((row, index) => {
      const position = Number(row.element.getAttribute('aria-rowindex'));
      return { ...row, position: Number.isInteger(position) && position > 0 ? position : index + 1,
        cells: row.elements.map((cell) => shouldConsiderElement(cell) ? getTableCellText(cell) : '') };
    })
    .sort((a, b) => a.position - b.position);

  if (!rows.some((row) => row.cells.some(Boolean))) return;

  const captionElement = [...table.querySelectorAll('caption')].find((cell) => cell.closest(TABLE_SELECTOR) === table);
  const caption = getTableCellText(captionElement) || normalizeText(table.getAttribute('aria-label'));
  let headerRowCount = 0;
  for (const row of rows) {
    if (!row.elements.length || !row.elements.every((cell) => cell.matches('th:not([scope="row"]), [role="columnheader"]'))) break;
    headerRowCount += 1;
  }
  const matrixRows = numericMatrixLabel(rows[0].cells[0]) ? rows : rows.slice(headerRowCount);
  if (isNumericMatrix(matrixRows.map((row) => row.cells))) {
    if (caption) pushUnique(chunks, seen, anchorElement(captionElement, { type: 'caption', text: caption }));
    return;
  }

  // Use the table's cell grid, not child indexes: merged cells occupy real columns.
  const grid = rows.map(() => []);
  const tableWordOffsets = new Map();
  let tableWordOffset = countSpokenWords(getTableCellText(captionElement));
  for (const element of table.querySelectorAll(TABLE_CELL_SELECTOR)) {
    if (element.closest(TABLE_SELECTOR) !== table || !shouldConsiderElement(element)) continue;
    tableWordOffsets.set(element, tableWordOffset);
    tableWordOffset += countSpokenWords(getTableCellText(element));
  }
  rows.forEach((row, rowIndex) => {
    let column = 0, domStart = 0;
    row.elements.forEach((element, cellIndex) => {
      const explicitColumn = Number(element.getAttribute('aria-colindex') || (cellIndex === 0 && row.element.getAttribute('aria-colindex')));
      if (Number.isInteger(explicitColumn) && explicitColumn > 0 && explicitColumn <= 1000) column = explicitColumn - 1;
      while (grid[rowIndex][column]) column += 1;
      const columnSpan = Math.min(1000, Math.max(1, Math.trunc(Number(element.getAttribute('colspan') || element.getAttribute('aria-colspan'))) || 1));
      const rawRowSpan = element.getAttribute('rowspan') ?? element.getAttribute('aria-rowspan');
      const groupEnd = rows.findIndex((candidate, index) => index > rowIndex && candidate.element.parentElement !== row.element.parentElement);
      const remainingRows = (groupEnd < 0 ? rows.length : groupEnd) - rowIndex;
      const rowSpan = rawRowSpan === '0' ? remainingRows : Math.min(remainingRows, Math.max(1, Math.trunc(Number(rawRowSpan)) || 1));
      const text = row.cells[cellIndex];
      const cell = { text, rowIndex, domStart, tableDomStart: tableWordOffsets.get(element) };
      domStart += countSpokenWords(text);
      for (let y = rowIndex; y < rowIndex + rowSpan; y += 1) {
        for (let x = column; x < column + columnSpan; x += 1) grid[y][x] = cell;
      }
      column += columnSpan;
    });
  });
  const columnCount = Math.max(...grid.map((row) => row.length));
  const columnHeaders = Array.from({ length: columnCount }, (_, column) => (
    [...new Set(grid.slice(0, headerRowCount).map((row) => row[column]))]
      .filter((cell) => cell?.text).map((cell) => ({ text: cell.text, domStart: cell.tableDomStart }))
  ));
  const columns = columnHeaders.map((cells) => cells.map((cell) => cell.text).join(', '));
  const dataRows = rows.slice(headerRowCount).map((row, index) => {
    const rowIndex = index + headerRowCount;
    const seenCells = new Set();
    const cells = grid[rowIndex].map((cell) => {
      if (!cell || seenCells.has(cell)) return '';
      seenCells.add(cell);
      return cell.text;
    });
    anchorElement(row.element, { type: 'table-row' });
    return { ...row, cells, anchorText: row.cells.filter(Boolean).join(' '),
      wordOffsets: grid[rowIndex].map((cell) => cell?.rowIndex === rowIndex ? cell.domStart : -1) };
  });
  chunks.push(anchorElement(table, {
    type: 'table',
    caption,
    captionDomStart: captionElement ? 0 : -1,
    columns,
    columnHeaders,
    rows: dataRows,
  }));
}

function getTableCellText(cell) {
  const text = getReadableText(cell);
  return isSpeakableSourceText(text) ? text : '';
}

function appendForm(chunks, seen, form, anchorElement) {
  const fields = [...form.querySelectorAll('input, select, textarea')]
    .filter(shouldConsiderElement)
    .map((field) => ({ element: field, text: getFieldLabel(field) }))
    .filter((field) => field.text);

  for (const { element, text } of fields) {
    const label = element.labels?.[0];
    const anchor = label && getReadableText(label) === text ? label : element;
    pushUnique(chunks, seen, anchorElement(anchor, { type: 'form-field', text }));
  }

  for (const button of form.querySelectorAll('button, input[type="button"], input[type="submit"]')) {
    if (shouldConsiderElement(button)) appendButton(chunks, seen, button, anchorElement);
  }
}

function appendButton(chunks, seen, button, anchorElement) {
  const { text } = getControlLabel(button, [
    button.getAttribute('aria-label'),
    button.getAttribute('title'),
    button.value,
    getReadableText(button),
  ]);
  if (!isSpeakableSourceText(text)) return;
  if (isIconOnlyControl(button) && isShareWidgetLabel(text)) return;
  pushUnique(chunks, seen, anchorElement(button, { type: 'button', text }));
}

function appendStandaloneLink(chunks, seen, link, anchorElement) {
  if (link.closest('p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6')) return;
  const { text } = getControlLabel(link, [
    link.getAttribute('aria-label'),
    getReadableText(link),
  ]);
  if (!isSpeakableSourceText(text)) return;
  if (isIconOnlyControl(link) && isShareWidgetLabel(text)) return;
  pushUnique(chunks, seen, anchorElement(link, { type: 'link', text }));
}

function getControlLabel(element, sources) {
  for (const source of sources) {
    const text = normalizeText(source);
    if (text) return { element, text };
  }
  return { element, text: '' };
}

function isIconOnlyControl(element) {
  const readableText = getReadableText(element);
  if (readableText) return readableText.length <= 2;
  const elementChildren = [...(element?.children || [])];
  if (!elementChildren.length) return true;
  return elementChildren.every((child) => (
    isTextlessIconElement(child)
    || child.getAttribute?.('aria-hidden') === 'true'
    || isIconOnlyControl(child)
  ));
}

function getFieldLabel(field) {
  const aria = normalizeText(field.getAttribute('aria-label'));
  if (aria) return aria;

  const labelledBy = field.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => getReadableText(field.ownerDocument.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    if (label) return label;
  }

  if (field.id) {
    const label = field.ownerDocument.querySelector(`label[for="${cssEscape(field.id)}"]`);
    const labelText = getReadableText(label);
    if (labelText) return labelText;
  }

  const wrappingLabel = field.closest('label');
  const wrappingText = getReadableText(wrappingLabel);
  if (wrappingText) return wrappingText;

  return normalizeText(field.getAttribute('placeholder') || field.getAttribute('name'));
}

function shouldConsiderElement(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.closest(NOISE_SELECTOR)) return false;
  if (isNavigationHeadingElement(element)) return false;
  if (isReferenceTextElement(element)) return false;
  if (hasHiddenTextAncestor(element, element.ownerDocument.documentElement)) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

  const win = element.ownerDocument.defaultView;
  if (win && !/jsdom/i.test(win.navigator?.userAgent || '')) {
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width <= 0 && rect.height <= 0) return false;
  }

  return true;
}

function hasReadableAncestor(element) {
  // Figure controls are separate from its prose and captions.
  if (element.matches('button, a[href]') && element.closest('figure')) return true;
  const parent = element.parentElement?.closest(READABLE_SELECTOR);
  if (!parent) return false;
  if (element.matches('code') && parent.matches('pre')) return true;
  if (element.matches('code') && parent.matches(`a[href], button, ${HEADING_SELECTOR}`)) return true;
  if (element.matches('button') && parent.matches('form')) return false;
  if (element.matches('li') && parent.matches('ul, ol')) return true;
  if (element.matches('dt, dd') && parent.matches('dl')) return true;
  if (element.matches('a[href]') && parent.matches(`p, li, dt, dd, blockquote, figcaption, button, ${HEADING_SELECTOR}`)) return true;
  if (parent.matches('a[href]') && element.matches(`p, blockquote, [role="paragraph"], ${HEADING_SELECTOR}`)) {
    const enclosingBlock = parent.closest('p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6');
    if (!enclosingBlock && parent.closest('figure')) return false;
    const { text } = getControlLabel(parent, [parent.getAttribute('aria-label'), getReadableText(parent)]);
    if (enclosingBlock || text.includes(getReadableText(element))) return true;
  }
  return parent.matches(`figcaption, form, ul, ol, dl, p, blockquote, pre, [role="list"], [role="paragraph"], ${TABLE_SELECTOR}`);
}

function pushUnique(chunks, seen, chunk, options = {}) {
  const text = options.preserveCode ? normalizeCodeText(chunk.text) : normalizeText(chunk.text);
  if (!isSpeakableSourceText(text)) return;
  const key = textKey(text);
  if (!options.allowDuplicate && seen.has(key)) return;
  seen.add(key);
  chunks.push({ ...chunk, text });
}

function renderChunk(chunk, { interactiveMode = false } = {}) {
  const create = (speech, anchorText = chunk.text ?? null, type = chunk.type, speechPrefixWords = getSpeechPrefixWords(chunk)) => ({
    type,
    speech,
    text: speech,
    anchorText,
    anchorId: chunk.anchorId,
    speechPrefixWords,
  });

  switch (chunk.type) {
    case 'chat-role':
      // No page text to match (chat apps hide their own labels off-screen), so the highlight
      // outlines the whole turn while the label is spoken.
      return { ...create(chunk.text, null, chunk.type, 0), chunkText: '' };
    case 'page-title':
      return create(withPeriod(chunk.text), chunk.anchorId ? chunk.text : null, chunk.type, 0);
    case 'heading':
      return create(withColon(chunk.text), chunk.text, chunk.type, 0);
    case 'quote':
      return create(`"${withPeriod(chunk.text)}"`, chunk.text, chunk.type, 0);
    case 'list':
      return renderList(chunk, create);
    case 'list-item':
      return create(withPeriod(chunk.text), chunk.text, chunk.type, 0);
    case 'link':
      return create(`${interactiveMode ? 'Link: ' : ''}${withPeriod(chunk.text)}`, chunk.text, chunk.type, interactiveMode ? 1 : 0);
    case 'button':
      return create(`${interactiveMode ? 'Button: ' : ''}${withPeriod(chunk.text)}`, chunk.text, chunk.type, interactiveMode ? 1 : 0);
    case 'image':
      return create(withPeriod(chunk.text), chunk.text, chunk.type, 0);
    case 'caption':
      return create(withPeriod(chunk.text), chunk.text, chunk.type, 0);
    case 'code':
      return create(normalizeCodeText(chunk.text), normalizeCodeText(chunk.text), chunk.type, 0);
    case 'table':
      return renderTable(chunk);
    case 'form-field':
      return create(`${interactiveMode ? 'Form field: ' : ''}${withPeriod(chunk.text)}`, chunk.text, chunk.type, interactiveMode ? 2 : 0);
    default:
      return create(withPeriod(chunk.text));
  }
}

function renderList(chunk, create) {
  const items = Array.isArray(chunk.items)
    ? chunk.items.map((item) => normalizeText(item)).filter(Boolean)
    : normalizeText(chunk.text).split(/\s*[\n;]\s*/).filter(Boolean);
  if (!items.length) return null;

  const count = Math.max(1, Math.trunc(Number(chunk.itemCount ?? chunk.count ?? items.length)) || items.length);
  const itemSpeech = items.map(stripTerminalPunctuation).join(', ');
  const speech = `List of ${count} ${count === 1 ? 'item' : 'items'}: ${withPeriod(itemSpeech)}`;
  return create(speech, items.join(' '), 'list', 4);
}

function renderTable(chunk) {
  const parts = [];
  const columns = chunk.columns || [];
  const captionWords = countSpokenWords(chunk.caption);
  // Spoken table text adds words the page doesn't have ("Table:", "2 columns:", "and", repeated
  // headers), so each chunk carries a speech-word -> element-word map for word highlighting.
  const headerParts = [
    { text: chunk.caption ? 'Table:' : 'Table.' },
    ...(chunk.caption ? [{ text: `${chunk.caption}.`, domStart: chunk.captionDomStart === -1 ? undefined : 0 }] : []),
  ];
  if (columns.some(Boolean)) {
    headerParts.push({ text: `${columns.length} columns:` });
    let domStart = captionWords;
    const headers = (chunk.columnHeaders || columns.map((text) => [{ text }])).filter((cells) => cells.length);
    headers.forEach((cells, index) => {
      if (index > 0 && index === headers.length - 1) headerParts.push({ text: 'and' });
      const separator = index === headers.length - 1 ? '.' : headers.length > 2 ? ',' : '';
      cells.forEach((cell, cellIndex) => {
        headerParts.push({ text: `${cell.text}${cellIndex === cells.length - 1 ? separator : ','}`, domStart: cell.domStart ?? domStart });
        domStart += countSpokenWords(cell.text);
      });
    });
  }
  const header = createMappedSpeech(headerParts);
  parts.push({
    type: 'table',
    speech: header.speech,
    text: header.speech,
    anchorText: [chunk.caption, ...columns].filter(Boolean).join(' ') || null,
    anchorId: chunk.anchorId,
    speechPrefixWords: 0,
    speechWordMap: header.speechWordMap,
  });

  chunk.rows.forEach((row) => {
    const rowParts = [];
    let domStart = 0;
    row.cells.forEach((cell, cellIndex) => {
      const cellWords = countSpokenWords(cell);
      if (cell) {
        const headerName = columns[cellIndex];
        if (rowParts.length) rowParts.push({ text: '-' });
        if (headerName) rowParts.push({ text: `${headerName},` });
        const offset = row.wordOffsets?.[cellIndex] ?? domStart;
        rowParts.push({ text: cell, domStart: offset < 0 ? undefined : offset });
      }
      domStart += cellWords;
    });
    if (rowParts.length) {
      rowParts[rowParts.length - 1] = { ...rowParts.at(-1), text: `${rowParts.at(-1).text}.` };
      const mapped = createMappedSpeech(rowParts);
      parts.push({
        type: 'table-row',
        speech: mapped.speech,
        text: mapped.speech,
        anchorText: row.anchorText ?? (row.cells.filter(Boolean).join(' ') || null),
        anchorId: row.element?.dataset?.[ANCHOR_ID_ATTRIBUTE],
        parentAnchorId: chunk.anchorId,
        speechPrefixWords: 0,
        speechWordMap: mapped.speechWordMap,
      });
    }
  });

  return parts;
}

function countSpokenWords(text) {
  return tokenizeSpokenWords(text).length;
}

/**
 * Joins spoken parts and maps every spoken word to its element word index, or -1 for words
 * that only exist in speech. Parts with `domStart` are page text starting at that word.
 * @param {Array<{ text: string, domStart?: number }>} parts
 */
function createMappedSpeech(parts) {
  const spans = [];
  let speech = '';
  for (const part of parts) {
    if (speech) speech += ' ';
    spans.push({ ...part, start: speech.length, end: speech.length + part.text.length, seen: 0 });
    speech += part.text;
  }

  const speechWordMap = tokenizeSpokenWords(speech).map((token) => {
    const span = spans.find((candidate) => token.start >= candidate.start && token.start < candidate.end);
    if (!span || !Number.isInteger(span.domStart)) return -1;
    const index = span.domStart + span.seen;
    span.seen += 1;
    return index;
  });
  return { speech, speechWordMap };
}

function getSpeechPrefixWords(chunk) {
  if (Number.isFinite(chunk?.speechPrefixWords)) return Math.max(0, Math.trunc(chunk.speechPrefixWords));
  return 0;
}

function getDomWordOffset(chunk) {
  if (!Number.isFinite(chunk?.domWordOffset)) return 0;
  return Math.max(0, Math.trunc(chunk.domWordOffset));
}

function getGlobalDomWordStartIndex(chunk) {
  if (Number.isFinite(chunk?.globalDomWordStartIndex)) {
    return Math.max(0, Math.trunc(chunk.globalDomWordStartIndex));
  }
  return getDomWordOffset(chunk);
}

function withGlobalDomWordStartIndex(chunk) {
  if (!chunk || typeof chunk === 'string') return chunk;
  return {
    ...chunk,
    globalDomWordStartIndex: getGlobalDomWordStartIndex(chunk),
  };
}

function normalizeText(value) {
  return stripPrivateUseCharacters(String(value || ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:!?]|\.(?![\p{L}\p{N}]))/gu, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .trim();
}

function getReadableText(element) {
  if (!element) return '';
  return normalizeText(readNodeText(element, element));
}

function getCodeText(element) {
  if (!element) return '';
  return normalizeCodeText(element.textContent);
}

function readNodeText(node, root) {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  if (node !== root && isTextlessIconElement(node)) return '';
  if (node !== root && isReferenceTextElement(node)) return '';
  if (node !== root && hasHiddenTextAncestor(node, root)) return '';
  if (node !== root && isMathContainer(node)) return extractMathText(node, root);
  if (node.matches('br')) return ' ';
  const text = [...node.childNodes].map((child) => readNodeText(child, root)).join('');
  return node !== root && node.matches('div, p, li, dt, dd, tr, th, td, ul, ol, dl, blockquote') ? ` ${text} ` : text;
}

function extractMathText(element, root) {
  const variants = [];
  for (const child of element.children) {
    if (hasHiddenTextAncestor(child, root)) continue;
    const text = normalizeText([...child.childNodes].map((node) => readNodeText(node, child)).join(''));
    if (text) variants.push(text);
  }

  if (!variants.length) {
    return normalizeText([...element.childNodes].map((node) => {
      if (node.nodeType === 1 && hasHiddenTextAncestor(node, root)) return '';
      return node.nodeType === 3 ? node.nodeValue || '' : [...node.childNodes].map((child) => readNodeText(child, node)).join('');
    }).join(''));
  }

  return chooseMathVariant(variants);
}

function chooseMathVariant(variants) {
  const seen = new Set();
  const unique = variants.filter((variant) => {
    const key = mathKey(variant);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const withoutBraces = unique.find((variant) => !/^\{.*\}$/.test(variant));
  return withoutBraces || unique[0] || '';
}

function mathKey(value) {
  return normalizeText(value)
    .replace(/^\{(.+)\}$/, '$1')
    .replaceAll('\\cdot', '⋅')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isMathContainer(element) {
  return element.matches?.(MATH_CONTAINER_SELECTOR);
}

function hasHiddenTextAncestor(element, root) {
  for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
    if (node.matches?.(HIDDEN_TEXT_SELECTOR)) return true;
    if (node !== root && (isReferenceTextElement(node) || isNavigationHeadingElement(node))) return true;

    if (node.style?.display === 'none' || node.style?.visibility === 'hidden'
      || Number.parseFloat(node.style?.opacity || '') === 0) return true;
  }

  return false;
}

function withPeriod(text) {
  const value = normalizeText(text);
  if (!value) return '';
  return /[\p{Sentence_Terminal}:;：；]["'\p{Pe}\p{Pf}]*$/u.test(value) ? value : `${value}.`;
}

function withColon(text) {
  const value = normalizeText(text);
  if (!value) return '';
  return /[:;]$/.test(value) ? value : `${stripTerminalPunctuation(value)}:`;
}

function stripTerminalPunctuation(text) {
  return normalizeText(text).replace(/[.!?;:]+$/u, '');
}

function textKey(text) {
  return normalizeText(text).toLowerCase();
}

function shouldUseInteractiveLabels(chunks = []) {
  const articleTypes = new Set(['heading', 'paragraph', 'quote', 'list', 'list-item', 'image', 'caption', 'table']);
  const controlTypes = new Set(['link', 'button', 'form-field']);
  const meaningful = chunks.filter((chunk) => chunk?.type && chunk.type !== 'page-title');
  return meaningful.length > 0 && meaningful.every((chunk) => controlTypes.has(chunk.type)) && !meaningful.some((chunk) => articleTypes.has(chunk.type));
}

function isUsefulImageAlt(text, image) {
  const value = normalizeText(text);
  if (!value || value.length < 4) return false;
  if (/^(image|photo|picture|graphic|decorative|loading|untitled)$/i.test(value)) return false;
  if (/^[\w-]+\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i.test(value)) return false;
  if (/^[\da-f]{6,}$/i.test(value) || /^https?:\/\//i.test(value)) return false;
  if (value.length > 240) return false;
  if (!/\s/.test(value) && value.length < 16) return false;

  const adjacent = normalizeText(image?.parentElement?.textContent).toLowerCase();
  if (adjacent && adjacent.includes(value.toLowerCase())) return false;

  return true;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function getInitialAnchorCounter(document) {
  return [...document.querySelectorAll('[data-pagenarrator-id]')]
    .map((element) => Number.parseInt(element.dataset.pagenarratorId, 10))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
}

function cleanRenderedChunks(chunks) {
  return chunks
    .map(sanitizeRenderedChunk)
    .filter(isSpeakableRenderedChunk);
}

function sanitizeRenderedChunk(chunk) {
  if (!chunk) return null;
  return {
    ...chunk,
    speech: stripPrivateUseCharacters(chunk.speech),
    text: stripPrivateUseCharacters(chunk.text),
    anchorText: chunk.anchorText == null ? chunk.anchorText : stripPrivateUseCharacters(chunk.anchorText),
  };
}

function isSpeakableRenderedChunk(chunk) {
  const speech = String(chunk?.speech || '').trim();
  return isSpeakableSourceText(speech);
}

function createLazyChunkArray(factory) {
  const target = [];
  let materialized = false;

  const materialize = () => {
    if (!materialized) {
      const chunks = factory() || [];
      target.push(...chunks);
      materialized = true;
    }
    return target;
  };

  const iterator = function* () {
    yield* materialize();
  };

  return new Proxy(target, {
    get(targetArray, prop, receiver) {
      if (prop === Symbol.iterator) return iterator;
      if (prop === 'length') return materialize().length;
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return materialize()[prop];
      if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
        return Array.prototype[prop].bind(materialize());
      }

      const value = Reflect.get(targetArray, prop, receiver);
      if (typeof value === 'function') return value.bind(materialize());
      return value;
    },
    has(targetArray, prop) {
      if (prop === Symbol.iterator) return true;
      if (prop === 'length' || (typeof prop === 'string' && /^\d+$/.test(prop))) {
        materialize();
      }
      return Reflect.has(targetArray, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(materialize());
    },
    getOwnPropertyDescriptor(targetArray, prop) {
      if (prop === Symbol.iterator) {
        return {
          configurable: true,
          enumerable: false,
          writable: false,
          value: iterator,
        };
      }
      materialize();
      return Reflect.getOwnPropertyDescriptor(targetArray, prop);
    },
    set(targetArray, prop, value, receiver) {
      materialize();
      return Reflect.set(targetArray, prop, value, receiver);
    },
  });
}
