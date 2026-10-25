import { findBestMatch, normalizeForSearch } from './highlight-search.js';
import { splitTextIntoWords, stripNonSpokenTokens, tokenizeSpokenWords } from './speech-tokenization.js';

import { TUNING_CONFIG } from './tuning-config.js';

export function chunkText(
  text,
  maxLen = TUNING_CONFIG.speechChunking.defaultMaxLength,
  options = {},
) {
  const { targetMinLen = TUNING_CONFIG.speechChunking.defaultTargetMinLength, initialMaxChunkLength = null, initialTargetMinLength = null } = options;
  if (Array.isArray(text)) return chunkSpeechItems(text, maxLen, { targetMinLen, initialMaxChunkLength, initialTargetMinLength });

  const sourceText = String(text || '');
  const paragraphs = sourceText
    .split(/\n+/)
    .map((paragraph) => stripNonSpokenTokens(paragraph).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const sourceBlocks = paragraphs.length > 0 ? paragraphs : [stripNonSpokenTokens(sourceText).replace(/\s+/g, ' ').trim()];
  return chunkNormalizedSpeechBlocks(sourceBlocks, maxLen, { targetMinLen, initialMaxChunkLength, initialTargetMinLength });
}

function chunkPreparedSpeechText(speech, maxLen, options = {}) {
  const normalized = normalizeSpeech(speech);
  if (!normalized) return [];
  return chunkNormalizedSpeechBlocks([normalized], maxLen, options);
}

function chunkNormalizedSpeechBlocks(
  sourceBlocks,
  maxLen,
  {
    targetMinLen = TUNING_CONFIG.speechChunking.defaultTargetMinLength,
    initialMaxChunkLength = null,
    initialTargetMinLength = null,
  } = {},
) {
  const chunks = [];
  const defaultTargetLength = normalizeTargetMinLen(targetMinLen, maxLen);

  for (const block of sourceBlocks) {
    const sentences = splitSentences(block);
    let buffer = '';

    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;

      const isFirstChunk = chunks.length === 0;
      const currentMaxLen = (isFirstChunk && Number.isFinite(initialMaxChunkLength) && Number(initialMaxChunkLength) > 0)
        ? Math.min(maxLen, Number(initialMaxChunkLength))
        : maxLen;
      const currentTargetLength = (isFirstChunk && Number.isFinite(initialTargetMinLength) && Number(initialTargetMinLength) > 0)
        ? normalizeTargetMinLen(initialTargetMinLength, currentMaxLen)
        : defaultTargetLength;

      if (sentence.length > currentMaxLen) {
        if (buffer.trim()) {
          chunks.push(buffer.trim());
          buffer = '';
        }
        chunks.push(...splitOversizedSentence(sentence, currentMaxLen, currentTargetLength));
        continue;
      }

      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= currentMaxLen && (!buffer || buffer.length < currentTargetLength)) {
        buffer = candidate;
        continue;
      }

      if (buffer) {
        chunks.push(buffer.trim());
        buffer = sentence;
        continue;
      }

      buffer = sentence;
    }

    if (buffer.trim()) chunks.push(buffer.trim());
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function splitSentences(text) {
  return splitSpeechSentences(text);
}

function splitOversizedSentence(sentence, maxLen, targetLength) {
  const clauses = splitClauseSegments(sentence);
  const segments = clauses.length > 1 ? clauses : splitWordsIntoChunks(sentence, maxLen);
  const chunks = [];
  let buffer = '';

  for (const segment of segments) {
    const parts = segment.length > maxLen ? splitWordsIntoChunks(segment, maxLen) : [segment];
    for (const part of parts) {
      const candidate = buffer ? `${buffer} ${part}` : part;
      if (candidate.length <= maxLen && (!buffer || buffer.length < targetLength)) {
        buffer = candidate;
        continue;
      }
      if (buffer) chunks.push(buffer);
      buffer = part;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [sentence];
}

function splitClauseSegments(sentence) {
  const value = String(sentence || '').replace(/\s+/g, ' ').trim();
  const segments = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (!isClauseSeparator(value[index])) continue;
    if (value[index] === ',' && /\p{N},\p{N}/u.test(value.slice(index - 1, index + 2))) continue;

    let end = index + 1;
    while (end < value.length && /["'\p{Pe}\p{Pf}]/u.test(value[end] || '')) end += 1;
    while (end < value.length && /\s/.test(value[end])) end += 1;

    const segment = value.slice(start, end).trim();
    if (segment) segments.push(segment);
    start = end;
    index = end - 1;
  }

  if (start < value.length) {
    const segment = value.slice(start).trim();
    if (segment) segments.push(segment);
  }

  return segments;
}

function isClauseSeparator(char) {
  return char === ',' || char === ';' || char === ':';
}

function splitWordsIntoChunks(text, maxLen) {
  const chunks = [];
  let buffer = '';

  for (const { text: word } of splitTextIntoWords(text, { mode: 'speech' })) {
    const candidate = buffer ? `${buffer} ${word}` : word;
    if (candidate.length <= maxLen) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }

    if (word.length <= maxLen) {
      buffer = word;
      continue;
    }

    chunks.push(...splitOversizedWord(word, maxLen));
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

function splitOversizedWord(word, maxLen) {
  const chunks = [];
  const size = Math.max(1, Math.trunc(Number(maxLen)) || 1);
  for (let index = 0; index < word.length; index += size) {
    chunks.push(word.slice(index, index + size));
  }
  return chunks;
}

export function splitSpeechSentences(text) {
  const value = String(text || '');
  const sentences = collectSentenceSegments(value);
  return sentences.length ? sentences : [value];
}

function collectSentenceSegments(value) {
  const sentences = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (!isSentenceTerminator(value[index])) continue;
    if (isDecimalPoint(value, index)) continue;
    if (isWordInternalPeriod(value, index)) continue;
    if (isAbbreviationPeriod(value, index)) continue;

    let end = index + 1;
    while (
      end < value.length
      && isSentenceTerminator(value[end])
      && !isDecimalPoint(value, end)
      && !isWordInternalPeriod(value, end)
      && !isAbbreviationPeriod(value, end)
    ) {
      end += 1;
    }

    while (end < value.length && /["'\p{Pe}\p{Pf}]/u.test(value[end] || '')) end += 1;
    while (end < value.length && /\s/.test(value[end])) end += 1;

    sentences.push(value.slice(start, end));
    start = end;
    index = end - 1;
  }

  if (start < value.length) sentences.push(value.slice(start));
  return sentences;
}

function isSentenceTerminator(char) {
  return char === '.'
    || char === '!'
    || char === '?';
}

function isDecimalPoint(value, index) {
  return value[index] === '.' && /\d/.test(value[index - 1] || '') && /\d/.test(value[index + 1] || '');
}

function isWordInternalPeriod(value, index) {
  return value[index] === '.'
    && /[\p{L}\p{N}]/u.test(value[index - 1] || '')
    && /[\p{L}\p{N}]/u.test(value[index + 1] || '');
}

function isAbbreviationPeriod(value, index) {
  if (value[index] !== '.') return false;
  const before = value.slice(0, index + 1);
  const after = value.slice(index + 1);

  if (/\bet al\.$/iu.test(before)) return true;
  if (/\b(?:e\.g|i\.e)\.$/iu.test(before)) return true;
  if (/\b(?:dr|mr|ms|mrs|prof|fig|figs|tab|tabs|eq|eqs|sec|secs|vs|approx|dept|vol|no|pp|p|ed|eds)\.$/iu.test(before)) {
    if (/^\s+[\p{Ll}\d]/u.test(after)) return true;
    if (/\b(?:dr|mr|ms|mrs|prof)\.$/iu.test(before) && /^\s+\p{Lu}/u.test(after)) return true;
    if (/\b(?:fig|figs|tab|tabs|eq|eqs|sec|secs|no|vol|pp|p)\.$/iu.test(before) && /^\s+\d/u.test(after)) return true;
  }
  return false;
}

function countWords(text) {
  return tokenizeSpokenWords(text).length;
}

function normalizeTargetMinLen(value, maxLen) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(Math.max(0, numeric), maxLen);
}

export function getInitialPreview(text) {
  const chunk = chunkText(text)[0];
  return typeof chunk === 'string' ? chunk : chunk?.text || chunk?.speech || '';
}

function chunkSpeechItems(items, maxLen, options = {}) {
  return items.flatMap((item) => {
    const speech = stripNonSpokenTokens(normalizeSpeech(item?.speech ?? item?.text));
    if (!speech) return [];

    let anchorSearchOffset = 0;
    let remainingPrefixWords = Number.isFinite(item?.speechPrefixWords)
      ? Math.max(0, Math.trunc(item.speechPrefixWords))
      : 0;
    let pdfSpeechWordOffset = getBaseDomWordOffset(item);
    let speechWordsBefore = 0;
    const speechChunks = chunkPreparedSpeechText(speech, maxLen, options);
    const anchorText = normalizeSpeech(item?.anchorText);
    return speechChunks.map((text) => {
      const chunkWordCount = countWords(text);
      const speechWordStart = speechWordsBefore;
      speechWordsBefore += chunkWordCount;
      const chunkPrefixWords = Math.min(remainingPrefixWords, chunkWordCount);
      remainingPrefixWords -= chunkPrefixWords;
      const anchoredSpeech = stripLeadingSpokenWords(text, chunkPrefixWords);
      const anchorMatch = anchoredSpeech
        ? getAnchorMatch(item, anchorText, anchoredSpeech, anchorSearchOffset)
        : null;
      if (anchorMatch) anchorSearchOffset = anchorMatch.end;
      const keepsStructuredAnchor = shouldKeepAnchorForSplit(speech, text)
        || Boolean(item?.anchorId && item?.anchorText);
      const { anchorId: itemAnchorId, globalDomWordStartIndex: itemGlobalDomWordStartIndex, ...rest } = item;
      const base = {
        ...rest,
        speech: text,
        text,
        anchorText: anchorMatch ? anchorText : keepsStructuredAnchor ? item.anchorText ?? null : text,
        speechPrefixWords: keepsStructuredAnchor ? chunkPrefixWords : 0,
      };
      if (keepsStructuredAnchor && itemAnchorId !== undefined) {
        base.anchorId = itemAnchorId;
      }
      if (anchorMatch) {
        base.domWordOffset = anchorMatch.wordOffset;
      } else if (keepsStructuredAnchor && chunkPrefixWords) {
        base.domWordOffset = getBaseDomWordOffset(item);
      }
      if (Array.isArray(item?.speechWordMap)) {
        base.speechWordMap = item.speechWordMap.slice(speechWordStart, speechWordStart + chunkWordCount);
      }
      if (item?.type === 'pdf-page') {
        base.domWordOffset = pdfSpeechWordOffset;
        pdfSpeechWordOffset += chunkWordCount;
      }
      if (Number.isFinite(Number(itemGlobalDomWordStartIndex)) && Number.isFinite(Number(base.domWordOffset))) {
        const itemDomWordOffset = getBaseDomWordOffset(item);
        const splitDelta = Math.max(0, Math.trunc(Number(base.domWordOffset)) - itemDomWordOffset);
        base.globalDomWordStartIndex = Math.max(0, Math.trunc(Number(itemGlobalDomWordStartIndex)) + splitDelta);
      }
      return base;
    });
  });
}

function normalizeSpeech(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldKeepAnchorForSplit(sourceSpeech, chunkSpeech) {
  return sourceSpeech === chunkSpeech;
}

function getAnchorMatch(item, anchorText, chunkSpeech, fromIndex) {
  const baseWordOffset = getBaseDomWordOffset(item);
  if (!item?.anchorId || !anchorText) return null;

  const start = anchorText.indexOf(chunkSpeech, Math.max(0, fromIndex));
  if (start !== -1) {
    return {
      end: start + chunkSpeech.length,
      wordOffset: baseWordOffset + countWords(anchorText.slice(0, start)),
    };
  }

  const spokenTokenMatch = getSpokenTokenAnchorMatch(anchorText, chunkSpeech, fromIndex, baseWordOffset);
  if (spokenTokenMatch) return spokenTokenMatch;

  return getNormalizedAnchorMatch(anchorText, chunkSpeech, fromIndex, baseWordOffset);
}

function stripLeadingSpokenWords(text, count) {
  if (!count) return text;
  const tokens = tokenizeSpokenWords(text);
  if (count >= tokens.length) return '';
  return text.slice(tokens[count].start).trim();
}

function getBaseDomWordOffset(item) {
  const offset = Number(item?.domWordOffset);
  return Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
}

function getSpokenTokenAnchorMatch(anchorText, chunkSpeech, fromIndex, baseWordOffset = 0) {
  const anchorTokens = tokenizeSpokenWords(anchorText);
  const chunkTokens = tokenizeSpokenWords(chunkSpeech);
  if (!anchorTokens.length || !chunkTokens.length || chunkTokens.length > anchorTokens.length) return null;

  const minStart = Math.max(0, Number(fromIndex) || 0);
  const firstTokenIndex = anchorTokens.findIndex((token) => token.end > minStart);
  const startAt = firstTokenIndex === -1 ? 0 : firstTokenIndex;
  const expected = chunkTokens.map((token) => normalizeForSearch(token.text));

  for (let index = startAt; index <= anchorTokens.length - chunkTokens.length; index += 1) {
    const actual = anchorTokens
      .slice(index, index + chunkTokens.length)
      .map((token) => normalizeForSearch(token.text));
    if (!actual.every((token, offset) => token === expected[offset])) continue;

    return {
      end: anchorTokens[index + chunkTokens.length - 1].end,
      wordOffset: baseWordOffset + index,
    };
  }

  return null;
}

function getNormalizedAnchorMatch(anchorText, chunkSpeech, fromIndex, baseWordOffset = 0) {
  const anchorIndex = buildNormalizedAnchorIndex(anchorText);
  const target = normalizeForSearch(chunkSpeech);
  const normalizedStart = getNormalizedOffsetForOriginalOffset(anchorIndex.map, fromIndex);
  const match = findBestMatch(anchorIndex.fullText, target, normalizedStart);
  if (!match) return null;

  const originalStart = anchorIndex.map[match.start] ?? 0;
  const originalEnd = (anchorIndex.map[Math.max(match.start, match.end - 1)] ?? originalStart) + 1;
  return {
    end: originalEnd,
    wordOffset: baseWordOffset + countWords(anchorText.slice(0, originalStart)),
  };
}

function buildNormalizedAnchorIndex(text) {
  let fullText = '';
  const map = [];
  let previousWasSpace = false;

  const append = (char, offset) => {
    fullText += char;
    map.push(offset);
  };

  for (let offset = 0; offset < text.length; offset += 1) {
    const char = normalizeSearchChar(text[offset]);
    if (!char) continue;

    if (/\s/.test(char)) {
      if (!previousWasSpace) {
        append(' ', offset);
        previousWasSpace = true;
      }
      continue;
    }

    append(char, offset);
    previousWasSpace = false;
  }

  return trimNormalizedAnchorIndex(removeSoftHyphenBreaksFromIndex({ fullText, map }));
}

function removeSoftHyphenBreaksFromIndex(index) {
  let fullText = '';
  const map = [];

  for (let indexPosition = 0; indexPosition < index.fullText.length; indexPosition += 1) {
    const char = index.fullText[indexPosition];
    if (char === '-') {
      let next = indexPosition + 1;
      while (next < index.fullText.length && /\s/.test(index.fullText[next])) {
        next += 1;
      }

      if (next > indexPosition + 1 && /\p{Ll}/u.test(index.fullText[next] || '')) {
        indexPosition = next - 1;
        continue;
      }
    }

    fullText += char;
    map.push(index.map[indexPosition]);
  }

  return { fullText, map };
}

function trimNormalizedAnchorIndex(index) {
  let start = 0;
  let end = index.fullText.length;
  while (start < end && /\s/.test(index.fullText[start])) start += 1;
  while (end > start && /\s/.test(index.fullText[end - 1])) end -= 1;
  return {
    fullText: index.fullText.slice(start, end),
    map: index.map.slice(start, end),
  };
}

function getNormalizedOffsetForOriginalOffset(map, originalOffset) {
  const offset = Math.max(0, Number(originalOffset) || 0);
  const normalizedOffset = map.findIndex((entry) => entry >= offset);
  return normalizedOffset === -1 ? map.length : normalizedOffset;
}

function normalizeSearchChar(char) {
  const normalized = String(char || '')
    .toLowerCase()
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/[â€“â€”]/g, '-');

  return /[\p{L}\p{M}\p{N}\p{P}\s]/u.test(normalized) ? normalized : '';
}
