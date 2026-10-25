const SPOKEN_WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[.'\u2019\-\u00ad][\p{L}\p{M}\p{N}]+)*/gu;
const CITATION_PATTERN = /\[\s*\d+(?:\s*(?:,|-|\u2013|\u2014)\s*\d+)*\s*\]/gu;
const PARENTHETICAL_PATTERN = /\([^)]*\)/gu;
const STANDALONE_PUNCTUATION_PATTERN = /(^|\s)([\p{P}]+)(?=\s|$)/gu;

export function tokenizeSpeechText(text) {
  const value = String(text || '');
  if (!value.trim()) return [];

  return [...value.matchAll(/\S+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function splitTextIntoWords(text, options = {}) {
  return options.mode === 'speech'
    ? tokenizeSpeechText(text)
    : tokenizeSpokenWords(text);
}

export function tokenizeSpokenWords(text, { includeNonSpoken = false } = {}) {
  const value = String(text || '');
  if (!value.trim()) return [];

  const nonSpokenRanges = includeNonSpoken ? [] : getNonSpokenRanges(value);
  return [...value.matchAll(SPOKEN_WORD_PATTERN)]
    .filter((match) => !overlapsRange(nonSpokenRanges, match.index, match.index + match[0].length))
    .map((match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }));
}

export function stripNonSpokenTokens(text) {
  const value = String(text || '').replace(/(?<=\p{L})\s+[–—]\s+(?=\p{L})/gu, ', ');
  if (!value.trim()) return '';

  const ranges = getNonSpokenRanges(value, { includeStandalonePunctuation: true });
  if (!ranges.length) return normalizeSpeechWhitespace(value);

  let stripped = '';
  let cursor = 0;
  for (const range of ranges) {
    stripped += value.slice(cursor, range.start);
    stripped += ' ';
    cursor = range.end;
  }
  stripped += value.slice(cursor);

  return normalizeSpeechWhitespace(stripped);
}

function getNonSpokenRanges(value, { includeStandalonePunctuation = false } = {}) {
  const ranges = [];
  addPatternRanges(ranges, value, CITATION_PATTERN);

  for (const match of value.matchAll(PARENTHETICAL_PATTERN)) {
    if (!isNonSpokenParenthetical(match[0])) continue;
    ranges.push(extendTrailingParentheticalPunctuation(value, {
      start: match.index,
      end: match.index + match[0].length,
    }));
  }

  if (includeStandalonePunctuation) {
    for (const match of value.matchAll(STANDALONE_PUNCTUATION_PATTERN)) {
      const prefixLength = match[1]?.length || 0;
      ranges.push({
        start: match.index + prefixLength,
        end: match.index + prefixLength + match[2].length,
      });
    }
  }

  return mergeRanges(ranges);
}

function addPatternRanges(ranges, value, pattern) {
  for (const match of value.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

function isNonSpokenParenthetical(value) {
  const inner = String(value || '').slice(1, -1).trim();
  return /^\/[^/\s]+(?:\s+[^/\s]+)*\/$/u.test(inner);
}

function extendTrailingParentheticalPunctuation(value, range) {
  let end = range.end;
  if (value[end] === ',') end += 1;
  return { ...range, end };
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}

function overlapsRange(ranges, start, end) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function normalizeSpeechWhitespace(value) {
  return String(value || '')
    .replace(/\s+([,;:!?]|\.(?![\p{L}\p{N}]))/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
