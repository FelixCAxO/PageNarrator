const ACTIVE_READING_STATES = new Set(['reading', 'paused']);

export function createPdfPageNavigation({
  source = '',
  state = '',
  chunks = [],
  currentChunk = 0,
  pageCount = 0,
  canLoadMorePages = false,
} = {}) {
  const loadedPages = getLoadedPdfPages(chunks);
  const visible = source === 'pdf' && ACTIVE_READING_STATES.has(state) && loadedPages.length > 0;
  if (!visible) return { visible: false };

  const currentPage = getCurrentPdfPage(chunks, currentChunk) || loadedPages[0];
  const firstPage = loadedPages[0];
  const lastLoadedPage = loadedPages.at(-1);
  const maxPage = Math.max(lastLoadedPage, normalizePositiveInteger(pageCount, lastLoadedPage));
  const nextLoadedPageIndex = findNextPdfPageStartIndex(chunks, currentChunk);

  return {
    visible: true,
    currentPage,
    firstPage,
    lastLoadedPage,
    maxPage,
    canJumpFirst: currentPage > firstPage,
    canSkipCurrentPage: nextLoadedPageIndex !== null || (canLoadMorePages && currentPage < maxPage),
    canGoToPage: true,
    inputValue: String(currentPage),
  };
}

export function getCurrentPdfPage(chunks = [], currentChunk = 0) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const safeIndex = clampIndex(currentChunk, chunks.length);

  for (let index = safeIndex; index >= 0; index -= 1) {
    const page = getChunkPageNumber(chunks[index]);
    if (page !== null) return page;
  }

  for (let index = safeIndex + 1; index < chunks.length; index += 1) {
    const page = getChunkPageNumber(chunks[index]);
    if (page !== null) return page;
  }

  return null;
}

export function findPdfPageStartIndex(chunks = [], pageNumber) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const targetPage = normalizePositiveInteger(pageNumber, 0);
  if (!targetPage) return null;

  const index = chunks.findIndex((chunk) => getChunkPageNumber(chunk) === targetPage);
  return index === -1 ? null : index;
}

export function findNextPdfPageStartIndex(chunks = [], currentChunk = 0) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const currentPage = getCurrentPdfPage(chunks, currentChunk);
  if (currentPage === null) return null;

  const startIndex = clampIndex(currentChunk, chunks.length);
  for (let index = startIndex + 1; index < chunks.length; index += 1) {
    const page = getChunkPageNumber(chunks[index]);
    if (page !== null && page > currentPage) return index;
  }

  return null;
}

function getLoadedPdfPages(chunks) {
  const pages = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const page = getChunkPageNumber(chunk);
    if (page !== null && pages.at(-1) !== page) pages.push(page);
  }
  return pages;
}

function getChunkPageNumber(chunk) {
  const value = typeof chunk === 'string' ? null : Number(chunk?.pageNumber);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function clampIndex(index, length) {
  const value = Number(index);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(value)));
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.trunc(numeric);
}
