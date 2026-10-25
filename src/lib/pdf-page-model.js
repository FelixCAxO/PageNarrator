// @ts-check
import { isNumericMatrix, isNumericMatrixValue, numericMatrixLabel } from './numeric-matrix.js';
import { getVerticalPdfRegions, isVerticalPdfItem, joinVerticalText } from './pdf-vertical-model.js';
import { pdfNarrationSource } from '../pdf/symbol-fonts.js';

const RTL_LETTER_SHARE_THRESHOLD = 0.3;
const LIST_PREFIX = /^(?:[•◦▪‣*-]|\d{1,3}[.)]|[a-z][.)])\s+/iu;
const BULLET_PREFIX = /^(?:[•◦▪‣*-])\s+/iu;
const CAPTION_PREFIX = /^(?:fig(?:ure)?\.?|table)\s*\d+[.:]?\s*/iu;
const NUMERIC_CITATION = /\s*\[\s*\d+[a-z]?(?:\s*(?:,|[-–])\s*\d+[a-z]?)*\s*\]/giu;
const YEAR_CITATION = /\s*[\[(][^()[\]]*(?:[\p{Lu}][\p{L}'’.-]+\s+et al\.,?|[\p{Lu}][\p{L}'’.-]+\s+and\s+[\p{Lu}][\p{L}'’.-]+,?|[\p{Lu}][\p{L}'’.-]+,)\s+(?:19|20)\d{2}[a-z]?[^()[\]]*[\])]/gu;
const BARE_AUTHOR_YEAR_CITATION = /\s*\b(?:[\p{Lu}][\p{L}'’.-]+\s+et al\.,?|[\p{Lu}][\p{L}'’.-]+\s+and\s+[\p{Lu}][\p{L}'’.-]+,?|[\p{Lu}][\p{L}'’.-]+,)\s+(?:19|20)\d{2}[a-z]?\b/gu;
const MONTH_YEAR = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:19|20)\d{2}\b/iu;
const DECORATIVE_ONLY = /^[\s\u2020\u2021\u25c6\u25c7\u2756\ue000-\uf8ff]+$/u;
const PUBLICATION_METADATA = /^(?:[*†‡∗]+\s*|\d+\s+)?(?:preprint\b|submitted to\b|(?:©\s*)?copyright\b|authors?['’]? contact information\b|corresponding author\b|e-?mail address\b|(?:this work|this article|the content) is licensed under\b|work (?:done|primarily completed) during (?:an )?internship\b|(?:(?:our|the)\s+)?(?:code(?:\s+and\s+data)?|data\s+and\s+code)\s+(?:are|is)\s+available\b|we release (?:our\s+)?(?:code and data|data and code)\b|(?:the\s+)?dataset is available\b|indicates the corresponding author\b|repository upon acceptance\b)/iu;
const PAGE_EDGE_FURNITURE = /^(?:(?:recurring|running|report|confidential|technical|draft)\s+(?:draft\s+)?(?:report\s+)?(?:header|footer|title)|(?:header|footer)\b|(?:draft|confidential)\s+(?:copy|manuscript|report|header)\b|arxiv:)/iu;
const CONTACT_FURNITURE = /^(?:(?:phone|telephone|tel\.?|fax)\s*:?\s*\+?\(?\d{2,}|(?:website|web)\s*:?\s*(?:https?:\/\/|www\.)|e-?mail\s*:?\s*[\p{L}\p{N}._%+-]+@)/iu;
const URL_TOKEN = /\b(?:https?:\/\/|www\.|github\.com\/|kaggle\.com\/)[^\s<>{}\[\]]+/giu;
const EMAIL_TOKEN = /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/giu;
const ORCID_TOKEN = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/giu;
const COPYRIGHT_NOTICE = /^©\s*(?:\p{L}[\p{L} ()'’.,&-]*\s+)?(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\.?(?:\s+All rights reserved\.?)?$/iu;
const ADDITIONAL_METADATA = /^[*∗]?\s*(?:contact emails?\b|equal contribution\b|these authors contributed equally\b)/iu;
const AUTHOR_PARENTHETICAL_YEAR_CITATION = /\s*\b[\p{Lu}][\p{L}\p{N}'’.-]+\s+et al\.\s*\((?:19|20)\d{2}[a-z]?\)/gu;

export function createPdfPageModel(items = [], {
  pageView = [0, 0, 612, 792],
  direction = '',
  pageRotation = 0,
} = {}) {
  const rotation = ((Number(pageRotation) || 0) % 360 + 360) % 360;
  if (rotation === 90 || rotation === 180 || rotation === 270) {
    const [left, bottom, right, top] = pageView;
    const width = right - left, height = top - bottom;
    // Normalize intrinsic page rotation before classifying sideways text and columns.
    items = items.map(item => {
      if (!Array.isArray(item.transform) || item.transform.length < 6) return item;
      const [a, b, c, d, e, f] = item.transform;
      const x = e - left, y = f - bottom;
      const transform = rotation === 90 ? [b, -a, d, -c, y, width - x]
        : rotation === 180 ? [-a, -b, -c, -d, width - x, height - y]
          : [-b, a, -d, c, height - y, x];
      return { ...item, transform };
    });
    pageView = rotation === 180 ? [0, 0, width, height] : [0, 0, height, width];
  }
  const rawPositioned = getPositionedTextItems(items);
  if (!rawPositioned.length) return { lines: [], orderedItems: [], anchorText: '', speech: '', pageView };

  const verticalItems = rawPositioned.filter(isVerticalPdfItem);
  if (verticalItems.length) {
    // Preserve the horizontal classifier and source indices on mixed pages.
    const horizontal = createPdfPageModel(items.map(item => isVerticalPdfItem(item) ? { ...item, str: '' } : item), { pageView, direction });
    const regions = getVerticalPdfRegions(verticalItems), lines = [];
    for (const line of horizontal.lines) {
      while (regions.length && regions[0].top > line.y) lines.push(...regions.shift().lines);
      lines.push(line);
    }
    for (const region of regions) lines.push(...region.lines);
    return { lines, pageView, orderedItems: lines.flatMap(line => line.parts), ...renderPdfPageModel(lines, { pageView }) };
  }

  if (rawPositioned.every((item) => Number.isInteger(item.ocrLine))) {
    // OCR boxes bound visible ink; subscripts can lower a box's bottom without
    // moving its text row. Native PDF text continues to use font baselines.
    const geometryRows = clusterRows(rawPositioned, Math.max(2, median(rawPositioned.map((part) => part.height)) * 0.55),
      part => part.y + part.height / 2);
    markNumericMatrices(geometryRows);
    const tableRows = getTableRows(geometryRows);
    const tableGroups = new Map();
    const tableByItem = new Map();
    for (const row of tableRows) {
      if (!tableGroups.has(row.tableId)) tableGroups.set(row.tableId, []);
      tableGroups.get(row.tableId).push(formatRow(row, { role: 'table-row', direction }));
      for (const part of row.parts) tableByItem.set(part.originalIndex, row.tableId);
    }
    // ponytail: preserve OCR segmentation; native glyph clustering mixes scanned columns.
    const rows = new Map();
    for (const item of rawPositioned) {
      if (!rows.has(item.ocrLine)) rows.set(item.ocrLine, { y: item.y, parts: [] });
      rows.get(item.ocrLine).parts.push(item);
    }
    const emittedTables = new Set();
    const lines = orderMatrixNarrative([...rows.values()].flatMap((row) => {
      const result = [];
      for (const part of row.parts) {
        const id = tableByItem.get(part.originalIndex);
        if (id !== undefined && !emittedTables.has(id)) {
          result.push(...tableGroups.get(id));
          emittedTables.add(id);
        }
      }
      const parts = row.parts.filter((part) => !tableByItem.has(part.originalIndex));
      if (parts.length) result.push(formatRow({ ...row, parts,
        left: Math.min(...parts.map((part) => part.x)),
        right: Math.max(...parts.map((part) => part.x + part.width)),
      }, { direction }));
      return result;
    }), pageView);
    return { lines, pageView, orderedItems: lines.flatMap((line) => line.parts),
      ...renderPdfPageModel(lines, { pageView }) };
  }

  const typicalHeight = median(rawPositioned.map((item) => item.height));
  const positioned = alignRaisedInlineItems(normalizeSymbolBullets(rawPositioned), typicalHeight);
  const yTolerance = Math.max(2, typicalHeight * 0.55);
  const rows = attachDropCaps(clusterRows(positioned, yTolerance), typicalHeight);
  markInlineCodeRows(rows);
  markNumericMatrices(rows);
  const pageWidth = Math.abs((pageView?.[2] ?? 612) - (pageView?.[0] ?? 0)) || 612;
  const pageTop = Math.max(pageView?.[1] ?? 0, pageView?.[3] ?? 792);
  const abstractRow = rows.filter(rowContainsAbstractHeading)
    .sort((a, b) => b.y - a.y)[0];
  const bodyColumnTop = abstractRow ? abstractRow.y + yTolerance : pageTop;
  const tableRows = getTableRows(rows);
  const columnRows = rows.filter((row) => row.y <= bodyColumnTop && !tableRows.has(row) && !row.tableContinuation && !row.inlineCode);
  const bodyColumnStarts = detectBodyColumnStarts(columnRows, pageWidth);
  const sideNoteGutter = findSideNoteGutter(rows.filter((row) => !tableRows.has(row) && !row.inlineCode), pageWidth);
  const pageRtl = direction === 'rtl'
    || (direction !== 'ltr' && rows.length > 0 && rows.every((row) => isRtlLine(row.parts)));
  let visualLines = rows.filter((row) => !row.tableContinuation).flatMap((row) => (
    tableRows.has(row)
      ? [formatRow(row, { role: 'table-row', direction })]
      : splitSideNote(row, sideNoteGutter).flatMap(({ row: part, sideNote }) => splitRow(part, {
        direction,
        pageRtl,
        bodyColumnStarts: row.y <= bodyColumnTop ? bodyColumnStarts : [],
        columnRows,
        preserveCompactFragments: positioned.length <= 5,
      }).map((line) => (sideNote ? { ...line, sideNote } : line)))
  ));
  const localTableRows = getTableRows(visualLines.filter((line) => line.role !== 'table-row'));
  for (const line of localTableRows) Object.assign(line, { role: 'table-row', localTable: true });
  visualLines = visualLines.filter((line) => !line.tableContinuation);
  const classified = markSideNoteGlosses(classifyFootnoteRegions(
    classifyTopMatter(classifyFigureRegions(classifyLines(visualLines, { pageView })), pageView),
    pageView,
  ));
  // Side notes are read after the text block they annotate, never mid-sentence.
  const ordered = [
    ...orderLines(classified.filter((line) => !line.sideNote), {
      direction,
      pageRtl,
      yTolerance,
      bodyColumnStarts,
    }),
    ...classified.filter((line) => line.sideNote).sort((a, b) => b.y - a.y)
      .map((line) => formatRow(line, { role: line.role, direction })),
  ];
  const observedWords = getObservedWords(ordered);
  const lines = orderMatrixNarrative(mergeListContinuations(ordered, observedWords), pageView);
  const rendered = renderPdfPageModel(lines, { pageView, observedWords });

  return {
    lines,
    pageView,
    orderedItems: lines.flatMap((line) => line.parts),
    ...rendered,
  };
}

export function renderPdfPageModel(lines = [], {
  pageView = [0, 0, 612, 792], observedWords = getObservedWords(lines),
} = {}) {
  const visibleLines = lines.filter((line) => !isImmediatePdfFurniture(line, pageView))
    .map((line) => {
      const narrationSourceText = getMeaningfulLineSource(line);
      return {
        ...line,
        rawText: line.text || joinParts(line.parts),
        narrationSourceText,
        text: getMeaningfulLineText(line, pageView, narrationSourceText, observedWords),
      };
    });
  const renderedLines = visibleLines.filter((line) => line.text);
  const speechLines = prepareSpeechLines(renderedLines, pageView, observedWords);
  const anchorText = visibleLines.map((line) => line.rawText).filter(Boolean).join('\n\n');
  const speechParts = [];

  for (let index = 0; index < speechLines.length;) {
    const line = speechLines[index];
    if (line.role === 'list-item') {
      const items = [];
      while (index < speechLines.length && speechLines[index].role === 'list-item') {
        items.push(stripListPrefix(speechLines[index].text));
        index += 1;
      }
      speechParts.push(`${items.map(stripTerminalPunctuation).join('; ')}.`);
      continue;
    }

    if (line.role === 'title') {
      const titleLines = [line.text];
      index += 1;
      while (index < speechLines.length && speechLines[index].role === 'title') {
        titleLines.push(speechLines[index].text);
        index += 1;
      }
      speechParts.push(withTerminal(titleLines.join(' '), ':'));
      continue;
    }

    let narrationSourceText = line.narrationSourceText;
    while (index + 1 < speechLines.length
      && canJoinWrappedLine(speechLines[index], speechLines[index + 1])) {
      narrationSourceText = joinWrappedText(narrationSourceText, {
        ...speechLines[index + 1],
        text: speechLines[index + 1].narrationSourceText,
      }, speechLines[index], observedWords);
      index += 1;
    }
    // Each physical line already passed metadata filtering with its own geometry.
    // A wrapped paragraph must not inherit only the first line's font height.
    const text = formatNarrationText(stripMetadataFragments(stripCitationMarkers(narrationSourceText)), observedWords);
    speechParts.push(withTerminal(text, '.'));
    index += 1;
  }

  return {
    anchorText,
    narratedOriginalIndices: speechLines.flatMap(line => line.parts.filter(part => !part.numericMatrix).map(part => part.originalIndex)),
    speech: speechParts.join(' ').replace(/\s+/gu, ' ').trim(),
  };
}

function prepareSpeechLines(lines, pageView, observedWords) {
  const continuationsByRegion = new Map();
  for (const line of lines) {
    if (!line.captionContinuationOf) continue;
    const continuations = continuationsByRegion.get(line.captionContinuationOf) || [];
    continuations.push(line);
    continuationsByRegion.set(line.captionContinuationOf, continuations);
  }

  const merged = lines.filter((line) => !line.captionContinuationOf).map((line) => {
    if (!line.captionRegionId) return { ...line };
    const continuations = (continuationsByRegion.get(line.captionRegionId) || [])
      .sort((a, b) => b.y - a.y);
    let narrationSourceText = line.narrationSourceText;
    let current = line;
    for (const continuation of continuations) {
      narrationSourceText = joinWrappedText(narrationSourceText, {
        ...continuation,
        text: continuation.narrationSourceText,
      }, current, observedWords);
      current = continuation;
    }
    return {
      ...line,
      parts: [line, ...continuations].flatMap((candidate) => candidate.parts || []),
      narrationSourceText,
      text: formatNarrationText(stripMetadataFragments(stripCitationMarkers(narrationSourceText)), observedWords),
      captionBottomY: current.y,
    };
  });

  return deferSpeechCaptions(merged);
}

function deferSpeechCaptions(lines) {
  const result = [...lines];
  for (let captionIndex = 0; captionIndex < result.length; captionIndex += 1) {
    if (result[captionIndex].role !== 'caption') continue;
    const previous = result[captionIndex - 1];
    const next = result[captionIndex + 1];
    const interrupted = previous?.role === 'paragraph'
      && next?.role === 'paragraph'
      && !/[.!?;:]$/u.test(previous.text)
      && (previous.text.endsWith('-') || /^[\p{Ll}(]/u.test(next.text));
    if (!interrupted) continue;
    const [caption] = result.splice(captionIndex, 1);
    let insertionIndex = captionIndex;
    next.crossColumnContinuation = true;
    while (insertionIndex < result.length - 1
      && !/[.!?;:]$/u.test(result[insertionIndex].text)
      && canJoinWrappedLine(result[insertionIndex], result[insertionIndex + 1])) {
      insertionIndex += 1;
    }
    result.splice(insertionIndex + 1, 0, caption);
    captionIndex = insertionIndex + 1;
  }
  return result;
}

export function isImmediatePdfFurniture(line, pageView = [0, 0, 612, 792]) {
  const band = getPageEdgeBand(line, pageView);
  if (!band) return false;
  const text = normalizeText(line?.text || joinParts(line?.parts || []));
  if (!text) return true;
  const pageNumberText = text.replace(/[.\-–—]/gu, '').trim();
  if (/^(?:page\s*)?(?:\d+|[ivxlcdm]+)$/iu.test(pageNumberText)) return true;
  const maximumHeight = Math.max(0, ...(line?.parts || []).map((part) => Number(part.height) || 0));
  return line?.role !== 'title'
    && maximumHeight <= 12
    && text.length <= 240
    && (PAGE_EDGE_FURNITURE.test(text) || PUBLICATION_METADATA.test(text)
      || (band === 'bottom' && line?.role !== 'table-row' && CONTACT_FURNITURE.test(text)));
}

function getPageEdgeBand(line, pageView) {
  const [, rawBottom = 0,, rawTop = 792] = Array.isArray(pageView) ? pageView : [];
  const bottom = Math.min(rawBottom, rawTop);
  const top = Math.max(rawBottom, rawTop);
  const bandHeight = Math.max(24, (top - bottom) * 0.05);
  const y = Number(line?.y);
  if (!Number.isFinite(y)) return '';
  if (y >= top - bandHeight) return 'top';
  if (y <= bottom + bandHeight) return 'bottom';
  return '';
}

function getMeaningfulLineSource(line) {
  if (line.speechText && !line.parts?.some((part) => part.numericMatrix)) return line.speechText;
  const parts = [...(line.parts || [])];
  const horizontalParts = [...parts].sort((a, b) => a.x - b.x);
  const maximumHeight = Math.max(0, ...parts.map((part) => Number(part.height) || 0));
  const meaningfulParts = parts.filter((part) => {
    if (part.numericMatrix) return false;
    const text = normalizeText(part.text ?? part.str);
    if (!text || DECORATIVE_ONLY.test(text)) return false;
    const horizontalIndex = horizontalParts.indexOf(part);
    if (!isSuperscriptCitation(part, horizontalParts, horizontalIndex, maximumHeight)) return true;
    if (isTerminalMathExponent(part, horizontalParts, horizontalIndex)) return true;
    return isEmbeddedWordGlyph(horizontalParts, horizontalIndex);
  });
  return joinParts(meaningfulParts);
}

function getMeaningfulLineText(line, pageView, sourceText = getMeaningfulLineSource(line), observedWords) {
  if (line.nonNarrativeRegion) return '';
  const cleaned = stripMetadataFragments(stripCitationMarkers(sourceText));
  if (isNonNarrativeMetadataLine(line, cleaned, pageView)) return '';
  return formatNarrationText(cleaned, observedWords);
}

function formatNarrationText(cleaned, observedWords) {
  return stripNarrationLinks(cleaned)
    .replace(/(\p{L}+)-\s+(\p{L}[\p{L}-]*)/gu, (match, left, right) => repairSpacedHyphen(match, left, right, observedWords))
    .replace(/^[\s⋄†‡⋆∗]+(?=\p{L})/u, '')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/(?<=\d)\.\s+(?=\d)/gu, '.')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripNarrationLinks(source) {
  const strip = text => text.replace(URL_TOKEN, ' ').replace(EMAIL_TOKEN, ' ').replace(ORCID_TOKEN, ' ');
  if (!/^[\p{L}_$][\p{L}\p{N}_$.]*(?:\(|\s*=(?!=))/u.test(source.trimStart())) return strip(source);
  let result = '', cursor = 0;
  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if ((quote !== "'" && quote !== '"') || source[index - 1] === '\\') continue;
    let end = index + 1;
    for (; end < source.length && source[end] !== quote && !/[\r\n]/u.test(source[end]); end += 1) {
      if (source[end] === '\\') end += 1;
    }
    let before = index - 1;
    while (before >= 0 && /\s/u.test(source[before])) before -= 1;
    if (source[end] === quote && /[=(,]/u.test(source[before] || '')
      && /^(?:https?:\/\/|www\.|github\.com\/|kaggle\.com\/)\S+$/iu.test(source.slice(index + 1, end))) {
      result += strip(source.slice(cursor, index)) + source.slice(index, end + 1);
      cursor = end + 1;
    }
    index = end;
  }
  return result + strip(source.slice(cursor));
}

function isNonNarrativeMetadataLine(line, text) {
  if (!text || PUBLICATION_METADATA.test(text) || ADDITIONAL_METADATA.test(text) || COPYRIGHT_NOTICE.test(text)) return true;
  const withoutLinks = text.replace(URL_TOKEN, '').replace(EMAIL_TOKEN, '').replace(ORCID_TOKEN, '')
    .replace(/[\s\d*.:,;()\-/]+/gu, '');
  if (!withoutLinks) return line.role !== 'table-row';
  const maximumHeight = Math.max(0, ...(line.parts || []).map((part) => Number(part.height) || 0));
  const affiliation = /^(?:\d+\s*)?(?:university|institute|laborator(?:y|ies)|school of|department of|mila|cifar ai chair)\b/iu.test(text)
    || /,\s*(?:university|institute|laborator(?:y|ies)|school of|department of)\b/iu.test(text)
    || /\b(?:are|is) with (?:the )?(?:university|institute|laborator(?:y|ies)|school of|department of)\b/iu.test(text);
  return maximumHeight <= 10 && affiliation;
}

function isSuperscriptCitation(part, parts, index, maximumHeight) {
  // OCR bounds describe warped ink, not font metrics; height cannot identify a citation.
  if (Number.isInteger(part.ocrLine)) return false;
  const text = normalizeText(part.text ?? part.str);
  if (!/^(?:\[?\d+(?:\s*[,–-]\s*\d+)*\]?|[†‡]+\d*)$/u.test(text)) return false;
  if (parts.length <= 1 || maximumHeight <= 0 || part.height > maximumHeight * 0.8) return false;
  let neighbor = null, nearest = Infinity;
  for (const [candidateIndex, candidate] of parts.entries()) {
    if (candidateIndex === index || candidate.height < part.height * 1.2
      || !/[\p{L}\p{N}]/u.test(candidate.text || candidate.str || '')) continue;
    const distance = Math.min(Math.abs(part.x - rightOf(candidate)), Math.abs(candidate.x - rightOf(part)));
    if (distance < nearest) { neighbor = candidate; nearest = distance; }
  }
  // Row alignment changes y; the rotation-normalized text transform retains the actual baseline.
  const baseline = item => Number(item.transform?.[5] ?? item.y);
  return neighbor !== null && baseline(part) > baseline(neighbor) + Math.max(0.5, neighbor.height * 0.1);
}

function isEmbeddedWordGlyph(parts, index) {
  const part = parts[index];
  const previous = parts[index - 1];
  const next = parts[index + 1];
  if (!previous || !next) return false;
  const previousToken = normalizeText(previous.text ?? previous.str).match(/[\p{L}\p{N}]+$/u)?.[0] || '';
  const nextToken = normalizeText(next.text ?? next.str).match(/^[\p{L}\p{N}]+/u)?.[0] || '';
  if (!previousToken || !nextToken || previousToken.length > 3 || nextToken.length > 3) return false;
  const threshold = Math.max(3, (Number(part.height) || 0) * 0.5);
  return part.x - rightOf(previous) <= threshold
    && next.x - rightOf(part) <= threshold
    && /[\p{L}\p{N}]$/u.test(previous.text || previous.str || '')
    && /^[\p{L}\p{N}]/u.test(next.text || next.str || '');
}

function isTerminalMathExponent(part, parts, index) {
  const previous = parts[index - 1];
  if (!previous || !/^\d$/u.test(normalizeText(part.text ?? part.str))) return false;
  const gap = part.x - rightOf(previous);
  if (gap < -1 || gap > Math.max(2, (Number(part.height) || 0) * 0.4)) return false;
  const previousText = normalizeText(previous.text ?? previous.str);
  const previousToken = previousText.match(/[\p{L}\p{N}]+$/u)?.[0] || '';
  return previousToken.length > 0 && (
    previousToken.length <= 3
    || /\b(?:acceleration|area|distance|energy|height|length|mass|norm|radius|speed|value|variable|variance|velocity|volume|width)\s*$/iu.test(previousText)
  );
}

function stripCitationMarkers(value) {
  return normalizeText(value)
    .replace(NUMERIC_CITATION, preserveMathBrackets)
    .replace(AUTHOR_PARENTHETICAL_YEAR_CITATION, ' ')
    .replace(YEAR_CITATION, preserveDateOrStripCitation)
    .replace(BARE_AUTHOR_YEAR_CITATION, preserveDateOrStripCitation)
    .replace(/(?:^|\s)[–—-]+(?=\s|$)/gu, ' ')
    .replace(/([,;:])(?:\s*\1)+/gu, '$1')
    .replace(/\s*§(?:\s*(?:[ivxlcdm]+|\d+(?:\.\d+)*)\b)?/giu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\(\s*(?:[;,]\s*)*\)|\[\s*\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function preserveDateOrStripCitation(match) {
  return MONTH_YEAR.test(match) ? match : ' ';
}

function stripMetadataFragments(value) {
  return String(value || '')
    .replace(/\bPublished as a paper at [^.]+\.?/giu, ' ')
    .replace(/\bAccepted as (?:an?\s+)?[^.]{0,80}\bPaper at [^.]+\.?/giu, ' ')
    .replace(/\b\d+(?:st|nd|rd|th) Conference on [^.]+\.?(?:\s+(?:Position Paper|Paper|Dataset|Benchmark) Track\.)?/giu, ' ')
    .replace(/\b(?:framework|source)?\s*code[^.]{0,180}\bwill be released[^.]{0,120}\brepository upon acceptance\.?/giu, ' ')
    .replace(/\bWork (?:done|primarily completed) during (?:an )?internship at [^.]+\.?/giu, ' ')
    .replace(/\b(?:anonymous:\s*)?preprint submitted to [^.]+/giu, ' ')
    .replace(/\*+\s*indicates the corresponding author\.?/giu, ' ')
    .replace(/[*†‡∗]+\s*Corresponding author\b.*$/giu, ' ')
    .replace(/\bLicense:\s*(?:CC|Creative Commons)(?:\b(?:https?:\/\/|www\.|github\.com\/|kaggle\.com\/)[^\s<>{}\[\]]+(?<!\.)|[^.]|\.(?=\d))*\.?/giu, ' ')
    .replace(/\bWork in progress\b/giu, ' ')
    .replace(/\bA PREPRINT\s*[-–—]\s*[\p{L}]+\s+\d{1,2},?\s+\d{4}\b/giu, ' ')
    .replace(/\b[\p{L}\p{N}.-]+\s+Workshop on [^.]{0,180}\b(?:19|20)\d{2}\b/giu, ' ')
    .replace(/\b\d{4}[–-]\d{4}\/\d{2}\$\d{2}\.\d{2}\s*©\s*\d{4}\s+[\p{L}\p{N}.-]+/giu, ' ')
    .replace(/©\s*\d{4}\s+Copyright for this paper by its authors\.?/giu, ' ')
    .replace(/\bPage\s+\d+\s+of\s+\d+\b/giu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function preserveMathBrackets(match, offset, source) {
  const before = source.slice(0, offset).trimEnd();
  const after = source.slice(offset + match.length).trimStart();
  const mathContext = /\b(?:array|coordinate|domain|interval|matrix|point|range|set|tuple|vector)\s*$/iu.test(before)
    || /(?:=|∈|⊂|⊆|[+×*/<>-])\s*$/u.test(before)
    || /^(?:=|∈|⊂|⊆|[+×*/<>])/u.test(after);
  return mathContext ? match : ' ';
}

function getPositionedTextItems(items) {
  return items.map((item, originalIndex) => {
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number.isFinite(transform[4]) ? transform[4] : 0;
    const y = Number.isFinite(transform[5]) ? transform[5] : 0;
    const height = Number(item.height) || 10;
    const sourceText = normalizeText(pdfNarrationSource(item));
    const text = item.dir === 'rtl' && item.textOrder !== 'logical' && /[\u0590-\u08ff]/u.test(sourceText)
      ? [...sourceText].reverse().join('')
      : sourceText;
    return {
      ...item,
      text,
      x,
      y,
      width: Number(item.width) || estimateTextWidth(text, height),
      height,
      originalIndex,
    };
  }).filter((item) => item.text && (isVerticalPdfItem(item) || isHorizontal(item)) && !isHairlineMarkerGlyph(items, item.originalIndex));
}

// Some producers emit a hairline "." glued in front of inline math. It is a
// typesetting marker, not sentence punctuation.
function isHairlineMarkerGlyph(items, index) {
  const item = items[index];
  if (normalizeText(item?.str) !== '.') return false;
  const height = Math.abs(Number(item.transform?.[3]) || Number(item.height) || 0);
  const width = Number(item.width) || 0;
  if (!(height > 0) || !(width > 0) || width > height * 0.18) return false;
  const next = items.slice(index + 1, index + 4).find((candidate) => String(candidate?.str || '').trim());
  if (!next || !/^[\p{L}\p{N}]/u.test(String(next.str))) return false;
  const gap = (Number(next.transform?.[4]) || 0) - ((Number(item.transform?.[4]) || 0) + width);
  return Math.abs(gap) <= Math.max(0.5, height * 0.1)
    && Math.abs((Number(next.transform?.[5]) || 0) - (Number(item.transform?.[5]) || 0)) <= height * 0.5;
}

// Symbol-font bullets (Wingdings "l", "n", "q", ...) arrive as a small lone
// letter set apart from the larger text that starts the row.
function normalizeSymbolBullets(items) {
  return items.map((item) => {
    if (!/^(?:\p{L}|[-])$/u.test(item.text)) return item;
    const sameBaseline = (candidate, height) => Math.abs(candidate.y - item.y) <= height * 0.5;
    const next = items.filter((candidate) => (
      candidate !== item
      && candidate.x >= rightOf(item)
      && sameBaseline(candidate, candidate.height)
      && candidate.x - rightOf(item) <= candidate.height * 1.5
    )).sort((a, b) => a.x - b.x)[0];
    if (!next || next.height < item.height * 1.4 || !/^\p{L}/u.test(next.text)) return item;
    if (next.x - rightOf(item) < next.height * 0.25) return item;
    const startsRow = !items.some((candidate) => (
      candidate !== item
      && candidate.x < item.x
      && sameBaseline(candidate, next.height)
      && item.x - rightOf(candidate) < next.height * 3
    ));
    return startsRow ? { ...item, text: '•' } : item;
  });
}

function alignRaisedInlineItems(items, typicalHeight) {
  return items.map((item) => {
    if (!/^[\p{L}\p{N}]$/u.test(item.text)) return item;
    const baselineNeighbor = items.filter((candidate) => {
      if (candidate === item || candidate.height < item.height * 1.2) return false;
      if (candidate.height >= typicalHeight * 1.8 && /^\p{Lu}$/u.test(candidate.text)) return false;
      const horizontalGap = Math.min(
        Math.abs(item.x - rightOf(candidate)),
        Math.abs(candidate.x - rightOf(item)),
      );
      return horizontalGap <= Math.max(3, typicalHeight * 0.4)
        && Math.abs(candidate.y - item.y) <= candidate.height * 0.7;
    }).sort((a, b) => (
      Math.min(Math.abs(item.x - rightOf(a)), Math.abs(a.x - rightOf(item)))
      - Math.min(Math.abs(item.x - rightOf(b)), Math.abs(b.x - rightOf(item)))
    ))[0];
    return baselineNeighbor ? { ...item, y: baselineNeighbor.y } : item;
  });
}

function isHorizontal(item) {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  return Math.abs(Number(transform[1]) || 0) <= Math.abs(Number(transform[0]) || 0)
    && Math.abs(Number(transform[2]) || 0) <= Math.abs(Number(transform[3]) || 0);
}

function clusterRows(items, tolerance, position = item => item.y) {
  const rows = [];
  for (const item of [...items].sort((a, b) => position(b) - position(a) || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - position(item)) <= tolerance);
    if (row) {
      row.parts.push(item);
      row.y = row.parts.reduce((sum, part) => sum + position(part), 0) / row.parts.length;
      row.left = Math.min(row.left, item.x);
      row.right = Math.max(row.right, rightOf(item));
    } else {
      rows.push({ y: position(item), left: item.x, right: rightOf(item), parts: [item] });
    }
  }
  return rows;
}

function attachDropCaps(rows, typicalHeight) {
  const result = rows.map((row) => ({ ...row, parts: [...row.parts] }));
  for (const source of result) {
    for (const part of [...source.parts]) {
      if (part.height < typicalHeight * 1.8 || !/^["'“‘]?\p{Lu}$/u.test(normalizeText(part.text))) continue;
      const target = result.filter((candidate) => (
        candidate !== source
        && candidate.y > part.y
        && candidate.y - part.y <= part.height * 0.7
        && candidate.left >= rightOf(part) - 2
        && candidate.left - rightOf(part) <= Math.max(24, typicalHeight * 2, part.height * 0.75)
      )).sort((a, b) => b.y - a.y)[0];
      if (!target) continue;
      source.parts = source.parts.filter((candidate) => candidate !== part);
      // A decorative initial can repeat the first letter already present in body text.
      if (!normalizeText(target.parts[0].text).startsWith(normalizeText(part.text))) target.parts.push(part);
      refreshRowBounds(source);
      refreshRowBounds(target, { preserveY: true });
    }
  }
  return result.filter((row) => row.parts.length);
}

function refreshRowBounds(row, { preserveY = false } = {}) {
  if (!row.parts.length) return;
  if (!preserveY) row.y = row.parts.reduce((sum, part) => sum + part.y, 0) / row.parts.length;
  row.left = Math.min(...row.parts.map((part) => part.x));
  row.right = Math.max(...row.parts.map(rightOf));
}

function getTableRows(rows) {
  rows = rows.filter(row => !row.inlineCode);
  const height = median(rows.flatMap((row) => row.parts.map((part) => part.height))) || 12;
  const tableRows = getWrappedTableRows(rows, height);
  const candidates = rows.filter((row) => !tableRows.has(row) && !row.tableContinuation)
    .map((row) => ({ row, cells: getRowCells(row, height * 2) }))
    .filter(({ row, cells }) => cells.length >= 2 && !row.parts.some((part) => part.numericMatrix));
  const groups = [];
  for (const candidate of candidates.sort((a, b) => b.row.y - a.row.y)) {
    const previous = groups.at(-1)?.at(-1);
    const first = groups.at(-1)?.[0];
    const contiguous = previous && previous.row.y - candidate.row.y <= height * 5;
    const sameShape = previous
      && candidate.cells.length <= first.cells.length
      && (first.cells.filter((cell) => /^\d+(?:[.,]\d+)?$/u.test(cell.text)).length < 2
        || (candidate.cells.filter((cell) => /^\d+(?:[.,]\d+)?$/u.test(cell.text)).length >= 2
          && candidate.cells.every((cell) => cell.text.split(/\s+/u).length <= 6)))
      && candidate.cells.every((cell) => first.cells.some((other) => cellsAlign(cell, other, height)));
    if (contiguous && sameShape) {
      if (candidate.cells.length < first.cells.length && previous.row.y - candidate.row.y <= height * 1.6
        && candidate.cells.filter((cell) => /^\d+(?:[.,]\d+)?$/u.test(cell.text)).length < 2) continue;
      groups.at(-1).push(candidate);
    }
    else groups.push([candidate]);
  }

  for (const group of groups.filter((candidate) => candidate.length >= 3)) {
    const hasTextHeader = group[0].cells.every((cell) => /\p{L}/u.test(cell.text)
      && !/[.!?;]$/u.test(cell.text) && cell.text.split(/\s+/u).length <= 6);
    const numericDataRows = group.filter(({ cells }) => (
      cells.some((cell) => isNumericMatrixValue(cell.text))
      && (cells.some((cell) => /\p{L}/u.test(cell.text)) || (hasTextHeader && cells.every((cell) => (
        isNumericMatrixValue(cell.text) || /^[+−-]?\d+(?:[.,]\d+)?\s*[-–—]\s*[+−-]?\d+(?:[.,]\d+)?%?$/u.test(cell.text)
      ))))
    ));
    // ponytail: untagged tables need compact aligned rows; dense prose-like layouts
    // stay column-major. Prefer PDF structure tags if those ambiguous cases need support.
    const textTable = group[0].cells.every((cell) => /\p{L}/u.test(cell.text)
      && !/\d|[.!?;]$/u.test(cell.text) && cell.text.split(/\s+/u).length <= 6)
      && group.every(({ cells }, index) => cells.every((cell) => cell.text.split(/\s+/u).length <= 12)
        && (!index || group[index - 1].row.y - group[index].row.y >= height * 2));
    // Sparse numeric marks beside a paragraph can be chart axes. Without a
    // text header, numeric tables must keep the same columns on every row.
    const numericTable = numericDataRows.length >= 2
      && (group.every(({ cells }) => cells.length === group[0].cells.length
        && (cells.length >= 3 || cells.every((cell) => cell.text.split(/\s+/u).length <= 6)))
        || group.every(({ cells }) => cells.length >= 3
          && cells.filter((cell) => /^\d+(?:[.,]\d+)?$/u.test(cell.text)).length >= 2
          && cells.every((cell) => cell.text.split(/\s+/u).length <= 6)));
    if (!numericTable && !textTable) continue;
    for (const [index, { row, cells }] of group.entries()) {
      row.tableCells = cells;
      row.tableId = group[0].row.parts[0].originalIndex;
      tableRows.add(row);
      const nextY = group[index + 1]?.row.y ?? row.y - height * 3;
      for (const continuation of rows.filter((candidate) => candidate.y < row.y && candidate.y > nextY
        && !tableRows.has(candidate) && !candidate.tableContinuation && row.y - candidate.y <= height * 1.6)) {
        const extraCells = getRowCells(continuation, height * 2);
        const nextCells = group[index + 1]?.cells;
        if (nextCells && continuation.y - nextY < row.y - continuation.y
          && extraCells.every((cell) => cells.some((other) => cellsAlign(cell, other, height))
            && !nextCells.some((other) => cellsAlign(cell, other, height)))) {
          nextCells.push(...extraCells);
          nextCells.sort((a, b) => a.x - b.x);
          continuation.tableContinuation = true;
          continue;
        }
        // Resolve every target before merging: merged parts move a cell's right edge.
        const targets = extraCells.map((cell) => cells.find((other) => cellsAlign(cell, other, height)));
        if (targets.some((target) => !target)) continue;
        extraCells.forEach((cell, cellIndex) => targets[cellIndex].parts.push(...cell.parts));
        continuation.tableContinuation = true;
      }
      row.parts = cells.flatMap((cell) => cell.parts);
    }
  }
  return tableRows;
}

function getWrappedTableRows(rows, height) {
  const tableRows = new Set();
  const sorted = [...rows].sort((a, b) => b.y - a.y);
  const compactLabel = (text) => /\p{L}/u.test(text) && !/[.!?;]$/u.test(text)
    && text.split(/\s+/u).length <= 12;
  for (const [index, header] of sorted.entries()) {
    if (tableRows.has(header) || header.tableContinuation || header.parts.some((part) => part.numericMatrix)) continue;
    const headerCells = getRowCells(header, height * 0.5);
    if (headerCells.length !== 2 || !headerCells.every((cell) => compactLabel(cell.text)
      && !/\d/u.test(cell.text) && cell.text.split(/\s+/u).length <= 6)) continue;
    const starts = headerCells.map((cell) => cell.x);
    const bands = [{ row: header, cells: headerCells.map((cell) => [...cell.parts]), rows: [header], lineCounts: [1, 1] }];
    let previous = header;
    let previousHasLeft = true;
    for (const row of sorted.slice(index + 1)) {
      const gap = previous.y - row.y;
      if (gap > height * 5 || tableRows.has(row) || row.tableContinuation
        || row.parts.some((part) => part.numericMatrix)) break;
      // A header supplies stable column starts even when wrapped labels nearly fill the gutter.
      const cells = [row.parts.filter((part) => part.x < starts[1] - height * 0.5),
        row.parts.filter((part) => part.x >= starts[1] - height * 0.5)]
        .map((parts) => parts.sort((a, b) => a.x - b.x));
      if (cells.some((parts, column) => parts.length && Math.abs(parts[0].x - starts[column]) > height * 0.5)
        || cells[0].some((part) => rightOf(part) > starts[1] - height * 0.25)) break;
      if (!previousHasLeft && cells[0].length && !cells[1].length) break;
      const paired = cells.every((parts) => parts.length);
      const startsRow = paired && (bands.length === 1 || !previousHasLeft || gap > height * 1.6);
      if (!startsRow && (bands.length === 1 || gap > height * 1.6)) break;
      const band = startsRow ? { row, cells: [[], []], rows: [], lineCounts: [0, 0] } : bands.at(-1);
      if (cells[0].length && !compactLabel(joinParts([...band.cells[0], ...cells[0]]))) break;
      if (startsRow) bands.push(band);
      cells.forEach((parts, column) => {
        band.cells[column].push(...parts);
        if (parts.length) band.lineCounts[column] += 1;
      });
      band.rows.push(row);
      previous = row;
      previousHasLeft = Boolean(cells[0].length);
    }
    // shortcut: Infer only repeated short labels beside longer wrapped descriptions; ambiguous layouts need PDF structure tags.
    const data = [];
    for (const band of bands.slice(1)) {
      if (!compactLabel(joinParts(band.cells[0]))
        || band.lineCounts[1] <= band.lineCounts[0]
        || joinParts(band.cells[1]).split(/\s+/u).length < 12) break;
      data.push(band);
    }
    if (data.length < 2) continue;
    for (const band of [bands[0], ...data]) {
      band.row.tableCells = band.cells.map(formatCell);
      band.row.tableId = header.parts[0].originalIndex;
      band.row.parts = band.cells.flat();
      tableRows.add(band.row);
      for (const continuation of band.rows.slice(1)) continuation.tableContinuation = true;
    }
  }
  return tableRows;
}

// Aligned comments inside a fixed-pitch program belong to their source line,
// rather than forming an independent prose column beside the program.
function markInlineCodeRows(rows) {
  for (const row of rows) {
    const parts = [...row.parts].sort((a, b) => a.x - b.x);
    if (parts.some((part, index) => index > 0 && /^(?:#|\/\/|\/\*)/u.test(part.text)
      && part.x - rightOf(parts[index - 1]) > 24
      && /^[\p{L}_$][\p{L}\p{N}_$.]*(?:\(|\s*=(?!=))/u.test(joinParts(parts.slice(0, index))))) row.inlineCode = true;
  }
  const runs = [];
  for (const row of [...rows].sort((a, b) => b.y - a.y)) {
    const fonts = new Set(row.parts.map(part => part.fontName));
    const font = fonts.size === 1 ? row.parts[0]?.fontName : null;
    const height = median(row.parts.map(part => part.height));
    const run = runs.at(-1), previous = run?.rows.at(-1);
    if (font && previous && font === run.font && Math.abs(height - run.height) <= run.height * .05
      && previous.y - row.y <= run.height * 1.8) run.rows.push(row);
    else runs.push({ font, height, rows: [row] });
  }
  for (const run of runs) {
    if (!run.font || run.rows.length < 3) continue;
    const pitches = run.rows.flatMap(row => row.parts).map(part => ({
      count: [...String(part.str ?? part.text)].length, width: part.width,
    })).filter(part => part.count && part.width > 0).map(part => part.width / part.count);
    if (pitches.length < 3 || Math.max(...pitches) - Math.min(...pitches) > median(pitches) * .02) continue;
    const comments = run.rows.flatMap(row => {
      const parts = [...row.parts].sort((a, b) => a.x - b.x);
      const at = parts.findIndex((part, index) => index > 0 && /^(?:#|\/\/|\/\*)/u.test(part.text)
        && part.x - rightOf(parts[index - 1]) > 24
        && /[=(){}[\]]/u.test(joinParts(parts.slice(0, index))));
      return at < 0 ? [] : [parts[at]];
    });
    if (comments.length < 2 || Math.max(...comments.map(part => part.x)) - Math.min(...comments.map(part => part.x)) > run.height) continue;
    for (const row of run.rows) row.inlineCode = true;
  }
}

// Margin notes form a sparse, narrow column beside the text block. Their
// gutter is often narrower than a column gap, so it is found from whitespace
// that no row crosses rather than from a fixed gap size.
function findSideNoteGutter(rows, pageWidth) {
  const height = median(rows.flatMap((row) => row.parts.map((part) => part.height))) || 10;
  const minimumGap = Math.max(6, height * 0.5);
  const candidates = [];
  for (const row of rows) {
    const parts = [...row.parts].sort((a, b) => a.x - b.x);
    for (let index = 1; index < parts.length; index += 1) {
      const gapStart = Math.max(...parts.slice(0, index).map(rightOf));
      if (parts[index].x - gapStart >= minimumGap) candidates.push(Math.round((gapStart + parts[index].x) / 2));
    }
  }
  for (const x of new Set(candidates)) {
    const sides = { left: { rows: [], min: Infinity, max: -Infinity }, right: { rows: [], min: Infinity, max: -Infinity } };
    let supporting = 0;
    let crossing = 0;
    for (const row of rows) {
      if (row.parts.some((part) => part.x < x && rightOf(part) > x)) {
        crossing += 1;
        continue;
      }
      const left = row.parts.filter((part) => rightOf(part) <= x);
      const right = row.parts.filter((part) => part.x >= x);
      for (const [side, parts] of [['left', left], ['right', right]]) {
        if (!parts.length) continue;
        sides[side].rows.push(parts);
        sides[side].min = Math.min(sides[side].min, ...parts.map((part) => part.x));
        sides[side].max = Math.max(sides[side].max, ...parts.map(rightOf));
      }
      if (left.length && right.length) supporting += 1;
    }
    if (supporting < 2 || crossing > Math.max(1, supporting * 0.5)) continue;
    let side = sides.left.rows.length <= sides.right.rows.length * 0.35 ? 'left'
      : sides.right.rows.length <= sides.left.rows.length * 0.35 ? 'right' : '';
    if (!side && crossing === 0) {
      for (const candidate of ['left', 'right']) {
        const note = sides[candidate], main = sides[candidate === 'left' ? 'right' : 'left'];
        const heightOf = column => median(column.rows.flatMap(parts => parts.map(part => part.height)));
        if (note.max - note.min <= (main.max - main.min) * 0.5 && heightOf(note) <= heightOf(main) * 0.8) {
          side = candidate;
          break;
        }
      }
    }
    if (!side || sides[side === 'left' ? 'right' : 'left'].rows.length < 6) continue;
    if (sides[side].max - sides[side].min > pageWidth * 0.3) continue;
    // List markers and code line numbers also hang in a narrow side region.
    const wordyRows = sides[side].rows.filter((parts) => /\p{L}{3,}/u.test(joinParts(parts)));
    if (wordyRows.length < sides[side].rows.length * 0.5) continue;
    return { x, side };
  }
  return null;
}

function splitSideNote(row, gutter) {
  if (!gutter || row.inlineCode) return [{ row, sideNote: false }];
  if (row.parts.some((part) => part.x < gutter.x && rightOf(part) > gutter.x)) return [{ row, sideNote: false }];
  const isNote = (part) => (gutter.side === 'left' ? rightOf(part) <= gutter.x : part.x >= gutter.x);
  const note = row.parts.filter(isNote);
  const main = row.parts.filter((part) => !isNote(part));
  const subRow = (parts) => ({
    ...row,
    y: parts.reduce((sum, part) => sum + part.y, 0) / parts.length,
    left: Math.min(...parts.map((part) => part.x)),
    right: Math.max(...parts.map(rightOf)),
    parts,
  });
  return [
    ...(main.length ? [{ row: subRow(main), sideNote: false }] : []),
    ...(note.length ? [{ row: subRow(note), sideNote: true }] : []),
  ];
}

// A margin keyword that repeats words from the text beside it is a gloss;
// narrating it would interrupt the sentence it annotates.
function markSideNoteGlosses(lines) {
  const main = lines.filter((line) => !line.sideNote);
  const blocks = [];
  for (const note of lines.filter((line) => line.sideNote).sort((a, b) => b.y - a.y)) {
    const block = blocks.at(-1);
    const previous = block?.at(-1);
    if (previous && previous.y - note.y <= maximumLineHeight(previous) * 1.6 && overlapRatio(previous, note) > 0) block.push(note);
    else blocks.push([note]);
  }
  const glosses = new Set(blocks.filter((block) => {
    const words = normalizeText(block.map((line) => line.text).join(' ')).toLowerCase().match(/\p{L}{3,}/gu) || [];
    if (!words.length) return false;
    const reach = maximumLineHeight(block[0]) * 4;
    const nearby = main.filter((other) => other.y <= block[0].y + reach && other.y >= block.at(-1).y - reach)
      .sort((a, b) => b.y - a.y)
      .map((other) => normalizeText(other.text).toLowerCase())
      .join('\n')
      .replace(/-\n/gu, '')
      .replace(/\n/gu, ' ');
    return words.every((word) => nearby.includes(word));
  }).flat());
  return lines.map((line) => (glosses.has(line) ? { ...line, nonNarrativeRegion: 'side-note' } : line));
}

function markNumericMatrices(rows) {
  const height = median(rows.flatMap((row) => row.parts.map((part) => part.height))) || 12;
  const cellRows = rows.map((row) => ({ ...row, cells: getRowCells(row, height * 0.6) }));
  const parts = rows.flatMap(row => row.parts), ocr = parts.every(part => Number.isInteger(part.ocrLine));
  const position = part => part.y + (ocr ? part.height / 2 : 0), tolerance = Math.max(2, height * 0.55);
  const byPosition = [...parts].sort((a, b) => position(a) - position(b));
  function cellsAt(y, left) {
    let low = 0, high = byPosition.length;
    while (low < high) { const middle = (low + high) >>> 1; if (position(byPosition[middle]) < y - tolerance) low = middle + 1; else high = middle; }
    const aligned = [];
    for (let i = low; i < byPosition.length && position(byPosition[i]) <= y + tolerance; i++) if (byPosition[i].x >= left) aligned.push(byPosition[i]);
    return getRowCells({ parts: aligned }, height * 0.6);
  }
  const groups = [];
  for (const row of cellRows) {
    for (let index = 0; index < row.cells.length; index += 1) {
      const first = row.cells[index];
      const label = numericMatrixLabel(first.text);
      if (!label) continue;
      // Other columns must not pull a symbolic label away from its own values.
      const y = first.parts.reduce((sum, part) => sum + position(part), 0) / first.parts.length;
      const aligned = cellsAt(y, first.x); if (aligned[0]?.text !== first.text) continue;
      const cells = [aligned[0]];
      for (const cell of aligned.slice(1)) {
        if (!isNumericMatrixValue(cell.text)) break;
        cells.push(cell);
      }
      if (cells.length < 2) continue;
      const previous = groups.find((group) => group.label === label
        && Math.abs(group.x - first.x) <= height
        && group.rows.at(-1).y - y <= height * 4);
      if (previous) previous.rows.push({ y, cells });
      else groups.push({ x: first.x, label, rows: [{ y, cells }] });
    }
  }
  for (const group of groups) {
    if (!isNumericMatrix(group.rows.map((row) => row.cells.map((cell) => cell.text)))) continue;
    const parts = group.rows.flatMap((row) => row.cells.flatMap((cell) => cell.parts));
    for (const part of parts) part.numericMatrix = true;
    const right = Math.max(...parts.map(rightOf));
    const top = group.rows[0].y;
    // ponytail: only compact symbolic headers immediately above a confirmed matrix are omitted.
    for (const row of cellRows.filter((candidate) => candidate.y > top && candidate.y - top <= height * 4)) {
      for (const cell of row.cells) {
        if (cell.x < group.x - height || cell.x > right ||
          !(/^[\p{Lu}]{1,3}$/u.test(cell.text.replace(/\s/gu, '')) || numericMatrixLabel(cell.text))) continue;
        for (const part of cell.parts) part.numericMatrix = true;
      }
    }
  }
}

function getRowCells(row, minGap = 24) {
  const parts = [...row.parts].sort((a, b) => a.x - b.x);
  const numericRow = parts.filter((part) => isNumericMatrixValue(part.text)).length >= 3;
  const cells = [];
  let current = [];
  for (const part of parts) {
    const gap = numericRow && isNumericMatrixValue(part.text) ? Math.min(minGap, part.height * 0.5) : minGap;
    if (current.length && part.x - rightOf(current.at(-1)) >= gap) {
      cells.push(formatCell(current));
      current = [];
    }
    current.push(part);
  }
  if (current.length) cells.push(formatCell(current));
  return cells;
}

function formatCell(parts) {
  return { x: parts[0].x, text: joinParts(parts), parts };
}

function cellsAlign(a, b, tolerance) {
  return Math.abs(a.x - b.x) <= tolerance
    || Math.abs((a.x + rightOf(a.parts.at(-1))) / 2 - (b.x + rightOf(b.parts.at(-1))) / 2) <= tolerance
    || Math.abs(rightOf(a.parts.at(-1)) - rightOf(b.parts.at(-1))) <= tolerance;
}

function detectBodyColumnStarts(rows, pageWidth) {
  const clusters = [];
  const candidates = rows.flatMap((row) => {
    const parts = [...row.parts].sort((a, b) => a.x - b.x);
    return parts.filter((part, index) => (
      !part.numericMatrix && (index === 0 || part.x - rightOf(parts[index - 1]) >= 10)
    ));
  });
  for (const item of candidates) {
    const textCount = /\p{L}/u.test(item.text) ? 1 : 0;
    const cluster = clusters.find((candidate) => Math.abs(candidate.x - item.x) <= 18);
    if (cluster) {
      cluster.values.push(item.x);
      cluster.textCount += textCount;
      cluster.x = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
    } else {
      clusters.push({ x: item.x, values: [item.x], textCount });
    }
  }
  const ranked = clusters.filter((cluster) => cluster.values.length >= 2)
    .sort((a, b) => b.values.length - a.values.length);
  const columnPairs = [];
  for (let leftIndex = 0; leftIndex < ranked.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ranked.length; rightIndex += 1) {
      const pair = [ranked[leftIndex], ranked[rightIndex]].sort((a, b) => a.x - b.x);
      if (pair[1].x - pair[0].x < pageWidth * 0.22) continue;
      const strength = pair[0].values.length + pair[1].values.length;
      // Repeated table values must not outrank the surrounding text columns.
      const textColumns = pair.filter((cluster) => cluster.textCount >= 2).length;
      columnPairs.push({ starts: pair.map((cluster) => cluster.x), strength, textColumns });
    }
  }
  // Illustration labels can outrank the real columns; validate candidates in strength order.
  const best = columnPairs.sort((a, b) => b.textColumns - a.textColumns || b.strength - a.strength)
    .find(candidate => hasColumnGutter(rows, candidate.starts));
  if (!best) return [];
  let starts = best.starts;
  for (const cluster of ranked) {
    if (starts.some(start => Math.abs(start - cluster.x) < pageWidth * 0.22)) continue;
    const candidate = [...starts, cluster.x].sort((a, b) => a - b);
    const gutters = candidate.slice(1).every((rightStart, index) => {
      const leftStart = candidate[index];
      const nextStart = candidate[index + 2] ?? Infinity;
      const localRows = rows.map(row => ({ ...row, parts: row.parts.filter(part =>
        part.x >= leftStart - 30 && part.x < nextStart - 30) })).filter(row => row.parts.length);
      const proseRows = right => localRows.filter(row => isWordy(joinParts(row.parts.filter(part =>
        right ? part.x >= rightStart - 30 : part.x < rightStart - 30)))).length;
      return proseRows(false) >= 2 && proseRows(true) >= 2 && hasColumnGutter(localRows, [leftStart, rightStart]);
    });
    if (gutters) starts = candidate;
  }
  return starts;
}

// Real columns leave a whitespace gutter that most two-sided rows share. In
// single-column text, lines run across the would-be gutter and only an
// occasional wide word or sentence gap lands there, whatever item
// granularity the PDF producer used.
function hasColumnGutter(rows, [leftStart, rightStart], boundary = rightStart - 30) {
  const height = median(rows.flatMap((row) => row.parts.map((part) => part.height))) || 10;
  const wideText = Math.max(height * 8, (rightStart - leftStart) * 0.4);
  const columnText = (segments) => segments.some((parts) => rightOf(parts.at(-1)) - parts[0].x >= wideText)
    || segments.filter((parts) => isWordy(joinParts(parts))).length >= 2;
  let gutterRows = 0;
  let crossingRows = 0;
  let run = { gutterRows: 0, left: [], right: [], rows: [] };
  // Independent columns: one side's sentence runs on into the next line while
  // the other side starts a new entry on that same row. A wrapped table cell
  // continues beside an empty or equally wrapped neighbouring cell instead.
  const flows = (side) => run.rows.some((row, index) => {
    const nextRow = run.rows[index + 1];
    const other = side === 'left' ? 'right' : 'left';
    const current = row[side] && joinParts(row[side]);
    const next = nextRow?.[side] && joinParts(nextRow[side]);
    return current && next && nextRow[other] && isProseLine({ text: current })
      && !/[.!?:;]$/u.test(current) && /^[\p{Ll}(]/u.test(next)
      && /^\p{Lu}/u.test(joinParts(nextRow[other]));
  });
  // A local block of gutter rows with column text on both sides is enough:
  // a keywords/abstract block can sit above a single-column body. The rows
  // must share one whitespace gutter, not merely have nearby word gaps.
  const runIsColumnBlock = () => run.gutterRows >= 2 && columnText(run.left) && columnText(run.right)
    && Math.min(...run.right.map((parts) => parts[0].x))
      - Math.max(...run.left.map((parts) => rightOf(parts.at(-1)))) >= Math.max(6, height * 0.5)
    && (flows('left') || flows('right'));
  for (const row of [...rows].sort((a, b) => b.y - a.y)) {
    const parts = [...row.parts].sort((a, b) => a.x - b.x);
    const left = parts.filter((part) => part.x < boundary);
    const right = parts.filter((part) => part.x >= boundary);
    const crossing = parts.some((part) => part.x < boundary && rightOf(part) > rightStart - 4);
    const gutter = !crossing && left.length && right.length
      && right[0].x - Math.max(...left.map(rightOf)) >= Math.max(6, median(parts.map((part) => part.height)) * 0.5);
    if (crossing || (left.length && right.length && !gutter)) {
      crossingRows += 1;
      if (runIsColumnBlock()) return true;
      run = { gutterRows: 0, left: [], right: [], rows: [] };
      continue;
    }
    run.rows.push({ left: left.length ? left : null, right: right.length ? right : null });
    if (left.length) run.left.push(left);
    if (right.length) run.right.push(right);
    if (gutter) {
      gutterRows += 1;
      run.gutterRows += 1;
    }
  }
  return runIsColumnBlock() || (gutterRows >= 2 && gutterRows >= crossingRows);
}

function isWordy(text) {
  return (text.match(/\p{L}{2,}/gu) || []).length >= 2 && (text.match(/\p{L}/gu) || []).length >= 8;
}

function splitRow(row, {
  direction,
  pageRtl = false,
  bodyColumnStarts = [],
  columnRows = [],
  preserveCompactFragments = false,
}) {
  if (row.inlineCode) return [formatRow(row, { direction })];
  const parts = [...row.parts].sort((a, b) => a.x - b.x);
  if (parts.length <= 1) return [formatRow(row, { direction })];
  if (bodyColumnStarts.length >= 2) {
    const groups = bodyColumnStarts.map(() => []);
    const minimumGutter = Math.max(6, median(parts.map(part => part.height)) * 0.5);
    // Narrow gutters need whitespace shared by nearby prose rows, not a fixed offset.
    const boundaries = bodyColumnStarts.map((start, column) => column > 0 ? parts.filter((part, index) => {
      const gap = index > 0 ? part.x - rightOf(parts[index - 1]) : 0;
      const alignmentTolerance = (start - bodyColumnStarts[column - 1]) * 0.25;
      if (gap < minimumGutter || gap > Math.max(24, (start - bodyColumnStarts[column - 1]) * 0.35)
        || Math.abs(part.x - start) > Math.max(48, alignmentTolerance)) return false;
      if (!isProseLine({ text: joinParts(parts.filter(candidate => candidate.x >= bodyColumnStarts[column - 1] - 48 && candidate.x < part.x)) })
        || !isProseLine({ text: joinParts(parts.filter(candidate => candidate.x >= part.x && candidate.x < (bodyColumnStarts[column + 1] ?? Infinity) - 30)) })) return false;
      const nearbyRows = columnRows.filter(candidate => Math.abs(candidate.y - row.y) <= minimumGutter * 6)
        .map(candidate => ({ ...candidate, parts: candidate.parts.filter(item =>
          item.x >= bodyColumnStarts[column - 1] - 48 && item.x < (bodyColumnStarts[column + 1] ?? Infinity) - 30) }));
      const boundary = part.x - gap / 2;
      return nearbyRows.length >= 3 && nearbyRows.every(candidate => !candidate.parts.some(item => item.x < boundary && rightOf(item) > boundary))
        && hasColumnGutter(nearbyRows, [bodyColumnStarts[column - 1], part.x], boundary);
    }).sort((a, b) => Math.abs(a.x - start) - Math.abs(b.x - start))[0]?.x : undefined);
    for (const [partIndex, part] of parts.entries()) {
      const tolerance = partIndex > 0 && part.x - rightOf(parts[partIndex - 1]) > 24 && isWordy(part.text) ? 48 : 30;
      const index = Math.max(0, bodyColumnStarts.findLastIndex((start, column) => part.x >= (boundaries[column] ?? start - tolerance)));
      groups[index].push(part);
    }
    const occupied = groups.filter(group => group.length);
    if (occupied.length === 1 && !pageRtl) return [formatRow(row, { direction })];
    if (occupied.length >= 2 && occupied.slice(1).every((group, index) =>
      group[0].x - occupied[index][0].x > Math.min(100, (bodyColumnStarts[1] - bodyColumnStarts[0]) * 0.8)
      && group[0].x - Math.max(...occupied[index].map(rightOf)) >= Math.max(6, median(parts.map(part => part.height)) * 0.5))) {
      return occupied.map((group) => formatRow({
        y: group.reduce((sum, part) => sum + part.y, 0) / group.length,
        left: Math.min(...group.map((part) => part.x)),
        right: Math.max(...group.map(rightOf)),
        parts: group,
      }, { direction }));
    }
  }
  if (pageRtl && parts.length === 2 && parts[1].x - parts[0].x > 150) {
    return parts.map((part) => formatRow({
      y: part.y,
      left: part.x,
      right: rightOf(part),
      parts: [part],
    }, { direction }));
  }
  const widths = parts.map((part) => part.width || estimateTextWidth(part.text, part.height));
  const compactInlineFragments = preserveCompactFragments
    && parts.length === 2
    && rightOf(parts.at(-1)) - parts[0].x < 220;
  const threshold = compactInlineFragments
    ? 36
    : pageRtl
      ? Math.max(36, median(widths) * 0.75)
      : 24;
  const groups = [];
  let current = [parts[0]];
  for (const part of parts.slice(1)) {
    if (part.x - rightOf(current.at(-1)) > threshold) {
      groups.push(current);
      current = [part];
    } else {
      current.push(part);
    }
  }
  groups.push(current);
  return groups.map((group) => formatRow({
    y: group.reduce((sum, part) => sum + part.y, 0) / group.length,
    left: Math.min(...group.map((part) => part.x)),
    right: Math.max(...group.map(rightOf)),
    parts: group,
  }, { direction }));
}

function formatRow(row, { role = 'paragraph', direction = '' } = {}) {
  const rtl = direction === 'rtl' || (direction !== 'ltr' && isRtlLine(row.parts));
  const byColumn = rtl ? (a, b) => b.x - a.x : (a, b) => a.x - b.x;
  const parts = row.tableCells
    ? [...row.tableCells].sort(byColumn).flatMap((cell) => cell.parts)
    : [...row.parts].sort(byColumn);
  return {
    ...row,
    parts,
    originalIndex: parts[0]?.originalIndex ?? 0,
    text: joinParts(parts),
    role,
  };
}

function classifyLines(lines, { pageView }) {
  const heights = lines.flatMap((line) => line.parts.map((part) => part.height));
  const typicalHeight = median(heights) || 10;
  const top = Math.max(...lines.map((line) => line.y));
  const pageTop = Math.max(pageView?.[1] ?? 0, pageView?.[3] ?? 792);
  const pageHeight = Math.abs((pageView?.[3] ?? 792) - (pageView?.[1] ?? 0)) || 792;

  const classified = lines.map((line) => {
    let role = line.role;
    const documentTitle = line.y >= pageTop - pageHeight * 0.22
      && Math.max(...line.parts.map((part) => part.height)) >= typicalHeight * 1.15;
    if (role !== 'table-row' && (PUBLICATION_METADATA.test(line.text) || ADDITIONAL_METADATA.test(line.text))) role = 'metadata';
    else if (role !== 'table-row' && CAPTION_PREFIX.test(line.text)) role = 'caption';
    else if (role !== 'table-row' && isSemanticSectionHeading(line.text) && !isAbstractHeading(line.text)) role = 'title';
    else if (role !== 'table-row' && LIST_PREFIX.test(line.text)) role = 'list-item';
    else if (role !== 'table-row' && /^[\p{Lu}\d][\p{Lu}\d\s&-]{2,}$/u.test(line.text)
      && line.text.length <= 80) role = 'title';
    else if (role !== 'table-row' && line.y >= top - typicalHeight * 1.5
      && Math.max(...line.parts.map((part) => part.height)) >= typicalHeight * 1.2) role = 'title';
    return { ...line, role, documentTitle };
  });
  // Larger prose below a program continues the page rather than opening it.
  const contentTops = classified.filter((line) => line.role === 'paragraph' && (line.inlineCode || isProseLine(line)
    || /^[\p{L}_$][\p{L}\p{N}_$.]*(?:\(|\s*=(?!=))/u.test(line.text)));
  return classified.map((line) => (line.documentTitle && contentTops.some((other) => (
    other.y > line.y + typicalHeight && overlapRatio(other, line) > 0
  )) ? { ...line, documentTitle: false } : line));
}

function classifyTopMatter(lines, pageView) {
  const abstractLine = lines.filter((line) => isAbstractHeading(line.text))
    .sort((a, b) => b.y - a.y)[0];
  if (!abstractLine) return lines;
  const topMatterLines = lines.filter((line) => line.y > abstractLine.y
    && line.role !== 'caption'
    && !line.captionContinuationOf
    && !line.nonNarrativeRegion);
  const maximumTopMatterHeight = Math.max(0, ...topMatterLines.map(maximumLineHeight));
  return lines.map((line) => {
    if (line === abstractLine
      || line.y <= abstractLine.y
      || line.role === 'caption'
      || line.captionContinuationOf
      || line.nonNarrativeRegion) return { ...line };
    if (isSemanticSectionHeading(line.text)) {
      return { ...line, role: 'title', documentTitle: false };
    }
    if (isCenteredDocumentDate(line, pageView)) return { ...line, documentTitle: false };
    const likelyTitle = maximumLineHeight(line) >= maximumTopMatterHeight * 0.85
      || isLikelyTitleContinuation(line, topMatterLines, pageView);
    return likelyTitle
      ? { ...line, role: 'title', documentTitle: true }
      : { ...line, nonNarrativeRegion: 'top-matter' };
  });
}

function rowContainsAbstractHeading(row) {
  return (row?.parts || []).some((part) => isAbstractHeading(part.text ?? part.str));
}

function isAbstractHeading(text) {
  return /^abstract\b/iu.test(normalizeStructuralHeadingText(text));
}

function isSemanticSectionHeading(text) {
  const normalized = normalizeStructuralHeadingText(text);
  if (normalized.length > 100) return false;
  if (/^(?:\d+(?:\.\d+)*)[.)]?\s+(?:abstract|introduction|background|related work|methods?|methodology|results?|discussion|conclusion|references)\b/iu.test(normalized)) return true;
  return /^\p{Lu}/u.test(normalized)
    && /^(?:abstract|introduction|background|related work|methods?|methodology|results?|discussion|conclusion|references)\b/iu.test(normalized);
}

function normalizeStructuralHeadingText(text) {
  return normalizeText(text).replace(/\b(?:\p{Lu}\s+){2,}\p{Lu}\b/gu, (match) => match.replace(/\s+/gu, ''));
}

function isCenteredDocumentDate(line, pageView) {
  const text = normalizeText(line?.text);
  if (!/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:(?:[12]?\d|3[01]),?\s+)?(?:19|20)\d{2}$/iu.test(text)) return false;
  return isHorizontallyCentered(line, pageView);
}

function isLikelyTitleContinuation(line, topMatterLines, pageView) {
  const text = normalizeText(line?.text);
  const words = text.match(/\p{L}+/gu) || [];
  const titleAbove = topMatterLines.filter((candidate) => (
    candidate !== line
    && candidate.y > line.y
    && (candidate.role === 'title' || candidate.documentTitle)
  )).sort((a, b) => a.y - b.y)[0];
  const closeToTitle = titleAbove
    && titleAbove.y - line.y <= Math.max(42, maximumLineHeight(titleAbove) * 2.5);
  return (line?.documentTitle === true || closeToTitle)
    && words.length >= 5
    && !/[\d,@*†‡]/u.test(text)
    && /\b(?:a|an|beyond|for|from|in|of|on|the|to|towards?|using|via|with)\b/iu.test(text)
    && isHorizontallyCentered(line, pageView);
}

function isHorizontallyCentered(line, pageView) {
  const [rawLeft = 0,, rawRight = 612] = Array.isArray(pageView) ? pageView : [];
  const pageLeft = Math.min(rawLeft, rawRight);
  const pageRight = Math.max(rawLeft, rawRight);
  const pageWidth = Math.max(1, pageRight - pageLeft);
  const pageCenter = pageLeft + pageWidth / 2;
  const lineCenter = (Number(line?.left) + Number(line?.right)) / 2;
  return Number.isFinite(lineCenter) && Math.abs(lineCenter - pageCenter) <= pageWidth * 0.12;
}

function classifyFootnoteRegions(lines, pageView) {
  const [, rawBottom = 0,, rawTop = 792] = Array.isArray(pageView) ? pageView : [];
  const bottom = Math.min(rawBottom, rawTop);
  const top = Math.max(rawBottom, rawTop);
  const footnoteBandTop = bottom + (top - bottom) * 0.22;
  const footnoteLines = new Set();
  const starters = lines.filter((line) => (
    line.y <= footnoteBandTop && isFootnoteStarter(line)
  ));

  for (const starter of starters) {
    footnoteLines.add(starter);
    let boundaryY = starter.y;
    const starterHeight = Math.max(1, maximumLineHeight(starter));
    const continuations = lines.filter((candidate) => (
      candidate !== starter
      && candidate.y < starter.y
      && sameHorizontalRegion(starter, candidate)
    )).sort((a, b) => b.y - a.y);
    for (const candidate of continuations) {
      const gap = boundaryY - candidate.y;
      if (gap > Math.max(18, starterHeight * 2.2)
        || maximumLineHeight(candidate) > starterHeight * 1.35
        || candidate.role === 'caption'
        || candidate.role === 'table-row') break;
      footnoteLines.add(candidate);
      boundaryY = candidate.y;
    }
  }

  return lines.map((line) => footnoteLines.has(line)
    ? { ...line, nonNarrativeRegion: 'footnote' }
    : { ...line });
}

function isFootnoteStarter(line) {
  const text = normalizeText(line?.text);
  const height = maximumLineHeight(line);
  return line?.role === 'metadata'
    || PUBLICATION_METADATA.test(text)
    || ADDITIONAL_METADATA.test(text)
    || (height <= 9.5 && /^(?:\d{1,2}\s*)?(?:https?:\/\/|www\.)/iu.test(text))
    || (height <= 9.5 && /^(?:[*†‡∗]+\s*|\d{1,2}\s+)\p{Lu}/u.test(text))
    || /^(?:[*†‡∗]+\s*|\d+\s+)?(?:[\p{L}\p{N}.-]+\s+code and data\b|manuscript prepared|acm reference format|license:|source note)\b/iu.test(text);
}

function classifyFigureRegions(lines) {
  const working = lines.map((line) => ({ ...line, parts: [...line.parts] }));
  const captions = working.filter((line) => line.role === 'caption');
  const captionContinuations = new Map();

  captions.forEach((caption, captionIndex) => {
    const regionId = `caption-${captionIndex}`;
    caption.captionRegionId = regionId;
    let bottomY = caption.y;
    let captionHeight = maximumLineHeight(caption);
    const structuralBoundary = working.filter((candidate) => (
      candidate !== caption
      && candidate.y < caption.y
      && isCaptionContinuationBoundary(candidate)
    )).sort((a, b) => b.y - a.y)[0];
    const continuations = working.filter((candidate) => (
      candidate !== caption
      && candidate.role === 'paragraph'
      && candidate.y < bottomY
      && sameHorizontalRegion(caption, candidate)
    )).sort((a, b) => b.y - a.y);

    for (const candidate of continuations) {
      const gap = bottomY - candidate.y;
      if (gap > Math.max(18, captionHeight * 1.75)) break;
      if (structuralBoundary
        && candidate.y <= structuralBoundary.y + Math.max(2, captionHeight * 0.25)) break;
      if (isCaptionContinuationBoundary(candidate)) break;
      captionContinuations.set(candidate, regionId);
      bottomY = candidate.y;
      captionHeight = Math.max(captionHeight, maximumLineHeight(candidate));
    }
  });

  const lineHeights = working.map(maximumLineHeight).filter((height) => height > 0).sort((a, b) => a - b);
  const bodyHeight = lineHeights[Math.floor((lineHeights.length - 1) * 0.75)] || 10;
  const figureInternal = new Set();

  for (const caption of captions.filter((line) => /^fig(?:ure)?\b/iu.test(line.text))) {
    let boundaryY = caption.y;
    const candidates = working.filter((candidate) => (
      candidate !== caption
      && (candidate.role === 'paragraph' || candidate.role === 'title')
      && !captionContinuations.has(candidate)
      && candidate.y > caption.y
      && sameHorizontalRegion(caption, candidate)
    )).sort((a, b) => a.y - b.y);

    let capturedCount = 0;
    for (const candidate of candidates) {
      const gap = candidate.y - boundaryY;
      const candidateHeight = maximumLineHeight(candidate);
      const compactLabel = normalizeText(candidate.text).length <= 32
        && candidate.right - candidate.left <= 180;
      // Diagrams and matrices have wide internal whitespace; prose or a
      // heading ends the figure.
      const figureFragment = candidate.role !== 'title' && !isProseLine(candidate);
      const maximumGap = figureFragment
        ? bodyHeight * 8
        : capturedCount === 0 ? bodyHeight * 5 : bodyHeight * 2.5;
      if ((candidateHeight > bodyHeight * 0.9 && !compactLabel && !figureFragment)
        || gap > maximumGap) break;
      figureInternal.add(candidate);
      boundaryY = candidate.y;
      capturedCount += 1;
    }
  }

  return working.map((line) => ({
    ...line,
    captionContinuationOf: captionContinuations.get(line),
    nonNarrativeRegion: figureInternal.has(line) ? 'figure-internal' : line.nonNarrativeRegion,
  }));
}

// Prose is a run of words; diagram labels, matrices, and math are mostly
// symbols, single letters, and numbers.
function isProseLine(line) {
  const tokens = normalizeText(line?.text).split(' ').filter(Boolean);
  const words = tokens.filter((token) => /\p{L}{2,}/u.test(token));
  return words.length >= 4 && words.length >= tokens.length * 0.6;
}

function isCaptionContinuationBoundary(line) {
  const text = normalizeText(line?.text);
  return /^(?:abstract|keywords?|index terms?|ccs concepts?|references?|acknowledg(?:e)?ments?|(?:\d+|[ivxlcdm]+)[.)]?\s+\p{L})\b/iu.test(text);
}

function maximumLineHeight(line) {
  return Math.max(0, ...(line.parts || []).map((part) => Number(part.height) || 0));
}

function sameHorizontalRegion(a, b) {
  return Math.abs(a.left - b.left) <= Math.max(36, maximumLineHeight(a) * 4)
    || overlapRatio(a, b) >= 0.65;
}

function orderLines(lines, {
  direction,
  pageRtl,
  yTolerance,
  bodyColumnStarts,
  captionBands = true,
}) {
  if (captionBands && bodyColumnStarts.length >= 2) {
    const tables = new Map();
    for (const line of lines.filter(line => line.role === 'table-row')) {
      const ys = line.parts.map(part => part.y);
      const span = tables.get(line.tableId) || { top: -Infinity, bottom: Infinity };
      span.top = Math.max(span.top, ...ys);
      span.bottom = Math.min(span.bottom, ...ys);
      tables.set(line.tableId, span);
    }
    // A page-wide caption closes its figure's columns. A caption within one
    // article column does not; nor can a boundary divide a table's row span.
    const captions = lines.filter(line => line.role === 'caption' && spansBodyColumns(line, bodyColumnStarts)
      && ![...tables.values()].some(span => span.top >= line.y && span.bottom <= line.y))
      .sort((a, b) => b.y - a.y);
    if (captions.length) {
      const ordered = [];
      let remaining = lines;
      const options = { direction, pageRtl, yTolerance, bodyColumnStarts, captionBands: false };
      for (const caption of captions) {
        const group = new Set(remaining.filter(line => line === caption
          || (caption.captionRegionId && line.captionContinuationOf === caption.captionRegionId)));
        ordered.push(...orderLines(remaining.filter(line => !group.has(line) && line.y > caption.y), options),
          ...[...group].sort((a, b) => b.y - a.y).map(line => formatRow(line, { role: line.role, direction })));
        remaining = remaining.filter(line => !group.has(line) && line.y <= caption.y);
      }
      return [...ordered, ...orderLines(remaining, options)];
    }
  }
  const captionCandidates = lines.filter((line) => line.role === 'caption');
  const ordinaryLines = lines.filter((line) => line.role !== 'caption');
  const bottomOrdinaryY = ordinaryLines.length ? Math.min(...ordinaryLines.map((line) => line.y)) : -Infinity;
  const captionLines = captionCandidates.filter((line) => line.y < bottomOrdinaryY).sort((a, b) => b.y - a.y);
  const tableLines = lines.filter((line) => line.role === 'table-row' && !line.localTable).sort((a, b) => b.y - a.y);
  const trailingCaptions = new Set(captionLines);
  const nonSpecial = lines.filter((line) => (line.role !== 'table-row' || line.localTable) && !trailingCaptions.has(line));
  if (tableLines.length) {
    const result = [];
    let remaining = nonSpecial;
    for (const id of new Set(tableLines.map((line) => line.tableId))) {
      const band = tableLines.filter((line) => line.tableId === id);
      const tableTop = Math.max(...band.map((line) => line.y));
      const tableBottom = Math.min(...band.flatMap((line) => line.parts.map((part) => part.y)));
      const beforeTable = remaining.filter((line) => line.y > tableTop);
      const withinTable = remaining.filter((line) => line.y <= tableTop && line.y >= tableBottom);
      remaining = remaining.filter((line) => line.y < tableBottom);
      result.push(...orderLayoutLines(beforeTable, { direction, pageRtl, yTolerance, bodyColumnStarts }),
        ...[...withinTable, ...band].sort((a, b) => b.y - a.y)
          .map((line) => formatRow(line, { role: line.role, direction })));
    }
    return [...result, ...orderLayoutLines(remaining, { direction, pageRtl, yTolerance, bodyColumnStarts }), ...captionLines];
  }

  return [...orderLayoutLines(nonSpecial, {
    direction,
    pageRtl,
    yTolerance,
    bodyColumnStarts,
  }), ...captionLines];
}

function orderLayoutLines(lines, { direction, pageRtl, yTolerance, bodyColumnStarts }) {
  const documentTitles = [];
  const titleCandidates = lines.filter(line => line.documentTitle).sort((a, b) => b.y - a.y);
  const rightColumnStart = bodyColumnStarts.length === 2 ? bodyColumnStarts[1] : null;
  const leftBodyRight = rightColumnStart === null ? null : Math.max(-Infinity, ...lines
    .filter(line => !line.documentTitle && isNarrativeParagraph(line) && isProseLine(line)
      && line.left < rightColumnStart && line.right < rightColumnStart)
    .map(line => line.right));
  for (const [index, line] of titleCandidates.entries()) {
    const previous = documentTitles.at(-1);
    const height = previous ? maximumLineHeight(previous) : 0;
    const center = (line.left + line.right) / 2;
    const separateHeadingBeside = titleCandidates.some(other => other !== line
      && Math.abs(other.y - line.y) <= yTolerance
      && (other.right <= line.left || line.right <= other.left)
      && isIndependentColumnHeading(other, bodyColumnStarts));
    const continuesTitle = previous && previous === titleCandidates[index - 1]
      && Number.isFinite(leftBodyRight) && center >= leftBodyRight && center <= rightColumnStart
      && !separateHeadingBeside && line.y < previous.y
      && previous.y - line.y <= height * 1.5
      && Math.abs(maximumLineHeight(line) - height) <= height * 0.15
      && Math.abs((line.left + line.right) - (previous.left + previous.right)) <= height;
    if (!isIndependentColumnHeading(line, bodyColumnStarts) || continuesTitle) documentTitles.push(line);
  }
  const layoutLines = lines.filter(line => !documentTitles.includes(line));
  const lowerBandBoundary = findLowerFullWidthBandBoundary(layoutLines, bodyColumnStarts);
  const regions = lowerBandBoundary
    ? [
      layoutLines.filter((line) => line.y > lowerBandBoundary.y),
      layoutLines.filter((line) => line.y <= lowerBandBoundary.y),
    ]
    : [layoutLines];
  return [
    ...documentTitles.map((line) => formatRow(line, { role: line.role, direction })),
    ...regions.flatMap((region) => orderLayoutRegion(region, {
      direction,
      pageRtl,
      yTolerance,
      bodyColumnStarts,
    })),
  ];
}

function orderLayoutRegion(layoutLines, { direction, pageRtl, yTolerance, bodyColumnStarts }) {
  if (!layoutLines.length) return [];
  const rtl = direction === 'rtl' || (direction !== 'ltr' && pageRtl);
  if (!bodyColumnStarts.length && !hasColumnBlock(layoutLines.filter(isNarrativeParagraphOrHeading))) {
    return orderSingleColumnLines(layoutLines, { rtl, yTolerance, direction });
  }
  const { introLines, bodyLines } = extractIntroLines(layoutLines, yTolerance, { bodyColumnStarts });
  const columns = clusterColumns(bodyLines);
  const orderedBody = [];
  const orderedColumns = columns.sort(rtl ? (a, b) => b.left - a.left : (a, b) => a.left - b.left);
  for (const column of orderedColumns) {
    const orderedColumnLines = column.lines
      .sort((a, b) => b.y - a.y)
      .map((line) => formatRow(line, { role: line.role, direction }));
    const previous = [...orderedBody].reverse().find(isNarrativeParagraph);
    const next = orderedColumnLines.find(isNarrativeParagraph);
    if (shouldJoinAcrossColumns(previous, next)) next.crossColumnContinuation = true;
    orderedBody.push(...orderedColumnLines);
  }
  return [
    ...introLines.sort((a, b) => b.y - a.y).map((line) => formatRow(line, { role: line.role, direction })),
    ...orderedBody,
  ];
}

// Columns need a vertical whitespace gutter with column text on both sides
// and no line running across it. Equations, equation numbers, and paragraph
// endings beside full-width prose do not make a single-column page
// multi-column, however the PDF producer split its text items.
function hasColumnBlock(lines) {
  if (!lines.length) return false;
  const typicalHeight = median(lines.map(maximumLineHeight)) || 10;
  const regionWidth = Math.max(...lines.map((line) => line.right)) - Math.min(...lines.map((line) => line.left));
  const minimumGutter = Math.max(6, typicalHeight * 0.5);
  // Math fragments and equation numbers carry no words; column text does.
  const columnSide = (side) => side.filter((line) => isWordy(line.text)).length >= 2 || side.some((line) => (
    line.right - line.left >= Math.max(typicalHeight * 8, regionWidth * 0.2)
  ));
  const top = [...lines].sort((a, b) => b.y - a.y);
  const candidates = new Set(lines.flatMap((line) => [line.left - 1, line.right + 1].map(Math.round)));
  return [...candidates].some((x) => {
    let left = [];
    let right = [];
    // Column order only differs from top-to-bottom order when the right side
    // starts above where the left side ends.
    const isBlock = () => columnSide(left) && columnSide(right)
      && Math.min(...right.map((line) => line.left)) - Math.max(...left.map((line) => line.right)) >= minimumGutter
      && Math.max(...right.map((line) => line.y)) > Math.min(...left.map((line) => line.y)) + typicalHeight * 0.5;
    for (const line of top) {
      if (line.left < x && line.right > x) {
        if (isBlock()) return true;
        left = [];
        right = [];
      } else if (line.right <= x) left.push(line);
      else right.push(line);
    }
    return isBlock();
  });
}

function clusterLineRows(lines, yTolerance) {
  const rows = [];
  for (const line of [...lines].sort((a, b) => b.y - a.y)) {
    const row = rows.find((candidate) => Math.abs(candidate[0].y - line.y) <= yTolerance);
    if (row) row.push(line);
    else rows.push([line]);
  }
  return rows.map((row) => row.sort((a, b) => a.left - b.left));
}

function orderSingleColumnLines(lines, { rtl, yTolerance, direction }) {
  return clusterLineRows(lines, yTolerance)
    .flatMap((row) => (rtl ? [...row].reverse() : row))
    .map((line) => formatRow(line, { role: line.role, direction }));
}

function findLowerFullWidthBandBoundary(lines, bodyColumnStarts) {
  if (bodyColumnStarts.length < 2) return null;
  const topDown = [...lines].sort((a, b) => b.y - a.y);
  const bodyHeight = median(lines.map(maximumLineHeight)) || 10;
  // Small text below a page-wide gap belongs to a separate lower band.
  const lowerBand = topDown.find((line, index) => index > 0
    && topDown[index - 1].y - line.y > bodyHeight * 6
    && maximumLineHeight(line) < bodyHeight * 0.9 && isProseLine(line));
  if (lowerBand) return lowerBand;
  const bottomColumnY = Math.min(...lines.filter(line => line.left >= bodyColumnStarts.at(-1) - 30
    && isNarrativeParagraphOrHeading(line) && line.text.includes(' ') && isWordy(line.text)).map(line => line.y));
  const fullWidthBody = topDown.find((line, index) => index > 0
    && line.y < bottomColumnY
    && line.left <= bodyColumnStarts[0] + bodyHeight * 2
    && line.right >= bodyColumnStarts.at(-1) + bodyHeight * 4
    && maximumLineHeight(line) >= bodyHeight * 0.9
    && spansBodyColumns(line, bodyColumnStarts) && isNarrativeParagraph(line) && isProseLine(line) && /[.!?]/u.test(line.text)
    && !topDown.slice(0, index).some(previous => canJoinWrappedLine(previous, line))
    && hasColumnBlock(topDown.slice(0, index).filter(isNarrativeParagraph)));
  if (fullWidthBody) return fullWidthBody;
  if (bodyColumnStarts.length !== 2) return null;
  const [leftStart, rightStart] = bodyColumnStarts;
  const abstractHeading = lines.find((line) => (
    isAbstractHeading(line.text) && Math.abs(line.left - rightStart) <= 48
  ));
  if (!abstractHeading) return null;
  return lines.filter((line) => (
    line.y < abstractHeading.y
    && isSemanticSectionHeading(line.text)
    && !isAbstractHeading(line.text)
    && Math.abs(line.left - leftStart) <= 48
  )).sort((a, b) => b.y - a.y)[0] || null;
}

function isNarrativeParagraphOrHeading(line) {
  return !line.nonNarrativeRegion && !line.captionContinuationOf;
}

function isNarrativeParagraph(line) {
  return line?.role === 'paragraph' && !line.nonNarrativeRegion;
}

function shouldJoinAcrossColumns(previous, next) {
  if (!previous || !next) return false;
  const previousText = normalizeText(previous.text);
  const nextText = normalizeText(next.text);
  if (!previousText || !nextText || /[.!?;:]$/u.test(previousText)) return false;
  return /[,/-]$/u.test(previousText) || /^[\p{Ll}(]/u.test(nextText);
}

function clusterColumns(lines) {
  const sorted = [...lines].sort((a, b) => a.left - b.left);
  const tolerance = getColumnXTolerance(sorted);
  const typicalWidth = median(sorted.map((line) => line.right - line.left));
  const columns = [];
  for (const line of sorted) {
    const column = columns.find((candidate) => (
      Math.abs(candidate.left - line.left) <= tolerance || overlapRatio(candidate, line) >= 0.65
    ));
    if (column) {
      column.lines.push(line);
      if (!isBridgeLine(line, typicalWidth)) {
        column.left = Math.min(column.left, line.left);
        column.right = Math.max(column.right, line.right);
      }
    } else {
      const bridge = isBridgeLine(line, typicalWidth);
      columns.push({ left: line.left, right: bridge ? line.left : line.right, lines: [line] });
    }
  }
  return columns;
}

function spansBodyColumns(line, starts) {
  if (starts.length === 2) return line.left < starts[1] - 30 && line.right >= starts[1] - 30;
  return line.left <= starts[0] + 48 && line.right >= starts.at(-1) - 30;
}

function isIndependentColumnHeading(line, starts) {
  // Enlarged prose fragments also receive the document-title flag.
  return starts.length >= 2 && line.documentTitle
    && (starts.length >= 3 || line.role === 'title' || /^\d{1,3}[.)]?\s+\p{Lu}/u.test(line.text))
    && !spansBodyColumns(line, starts);
}

function extractIntroLines(lines, yTolerance, { bodyColumnStarts }) {
  const sorted = [...lines].sort((a, b) => b.y - a.y);
  let firstBodyIndex = findFirstTwoColumnBodyIndex(sorted, yTolerance, bodyColumnStarts);
  if (firstBodyIndex > 0 && bodyColumnStarts.length === 2) {
    // A column heading belongs with its column even above the first paired body row.
    const columnHeadingIndex = sorted.slice(0, firstBodyIndex).findIndex(line => isIndependentColumnHeading(line, bodyColumnStarts));
    if (columnHeadingIndex >= 0) firstBodyIndex = columnHeadingIndex;
  }
  if (firstBodyIndex > 1 && bodyColumnStarts.length === 2) {
    const previous = sorted[firstBodyIndex - 2];
    const caption = sorted[firstBodyIndex - 1];
    // A shifted caption starts the column body, not the page introduction.
    if (isProseLine(caption) && Math.abs(previous.y - caption.y) <= yTolerance
      && previous.right < caption.left
      && Math.abs(maximumLineHeight(previous) - maximumLineHeight(caption)) >= maximumLineHeight(caption) * 0.1) firstBodyIndex -= 1;
  }
  if (firstBodyIndex > 0) {
    const introLines = sorted.slice(0, firstBodyIndex);
    const bodyLines = sorted.slice(firstBodyIndex);
    const introductoryProse = isProseLine(introLines.at(-1));
    // A nearby picture caption must not interrupt the introductory paragraph.
    while (introductoryProse && introLines.length >= 2 && canJoinWrappedLine(introLines.at(-2), introLines.at(-1))
      && !/[.!?;:]$/u.test(introLines.at(-1).text)) {
      const continuation = bodyLines.findIndex(line => canJoinWrappedLine(introLines.at(-1), line));
      if (continuation < 0) break;
      introLines.push(...bodyLines.splice(continuation, 1));
    }
    return { introLines, bodyLines };
  }
  const introLines = [];
  let remaining = sorted;
  while (remaining.length > 2) {
    const [candidate, ...rest] = remaining;
    const columns = clusterColumns(rest);
    if (columns.length < 2 || lineBelongsToAnyColumn(candidate, columns, getColumnXTolerance(rest))) break;
    introLines.push(candidate);
    remaining = rest;
  }
  return { introLines, bodyLines: remaining };
}

function findFirstTwoColumnBodyIndex(sorted, yTolerance, bodyColumnStarts = []) {
  const typicalWidth = median(sorted.map((line) => line.right - line.left));
  const minimumLineWidth = sorted.length <= 6 ? 24 : 40;
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted.filter((line) => Math.abs(line.y - sorted[index].y) <= yTolerance)
      .filter((line) => line.right - line.left >= minimumLineWidth)
      .sort((a, b) => a.left - b.left);
    if (bodyColumnStarts.length === 2 && bodyColumnStarts.every((start) => (
      row.some((line) => Math.abs(line.left - start) <= 48)
    ))) return index;
    for (let column = 0; column < row.length - 1; column += 1) {
      if (row[column + 1].left - row[column].right > Math.max(80, typicalWidth * 0.35)) return index;
    }
  }
  return -1;
}

function lineBelongsToAnyColumn(line, columns, tolerance) {
  return columns.some((column) => Math.abs(column.left - line.left) <= tolerance || overlapRatio(column, line) >= 0.65);
}

function getColumnXTolerance(lines) {
  return Math.max(24, median(lines.map((line) => Math.max(1, line.right - line.left))) * 0.45);
}

function overlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const smaller = Math.max(1, Math.min(a.right - a.left, b.right - b.left));
  return overlap / smaller;
}

function isBridgeLine(line, typicalWidth) {
  const width = line.right - line.left;
  return typicalWidth > 0 && width > typicalWidth * 1.25 && width - typicalWidth > 48;
}

function mergeListContinuations(lines, observedWords) {
  const merged = [];
  for (const line of lines) {
    if (COPYRIGHT_NOTICE.test(line.text)) {
      merged.push({ ...line, role: 'metadata', parts: [...line.parts] });
      continue;
    }
    const previous = merged.at(-1);
    const verticalGap = previous ? (previous.lastContinuationY ?? previous.y) - line.y : Infinity;
    const horizontalIndent = previous ? line.left - previous.left : Infinity;
    const wrappedAcronymContinuation = previous?.role === 'paragraph'
      && line.role === 'list-item'
      && previous.text.endsWith('-')
      && verticalGap >= 0
      && verticalGap <= Math.max(28, previous.parts[0]?.height * 2)
      && Math.abs(horizontalIndent) <= Math.max(24, previous.parts[0]?.height * 2);
    if (wrappedAcronymContinuation) {
      previous.text = joinWrappedText(previous.text, line, previous, observedWords);
      previous.parts.push(...line.parts);
      previous.right = Math.max(previous.right, line.right);
      previous.speechText = previous.text;
      previous.lastContinuationY = line.y;
      continue;
    }
    if (previous?.role === 'list-item' && line.role === 'paragraph'
      && verticalGap >= 0
      && verticalGap <= Math.max(28, previous.parts[0]?.height * 2)
      && horizontalIndent >= 0
      && horizontalIndent <= Math.max(48, previous.parts[0]?.height * 4)) {
      previous.text = joinWrappedText(previous.text, line, previous, observedWords);
      previous.parts.push(...line.parts);
      previous.right = Math.max(previous.right, line.right);
      previous.speechText = previous.text;
      previous.lastContinuationY = line.y;
      continue;
    }
    merged.push({ ...line, parts: [...line.parts] });
  }
  return merged;
}

function canJoinWrappedLine(current, next) {
  if (current.role !== 'paragraph' || next.role !== 'paragraph') return false;
  if (current.vertical || next.vertical) return current.vertical && next.vertical && current.verticalRegion === next.verticalRegion;
  const currentHeight = Math.max(1, ...(current.parts || []).map((part) => Number(part.height) || 0));
  const verticalGap = current.y - next.y;
  const firstLineIndent = current.left - next.left;
  const sameColumn = Math.abs(firstLineIndent) <= Math.max(24, current.parts[0]?.height * 2)
    // Paragraph indents scale with the font, not a fixed point size.
    || (firstLineIndent > 0 && firstLineIndent <= currentHeight * 4 && overlapRatio(current, next) >= 0.8)
    || (!/[.!?;:]$/u.test(current.text) && isProseLine(current) && isProseLine(next)
      && Math.abs((current.left + current.right) - (next.left + next.right)) <= currentHeight
      && Math.abs(currentHeight - maximumLineHeight(next)) <= currentHeight * 0.1);
  const hyphenatedColumnContinuation = current.text.endsWith('-')
    && current.left < next.left
    && next.y > current.y
    && /^\p{L}/u.test(next.text);
  const deferredCaptionContinuation = next.crossColumnContinuation === true;
  if (!sameColumn && !hyphenatedColumnContinuation && !deferredCaptionContinuation) return false;
  if (hyphenatedColumnContinuation || deferredCaptionContinuation) return true;
  if (verticalGap < 0 || verticalGap > Math.max(22, currentHeight * 1.8)) return false;
  if (current.text.endsWith(',') && /^\p{Ll}/u.test(next.text)) return true;
  const ocrColumn = current.parts[0]?.ocrColumn;
  if (Number.isFinite(ocrColumn) && current.parts.every(part => part.ocrColumn === ocrColumn)
    && next.parts.every(part => part.ocrColumn === ocrColumn)
    && !/[.!?;:]$/u.test(current.text) && /^\p{Ll}/u.test(next.text)) return true;
  if (current.matrixNarrative && next.matrixNarrative
    && !/[.!?;:]$/u.test(current.text) && /^\p{Ll}/u.test(next.text)) return true;
  const previousPart = current.parts.at(-1);
  const nextPart = next.parts[0];
  if (previousPart?.hasEOL || nextPart?.wordBoundary === false || current.text.endsWith('-')) return true;
  const currentWidth = Math.max(1, current.right - current.left);
  const nextWidth = Math.max(1, next.right - next.left);
  return verticalGap <= Math.max(14, currentHeight * 1.45)
    && currentWidth >= nextWidth * 0.7
    && !/[.!?;:]$/u.test(current.text);
}

function joinWrappedText(currentText, nextLine, currentLine, observedWords) {
  if (currentLine.vertical && nextLine.vertical) return joinVerticalText(currentText, nextLine.text, true);
  const end = currentLine.parts.at(-1);
  const preceding = currentLine.parts.at(-2);
  const start = nextLine.parts[0];
  // A separate dash belongs to the wrapped word only in its own text column.
  if (end?.str === '-' && preceding && start
    && end.x - rightOf(preceding) >= -end.height * 0.1
    && end.x - rightOf(preceding) <= end.height * 0.05
    && Math.abs(preceding.x - start.x) <= Math.max(24, end.height * 2)
    && end.y >= start.y && end.y - start.y <= Math.max(28, end.height * 2)) {
    currentText = currentText.replace(/(\p{L})\s+-$/u, '$1-');
  }
  const nextText = nextLine.text;
  const nextFirstWord = nextText.match(/^\p{L}[\p{L}-]*/u)?.[0] || '';
  if (currentText.endsWith('-') && nextFirstWord) {
    return shouldPreserveLineEndHyphen(currentText, nextText, nextFirstWord, observedWords)
      ? `${currentText}${nextText}`
      : `${currentText.slice(0, -1)}${nextText}`;
  }
  if (nextLine.parts[0]?.wordBoundary === false) return `${currentText}${nextText}`;
  return `${currentText} ${nextText}`;
}

function getObservedWords(lines) {
  // Reuse a spelling printed on this page, rather than guessing new compound prefixes.
  return new Set(lines.flatMap(line => (line.parts || []).flatMap(part =>
    [...String(part.str || part.text || '').matchAll(/[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/gu)]
      .map(match => match[0].toLowerCase()))));
}

function shouldPreserveLineEndHyphen(currentText, nextText, nextFirstWord, observedWords) {
  const leftToken = currentText.match(/([\p{L}\p{N}]+)-$/u)?.[1] || '';
  if (!leftToken) return false;
  if (observedWords?.has(`${leftToken}-${nextFirstWord}`.toLowerCase())
    && !observedWords.has(`${leftToken}${nextFirstWord}`.toLowerCase())) return true;
  if (nextFirstWord.includes('-')) return true;
  if (/^[\p{Lu}\d]{2,}$/u.test(leftToken)
    && /^\p{Lu}(?:[).]|$)/u.test(nextText)
    && nextFirstWord.length === 1) return true;
  if (/^\p{Lu}{2,}$/u.test(leftToken) && /^\p{Ll}/u.test(nextText)) return true;
  if (/^\p{Lu}{2,}$/u.test(leftToken) && !/^\p{Lu}{2,}$/u.test(nextFirstWord)) return true;
  return /^(?:closed|cross|end|high|human|large|length|long|low|multi|open|real|short|single|state)$/iu.test(leftToken);
}

function repairSpacedHyphen(match, leftToken, nextToken, observedWords) {
  if (/^(?:approach|findings|purpose|value)$/iu.test(leftToken)) return `${leftToken}: ${nextToken}`;
  if (/^(?:a|an|and|by|for|in|of|on|or|the|to|with)$/iu.test(leftToken)
    || /^(?:and|but|or)$/iu.test(nextToken)) return `${leftToken} ${nextToken}`;
  if (/^\p{Lu}{2,}$/u.test(leftToken) && /^\p{Lu}{2,}/u.test(nextToken)) return `${leftToken}-${nextToken}`;
  return shouldPreserveLineEndHyphen(`${leftToken}-`, nextToken, nextToken, observedWords)
    ? `${leftToken}-${nextToken}`
    : `${leftToken}${nextToken}`;
}

function stripListPrefix(text) {
  return text.replace(BULLET_PREFIX, '').trim();
}

function stripTerminalPunctuation(text) {
  return text.replace(/[.!?;:]+$/u, '');
}

function withTerminal(text, terminal) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return /[.!?;:。！？：；]$/u.test(trimmed) ? trimmed : `${trimmed}${terminal}`;
}

function joinParts(parts) {
  return parts.map((part, index) => {
    const previous = parts[index - 1];
    const height = Math.min(previous?.height, part.height);
    const gap = part.x - (previous?.x + previous?.width);
    // ponytail: geometry-only repair for individual glyphs; ambiguous spacing stays intact.
    // Font switches can also split a word into touching multi-letter fragments.
    const singleGlyphs = /^\p{L}\p{M}*$/u.test(previous?.str) && /^\p{L}\p{M}*$/u.test(part.str);
    const touchingFragments = /\p{L}\p{M}*$/u.test(previous?.str ?? '') && /^\p{L}/u.test(part.str ?? '');
    const joined = previous && (singleGlyphs || touchingFragments)
      && height > 0 && height >= Math.max(previous.height, part.height) * 0.85
      && previous.width > 0 && part.width > 0
      && gap >= -height * 0.1 && gap <= height * (singleGlyphs ? 0.12 : 0.05)
      && Math.abs((previous.transform?.[5] ?? previous.y) - (part.transform?.[5] ?? part.y)) <= height * 0.15;
    return `${index && !joined ? ' ' : ''}${normalizeText(part.text ?? part.str)}`;
  }).join('').replace(/\s+/gu, ' ').trim();
}

function orderMatrixNarrative(lines, pageView) {
  const matrixParts = lines.flatMap((line) => line.parts.filter((part) => part.numericMatrix));
  if (!matrixParts.length) return lines;
  const height = median(matrixParts.map((part) => part.height));
  const top = Math.max(...matrixParts.map((part) => part.y)) + height * 2;
  const bottom = Math.min(...matrixParts.map((part) => part.y)) - height * 2;
  const band = lines.filter((line) => line.y <= top && line.y >= bottom);
  const narrative = band.filter((line) => getMeaningfulLineText(line, pageView)).map((line) => {
    const parts = line.parts.filter((part) => !part.numericMatrix);
    return { ...line, matrixNarrative: true, role: line.role === 'table-row' ? 'paragraph' : line.role,
      y: parts.reduce((sum, part) => sum + part.y, 0) / parts.length,
      left: Math.min(...parts.map((part) => part.x)), right: Math.max(...parts.map(rightOf)) };
  });
  const spoken = new Set(narrative.map((line) => line.originalIndex));
  return [
    ...lines.filter((line) => line.y > top),
    ...clusterColumns(narrative).sort((a, b) => a.left - b.left)
      .flatMap((column) => column.lines.sort((a, b) => b.y - a.y)),
    ...band.filter((line) => !spoken.has(line.originalIndex)),
    ...lines.filter((line) => line.y < bottom),
  ];
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    .replace(/\uFB05/g, 'ft')
    .replace(/\uFB06/g, 'st')
    .replace(/\u0152/g, 'OE')
    .replace(/\u0153/g, 'oe')
    .replace(/\u00C6/g, 'AE')
    .replace(/\u00E6/g, 'ae')
    .replace(/\s+/gu, ' ')
    .trim();
}

function rightOf(item) {
  return item.x + (item.width || estimateTextWidth(item.text, item.height));
}

function estimateTextWidth(text, height) {
  return normalizeText(text).length * Math.max(4, height * 0.5);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isRtlLine(parts) {
  let rtl = 0;
  let letters = 0;
  for (const part of parts) {
    if (part.dir === 'rtl') return true;
    for (const char of part.text || '') {
      if (!/\p{L}/u.test(char)) continue;
      letters += 1;
      const point = char.codePointAt(0);
      if ((point >= 0x0590 && point <= 0x05ff)
        || (point >= 0x0600 && point <= 0x06ff)
        || (point >= 0x0750 && point <= 0x077f)
        || (point >= 0x08a0 && point <= 0x08ff)) rtl += 1;
    }
  }
  return letters > 0 && rtl / letters >= RTL_LETTER_SHARE_THRESHOLD;
}
