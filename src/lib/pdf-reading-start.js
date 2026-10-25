import { MESSAGE_TYPES } from './message-types.js';
import { createLogger } from './logger.js';

export const PDF_READING_START_RETRY = Object.freeze({ attempts: 3, delayMs: 80 });
const pdfReadingStartLogger = createLogger('pdf-reading-start');

export async function getPdfReadingStartFromViewer(tab, {
  isPdfViewerUrl,
  sendPageMessage,
  afterFinishedRead = false,
} = {}) {
  if (!tab?.id || !isPdfViewerUrl?.(tab.url || '')) return null;
  const message = afterFinishedRead
    ? { type: MESSAGE_TYPES.GET_READING_START, afterFinishedRead: true }
    : { type: MESSAGE_TYPES.GET_READING_START };
  let response = null;
  try {
    response = await sendPageMessage?.(tab.id, message, PDF_READING_START_RETRY);
  } catch (error) {
    pdfReadingStartLogger.warn('Could not read PDF viewport start from viewer; falling back to URL state.', error);
    return null;
  }
  return response?.startPosition || null;
}

export function resolvePdfReadStartPage({
  activeTab = null,
  pdfReadingStart = null,
  shouldUseViewportStart = true,
  afterFinishedRead = false,
  getPdfStartPageFromTab = () => 1,
} = {}) {
  // The tab's #page= followed narration to where the finished read ended, so only a page the
  // viewer reports the reader moved to counts.
  if (afterFinishedRead) return normalizePositivePageNumber(pdfReadingStart?.pageNumber) || 1;
  if (!shouldUseViewportStart) return 1;

  const viewerPage = normalizePositivePageNumber(pdfReadingStart?.pageNumber);
  const tabPage = normalizePositivePageNumber(getPdfStartPageFromTab(activeTab));

  if (viewerPage > 1) return viewerPage;
  if (tabPage > 1) return tabPage;
  return viewerPage || tabPage || 1;
}

function normalizePositivePageNumber(value) {
  const page = Math.trunc(Number(value));
  return Number.isFinite(page) && page > 0 ? page : 0;
}
