import { findStartChunkIndexByText, normalizeStartText } from './reading-start.js';

export function createResumePosition({
  article = {},
  chunks = [],
  chunk,
  total,
  now = Date.now,
} = {}) {
  if (!Array.isArray(chunks) || !Number.isFinite(chunk) || !Number.isFinite(total)) return null;
  const safeChunk = Math.trunc(chunk);
  const safeTotal = Math.trunc(total);
  if (safeChunk <= 0 || safeChunk >= safeTotal) return null;

  const currentChunk = chunks[safeChunk];
  const pageNumber = currentChunk?.pageNumber || null;
  const anchorId = currentChunk?.anchorId || (pageNumber ? `pdf-page-${pageNumber}` : null);
  const domWordOffset = currentChunk?.domWordOffset ?? null;
  const pageCount = Number(article?.pageCount);
  let progressPercent = Math.round((safeChunk / safeTotal) * 100);
  if (pageNumber && Number.isFinite(pageCount) && pageCount > 0) {
    progressPercent = Math.min(100, Math.max(1, Math.round((pageNumber / pageCount) * 100)));
  }

  return {
    chunk: safeChunk,
    totalChunks: safeTotal,
    progressPercent,
    excerpt: getChunkSpeechText(currentChunk).slice(0, 160),
    title: String(article?.title || '').trim(),
    ...(pageNumber ? { pageNumber } : {}),
    ...(anchorId ? { anchorId } : {}),
    ...(domWordOffset !== null && domWordOffset !== undefined ? { domWordOffset } : {}),
    ...(article?.source ? { source: article.source } : {}),
    ts: typeof now === 'function' ? now() : Date.now(),
  };
}

export function getSavedResumeChunk(saved, chunks = []) {
  if (!saved || !Array.isArray(chunks) || chunks.length <= 1) return 0;

  const chunk = Number(saved.chunk);
  const total = Number(saved.totalChunks);
  if (!Number.isFinite(chunk) || chunk <= 0) return 0;

  const safeChunk = Math.trunc(chunk);
  // Excerpts below the matcher's minimum length cannot prove or disprove a position.
  const verifiable = normalizeStartText(saved.excerpt).length >= 12;
  if (safeChunk < chunks.length && Number.isFinite(total) && Math.trunc(total) === chunks.length
    && (!verifiable || findStartChunkIndexByText([chunks[safeChunk]], saved.excerpt) === 0)) {
    return safeChunk;
  }

  const excerptIndex = findStartChunkIndexByText(chunks, saved.excerpt);
  if (excerptIndex > 0 && excerptIndex < chunks.length) return excerptIndex;

  if (saved.anchorId || saved.pageNumber) {
    const anchorIndex = chunks.findIndex((c) => (saved.anchorId && c?.anchorId === saved.anchorId) || (saved.pageNumber && c?.pageNumber === saved.pageNumber));
    if (anchorIndex > 0 && anchorIndex < chunks.length) return anchorIndex;
  }

  // A verifiable excerpt that matches nowhere means the text changed: start from the top.
  return !verifiable && safeChunk < chunks.length ? safeChunk : 0;
}

function getChunkSpeechText(chunk) {
  if (typeof chunk === 'string') return chunk;
  return chunk?.speech || chunk?.text || '';
}
