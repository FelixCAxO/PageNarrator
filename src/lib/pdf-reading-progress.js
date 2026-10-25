// ponytail: page metadata is O(1); exact OCR word totals require scanning every page.
export function getPdfReadingProgress({ pageNumber, pageCount } = {}) {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
  const page = Math.min(pageCount, Math.max(1, Math.trunc(Number(pageNumber)) || 1));
  const remainingPages = pageCount - page;
  return {
    progressPercent: Math.floor(((page - 1) / pageCount) * 100),
    progressLabel: `Page ${page} of ${pageCount}`,
    remainingLabel: `${remainingPages} ${remainingPages === 1 ? 'page' : 'pages'} after this page`,
    remainingPages,
  };
}
