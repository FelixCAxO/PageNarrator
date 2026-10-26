import { t } from './i18n.js';
// ponytail: page metadata is O(1); exact OCR word totals require scanning every page.
export function getPdfReadingProgress({ pageNumber, pageCount } = {}) {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
  const page = Math.min(pageCount, Math.max(1, Math.trunc(Number(pageNumber)) || 1));
  const remainingPages = pageCount - page;
  return {
    progressPercent: Math.floor(((page - 1) / pageCount) * 100),
    progressLabel: t("Page $1 of $2", [page, pageCount]),
    remainingLabel: remainingPages === 1 ? t('$1 page after this page', [remainingPages]) : t('$1 pages after this page', [remainingPages]),
    remainingPages,
  };
}
