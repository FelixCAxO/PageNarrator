export const MAX_FALLBACK_SEARCH_TEXT_LENGTH = 250_000;
export const PDF_WORD_MATCH_LOOKAHEAD = 128;

const TEXT_BLOCK_SELECTOR = 'div, p, li, dt, dd, tr, th, td, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6, pre, [role="row"], [role="cell"], [role="columnheader"], [role="rowheader"]';

export function needsTextNodeSeparator(previous, node) {
  if (!previous) return false;
  if (previous.parentElement?.closest(TEXT_BLOCK_SELECTOR) !== node.parentElement?.closest(TEXT_BLOCK_SELECTOR)) return true;
  // Inline formatting joins words; explicit line breaks still separate them.
  let cursor = previous;
  while (cursor && cursor !== node) {
    if (cursor.firstChild) cursor = cursor.firstChild;
    else {
      while (cursor && !cursor.nextSibling) cursor = cursor.parentNode;
      cursor = cursor?.nextSibling;
    }
    if (cursor?.nodeName === 'BR') return true;
  }
  return false;
}

export function appendNormalizedNode(node, append) {
  let previousWasSpace = false;
  const value = node.nodeValue || '';

  for (let offset = 0; offset < value.length; offset += 1) {
    const char = normalizeSearchChar(value[offset]);
    if (!char) continue;

    if (/\s/.test(char)) {
      if (!previousWasSpace) {
        if (append(' ', { node, offset }) === false) return false;
        previousWasSpace = true;
      }
      continue;
    }

    if (append(char, { node, offset }) === false) return false;
    previousWasSpace = false;
  }

  return true;
}

export function normalizeSearchChar(char) {
  const normalized = String(char || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-');

  return /[\p{L}\p{M}\p{N}\p{P}\p{Sm}°\s]/u.test(normalized) ? normalized : '';
}
