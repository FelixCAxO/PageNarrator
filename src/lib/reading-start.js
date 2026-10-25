import { findBestMatch, normalizeForSearch } from './highlight-search.js';

export function findStartChunkIndex(chunks = [], startPosition = null, { fallbackIndex = -1 } = {}) {
  if (!Array.isArray(chunks) || !chunks.length || !startPosition) return fallbackIndex;

  // The anchor pins the exact DOM block, so repeated text elsewhere (a chat prompt sent twice)
  // cannot pull the start earlier; text still picks the right split chunk inside that block.
  const anchorId = String(startPosition.anchorId || '');
  const anchorIndex = anchorId
    ? chunks.findIndex((chunk) => typeof chunk !== 'string' && chunk?.anchorId === anchorId)
    : -1;
  if (anchorIndex !== -1) {
    let anchorEnd = anchorIndex + 1;
    while (anchorEnd < chunks.length && chunks[anchorEnd]?.anchorId === anchorId) anchorEnd += 1;
    const textInAnchor = findStartChunkIndexByText(chunks.slice(anchorIndex, anchorEnd), startPosition.text);
    return textInAnchor === -1 ? anchorIndex : anchorIndex + textInAnchor;
  }

  const textIndex = findStartChunkIndexByText(chunks, startPosition.text);
  if (textIndex !== -1) return textIndex;

  const pageNumber = Number(startPosition.pageNumber);
  if (Number.isFinite(pageNumber) && pageNumber > 0) {
    const pageIndex = chunks.findIndex((chunk) => Number(chunk?.pageNumber) === Math.trunc(pageNumber));
    if (pageIndex !== -1) return pageIndex;
  }

  return fallbackIndex;
}

export function findStartChunkIndexByText(chunks = [], text = '') {
  const target = normalizeStartText(text);
  if (target.length < 12) return -1;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = normalizeForSearch(getChunkSpeechText(chunks[index]));
    if (!chunkText) continue;

    if (chunkText.includes(target) || target.includes(chunkText)) return index;

    const leadingTarget = target.slice(0, Math.min(target.length, 180));
    if (leadingTarget.length >= 12 && findBestMatch(chunkText, leadingTarget, 0)) return index;
  }

  return -1;
}

export function normalizeStartText(value = '') {
  return normalizeForSearch(String(value || '').replace(/\s+/g, ' ').trim());
}

function getChunkSpeechText(chunk) {
  return typeof chunk === 'string' ? chunk : chunk?.speech || chunk?.text || '';
}
