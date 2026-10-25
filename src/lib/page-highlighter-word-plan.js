import { PDF_TEXT_LAYER_ORDER_ATTRIBUTE, PDF_TEXT_LAYER_NARRATED_ATTRIBUTE, PDF_TEXT_LAYER_NARRATION_ORDER_ATTRIBUTE } from './page-highlighter-dom-state.js';
import { tokenizeSpokenWords } from './speech-tokenization.js';

export function normalizeWordPlanEntry(entry) {
  const start = Number(entry?.start);
  const end = Number(entry?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const index = Number(entry?.index);
  const speechIndex = Number.isFinite(Number(entry?.speechIndex)) ? Math.trunc(Number(entry.speechIndex)) : null;
  const synthetic = Boolean(entry?.synthetic) || !Number.isFinite(index) || index < 0;
  return {
    ...entry,
    key: `speech:${speechIndex ?? `${index}:${start}:${end}`}`,
    index: Number.isFinite(index) ? Math.trunc(index) : -1,
    synthetic,
    start,
    end,
    highlightAt: Number.isFinite(Number(entry?.highlightAt)) ? Number(entry.highlightAt) : null,
    endAt: entry?.endAt != null && Number.isFinite(Number(entry.endAt)) ? Number(entry.endAt) : null,
  };
}

export function findMergedPdfFragmentMatch(domEntries, startIndex, target, normalizeWordToken, mergeRanges) {
  const ranges = [];
  let candidate = '';

  // A PDF may store every letter separately; the target length bounds the search.
  for (let offset = 0; offset < Math.max(4, target.length); offset += 1) {
    const entry = domEntries[startIndex + offset];
    if (!entry) break;
    ranges.push(entry.range);
    candidate += String(entry.text || '').replace(/-$/u, '');
    const normalized = normalizeWordToken(candidate);
    if (offset > 0 && normalized === target) {
      return {
        range: mergeRanges(ranges),
        nextIndex: startIndex + offset + 1,
      };
    }
    if (!target.startsWith(normalized)) break;
    if (target.startsWith(`${normalized}.`)) {
      if (entry.range.endContainer.nodeValue?.[entry.range.endOffset] === '.') {
        candidate += '.';
        const range = entry.range.cloneRange();
        range.setEnd(range.endContainer, range.endOffset + 1);
        ranges[ranges.length - 1] = range;
      } else if (domEntries[startIndex + offset + 1]) {
        // A decimal point can have its own span and therefore no spoken token.
        const next = domEntries[startIndex + offset + 1].range;
        const separator = entry.range.cloneRange();
        separator.setStart(entry.range.endContainer, entry.range.endOffset);
        separator.setEnd(next.startContainer, next.startOffset);
        if (/^\s*\.\s*$/u.test(separator.toString())) {
          candidate += '.';
          ranges.push(separator);
        }
      }
    }
  }

  return null;
}

export function getPdfNarrationChunkRanges(candidateRanges, text, options, normalizeWordToken, flattenRanges) {
  const offset = options.domWordOffset;
  if (options.pdfSelection || typeof text !== 'string'
    || !Number.isInteger(offset) || offset < 0 || typeof options.pdfNarration?.speech !== 'string'
    || !Array.isArray(options.pdfNarration?.narratedItemOrders)) return null;
  const tokens = tokenizeSpokenWords(text);
  const narrationTokens = tokenizeSpokenWords(options.pdfNarration.speech);
  if (!tokens.length || offset + tokens.length > narrationTokens.length) return null;

  const ranges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const expected = normalizeWordToken(tokens[index].text);
    if (!expected || normalizeWordToken(narrationTokens[offset + index].text) !== expected) return null;
    const fragments = flattenRanges([candidateRanges[offset + index]]);
    if (!fragments.length || fragments.some(range => range.collapsed)) return null;
    const actual = fragments.map(range => range.toString()).join('').replace(/\s+/gu, '');
    if (normalizeWordToken(actual) !== expected) return null;
    ranges.push(...fragments);
  }
  return ranges;
}

export function applyPdfNarration(element, narration) {
  if (typeof narration?.speech !== 'string' || !Array.isArray(narration.narratedItemOrders)) return null;
  // Document-level header filtering must also govern page word ranges.
  const narrated = new Map(narration.narratedItemOrders.map((itemOrder, order) => [itemOrder, order]));
  for (const span of element.querySelectorAll(`span[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`)) {
    const order = narrated.get(Number(span.getAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE)));
    const value = String(order !== undefined);
    if (span.getAttribute(PDF_TEXT_LAYER_NARRATED_ATTRIBUTE) !== value) {
      span.setAttribute(PDF_TEXT_LAYER_NARRATED_ATTRIBUTE, value);
    }
    const narrationOrder = order === undefined ? '' : String(order);
    if (span.getAttribute(PDF_TEXT_LAYER_NARRATION_ORDER_ATTRIBUTE) !== narrationOrder) {
      span.setAttribute(PDF_TEXT_LAYER_NARRATION_ORDER_ATTRIBUTE, narrationOrder);
    }
  }
  return narration.speech;
}

