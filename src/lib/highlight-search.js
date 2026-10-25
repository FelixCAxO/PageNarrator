import { tokenizeSpokenWords } from './speech-tokenization.js';

export function normalizeForSearch(value, { normalizeSoftHyphenBreaks = true } = {}) {
  return String(value || '')
    .toLowerCase()
    .replace(/-\s+(?=\p{Ll})/gu, match => normalizeSoftHyphenBreaks ? '' : match)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Sm}°\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findBestMatch(fullText, target, fromIndex = 0) {
  if (!fullText || !target) return null;

  const exact = findExactOrPrefixMatch(fullText, target, fromIndex);
  if (exact) return exact;

  return findTokenWindowMatch(fullText, target, fromIndex, {
    scanChars: 6000,
    minScore: 0.82,
  });
}

function findExactOrPrefixMatch(fullText, target, fromIndex = 0) {
  const startAt = Math.max(0, Math.min(fromIndex, fullText.length));
  const exactStart = fullText.indexOf(target, startAt);
  if (exactStart !== -1) {
    return { start: exactStart, end: exactStart + target.length };
  }

  const maxLength = Math.min(target.length, 520);
  const lengths = [maxLength, 420, 320, 240, 180, 120, 80].filter((length) => length >= 80);

  for (const length of lengths) {
    const snippet = target.slice(0, length).trim();
    const start = fullText.indexOf(snippet, startAt);
    if (start !== -1) {
      return { start, end: start + snippet.length };
    }
  }

  return null;
}

function findTokenWindowMatch(fullText, target, fromIndex, { scanChars, minScore }) {
  const targetTokens = tokenizeWithPositions(target);
  if (targetTokens.length < 8) return null;

  const startAt = Math.max(0, Math.min(fromIndex, fullText.length));
  const scanEnd = Math.min(fullText.length, startAt + scanChars);
  const fullTokens = tokenizeWithPositions(fullText)
    .filter((token) => token.end > startAt && token.start < scanEnd);
  if (fullTokens.length < targetTokens.length - 2) return null;

  const minWindow = Math.max(4, targetTokens.length - 2);
  const maxWindow = Math.min(fullTokens.length, targetTokens.length + 4);
  let best = null;

  for (let start = 0; start < fullTokens.length; start += 1) {
    for (let size = minWindow; size <= maxWindow && start + size <= fullTokens.length; size += 1) {
      const window = fullTokens.slice(start, start + size);
      const score = scoreTokenWindow(window, targetTokens);
      if (score < minScore || (best && score <= best.score)) continue;
      best = {
        score,
        start: window[0].start,
        end: window.at(-1).end,
      };
    }
  }

  return best ? { start: best.start, end: best.end } : null;
}

function tokenizeWithPositions(text) {
  return tokenizeSpokenWords(text);
}

function scoreTokenWindow(windowTokens, targetTokens) {
  const available = new Map();
  for (const token of windowTokens) {
    available.set(token.text, (available.get(token.text) || 0) + 1);
  }

  let overlap = 0;
  for (const token of targetTokens) {
    const remaining = available.get(token.text) || 0;
    if (remaining <= 0) continue;
    overlap += 1;
    available.set(token.text, remaining - 1);
  }

  const dice = (overlap * 2) / (windowTokens.length + targetTokens.length);
  const ordered = getOrderedTokenOverlap(windowTokens, targetTokens) / targetTokens.length;
  return dice * 0.45 + ordered * 0.55;
}

function getOrderedTokenOverlap(windowTokens, targetTokens) {
  let windowIndex = 0;
  let overlap = 0;
  for (const targetToken of targetTokens) {
    while (windowIndex < windowTokens.length && windowTokens[windowIndex].text !== targetToken.text) {
      windowIndex += 1;
    }
    if (windowIndex >= windowTokens.length) break;
    overlap += 1;
    windowIndex += 1;
  }
  return overlap;
}
