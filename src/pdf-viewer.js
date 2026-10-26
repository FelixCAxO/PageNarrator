import { t, localizeDocument } from './lib/i18n.js';
import { renderPdfOcrTextLayer } from './lib/pdf-ocr-text-layer.js';
import { createLogger, createSuppressedErrorHandler } from './lib/logger.js';
import * as pdfjs from './pdf/pdf-engine.js';
import { createPdfOcr } from './lib/pdf-ocr.js';
import {
  annotatePdfTextLayer,
  configurePdfWorker,
  getPdfCMapUrl,
  getPdfDocumentParams,
  getPdfStandardFontDataUrl,
  getPdfStartPageFromUrl,
  getPdfSourceUrl,
  getPdfWasmUrl,
  iteratePdfSpeechChunks,
} from './lib/pdf-extraction.js';
import {
  createPdfPagePlaceholder,
  getPdfRenderWindowPageNumbers,
  createVirtualPdfPageRenderer,
} from './lib/pdf-viewer-rendering.js';
import { createPdfMemoryProfile } from './lib/pdf-memory-profile.js';
import { createPdfSelectionFromSelection } from './lib/pdf-selection.js';
import {
  PDF_FIT_PAGE,
  PDF_FIT_WIDTH,
  applyPdfViewportToPageElement,
  createPdfToolbarState,
  getPdfPageHash,
  getPdfPageViewport,
  getPdfToolbarView,
  updatePdfToolbarState,
} from './lib/pdf-viewer-toolbar.js';
import { createPageHighlighter } from './lib/page-highlighter.js';
import { classifyPdfLoadError, isPdfWorkerTerminatedError } from './lib/pdf-viewer-errors.js';
import { createPdfViewerMessageHandler } from './lib/pdf-viewer-message-handler.js';
import { getPdfDisplayTitle } from './lib/pdf-document-title.js';
import { normalizePositive } from './lib/number-validation.js';

const pdfViewerLogger = createLogger('pdf-viewer');
localizeDocument(document);
function loadedPagesLabel(count) {
  return count === 1 ? t('$1 page loaded', [count]) : t('$1 pages loaded', [count]);
}
const suppressPdfViewerError = createSuppressedErrorHandler(pdfViewerLogger, 'Best-effort PDF viewer operation failed.');
const pagesEl = document.getElementById('pdf-pages');
const statusEl = document.getElementById('pdf-status');
const pdfOcr = createPdfOcr({ onStatus: (text) => {
  statusEl.textContent = text || loadedPagesLabel(pdfDocument?.numPages || 0);
} });
const PDF_PAGE_SESSION_STORAGE_PREFIX = 'pagenarrator-pdf-last-page:';
// Report every 5% change in a page's visible share, not only entering and leaving, so the
// recorded areas used to pick the current page stay current while pages scroll.
const PAGE_VISIBILITY_THRESHOLDS = Array.from({ length: 21 }, (_, index) => index / 20);

function getPdfPageStorageKey(sourceUrl) {
  return `${PDF_PAGE_SESSION_STORAGE_PREFIX}${sourceUrl || ''}`;
}

function saveSavedPdfPage(sourceUrl, pageNumber) {
  try {
    if (!sourceUrl || !pageNumber) return;
    sessionStorage?.setItem?.(getPdfPageStorageKey(sourceUrl), String(pageNumber));
  } catch {
    // restricted storage context fallback
  }
}

function getSavedPdfPage(sourceUrl) {
  try {
    if (!sourceUrl) return 0;
    const value = sessionStorage?.getItem?.(getPdfPageStorageKey(sourceUrl));
    const page = Number.parseInt(value || '', 10);
    return Number.isFinite(page) && page > 0 ? page : 0;
  } catch {
    return 0;
  }
}

function getInitialPdfStartPage(sourceUrl) {
  const urlPage = getPdfStartPageFromUrl(location.href);
  if (urlPage > 1) return urlPage;
  const savedPage = getSavedPdfPage(sourceUrl);
  return savedPage > 1 ? savedPage : 1;
}

const toolbarEls = {
  toolbar: document.getElementById('pdf-toolbar'),
  pageInput: document.getElementById('pdf-page-input'),
  pageCount: document.getElementById('pdf-page-count'),
  zoomOut: document.getElementById('pdf-zoom-out-btn'),
  zoomLabel: document.getElementById('pdf-zoom-label'),
  zoomIn: document.getElementById('pdf-zoom-in-btn'),
  rotateLeft: document.getElementById('pdf-rotate-left-btn'),
  rotateRight: document.getElementById('pdf-rotate-right-btn'),
  fitWidth: document.getElementById('pdf-fit-width-btn'),
  fitPage: document.getElementById('pdf-fit-page-btn'),
};
let pdfMemoryProfile = createPdfMemoryProfile({ navigatorRef: navigator });
let currentHighlightSettings = null;
let highlighter = createPdfHighlighter(pdfMemoryProfile);
let pdfDocument = null;
let pdfLoadingTask = null;
let pdfReadyPromise = null;
let pdfRepairPromise = null;
let lastSelectionStartPosition = null;
let lastPdfSelection = null;
const initialPdfSourceUrl = getPdfSourceUrl({ url: location.href });
let pdfToolbarState = createPdfToolbarState({ currentPage: getInitialPdfStartPage(initialPdfSourceUrl) });
let toolbarBound = false;
let visiblePageUpdateScheduled = false;
let layoutRefreshPromise = Promise.resolve();
let activePdfHighlightRequest = null;
let activePdfWordIndex = null;
let lastNarratedPageNumber = 0;
const pdfChunkStreams = new Map();
const pageElements = new Map();
const pageBaseViewports = new Map();
const visiblePageIntersections = new Map();
let pdfRenderer = createPdfRenderer(pdfMemoryProfile);
let pageObserver = createPageObserver();
let pdfViewerTornDown = false;
let renderWindowPromise = Promise.resolve();
let layoutRefreshAnchorPageNumber = 0;
let pdfViewerInstanceToken = createPdfViewerInstanceToken();

configurePdfWorker(pdfjs, { runtime: chrome.runtime });
bindPdfToolbar();
renderPdfToolbar();
window.addEventListener('pagehide', teardownPdfViewerResources, { once: true });

document.addEventListener('selectionchange', () => {
  const pdfSelection = getCurrentPdfSelection();
  if (!pdfSelection?.text) return;
  lastPdfSelection = pdfSelection;
  lastSelectionStartPosition = getSelectionStartPosition(pdfSelection);
});

chrome.runtime.onMessage.addListener(createPdfViewerMessageHandler({
  readyPromise: () => pdfReadyPromise,
  getReadingStartPosition,
  getPdfSelection,
  getStreamMetadata: () => ({
    ok: true,
    title: document.title || '',
    url: getPdfSourceUrl({ url: location.href }),
    pageCount: Math.max(0, Math.trunc(Number(pdfDocument?.numPages) || 0)),
    // Page progress is available immediately; a full word census would delay narration.
    totalReadableWordCount: 0,
    instanceToken: pdfViewerInstanceToken,
  }),
  getPdfChunk,
  closePdfChunkStream,
  teardown: teardownPdfViewerResources,
  highlighter: () => highlighter,
  getWordTrailLength: () => pdfMemoryProfile.pdfWordTrailLength,
  setCurrentHighlightSettings(value) {
    currentHighlightSettings = value;
  },
  ensureHighlightedPageRendered,
  setActiveHighlight(request) {
    activePdfHighlightRequest = request;
    activePdfWordIndex = null;
    const pageNumber = getAnchorPageNumber(request.anchorId);
    if (pageNumber) lastNarratedPageNumber = pageNumber;
    if (pageNumber && pageNumber !== pdfToolbarState.currentPage) {
      pdfToolbarState = updatePdfToolbarState(pdfToolbarState, { type: 'setPage', pageNumber });
      renderPdfToolbar();
      const pageEl = pageElements.get(pageNumber);
      if (pageEl) {
        pageEl.style.scrollMarginTop = `${document.querySelector('.viewer-header').getBoundingClientRect().height + 16}px`;
        pageEl.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    }
  },
  setActiveWordIndex(index) {
    activePdfWordIndex = index;
  },
  clearActiveHighlight() {
    activePdfHighlightRequest = null;
    activePdfWordIndex = null;
  },
  syncProtectedPdfHighlightPages,
  reconcilePdfRenderWindow,
  getCurrentPage: () => pdfToolbarState.currentPage,
  onError: suppressPdfViewerError,
}));

pdfReadyPromise = renderPdf().catch((error) => {
  pdfViewerLogger.error('PDF viewer failed to render document.', error);
  const recovery = classifyPdfLoadError(error);
  if (!statusEl.textContent || statusEl.textContent === t("Loading document...") || statusEl.textContent === t("Loading PDF...")) {
    statusEl.textContent = recovery.message;
  }
  throw error;
});

async function repairPdfDocument(reason = 'worker-crash') {
  if (pdfViewerTornDown) return;
  if (pdfRepairPromise) return pdfRepairPromise;

  pdfViewerLogger.warn(`Initiating PDF viewer self-repair (${reason})...`);
  const previousStatus = statusEl.textContent;
  statusEl.textContent = t("Reopening PDF...");

  pdfRepairPromise = (async () => {
    const savedPage = pdfToolbarState.currentPage || 1;
    const savedHighlight = activePdfHighlightRequest;
    const savedWordIndex = activePdfWordIndex;

    closeAllPdfChunkStreams();
    pageObserver?.disconnect?.();
    pdfRenderer?.destroy?.();

    const oldDoc = pdfDocument;
    const oldLoading = pdfLoadingTask;
    pdfDocument = null;
    pdfLoadingTask = null;
    Promise.resolve(oldDoc?.destroy?.()).catch(suppressPdfViewerError);
    Promise.resolve(oldLoading?.destroy?.()).catch(suppressPdfViewerError);

    configurePdfWorker(pdfjs, { runtime: chrome.runtime });
    pdfReadyPromise = renderPdf({ targetPage: savedPage });
    await pdfReadyPromise;

    if (savedHighlight) {
      activePdfHighlightRequest = savedHighlight;
      activePdfWordIndex = savedWordIndex;
      restoreActivePdfHighlight();
      syncProtectedPdfHighlightPages();
      await reconcilePdfRenderWindow(savedPage);
    }
    if (statusEl.textContent === t("Reopening PDF...")) {
      statusEl.textContent = previousStatus || loadedPagesLabel(pdfDocument?.numPages || 0);
    }
  })().finally(() => {
    pdfRepairPromise = null;
  });

  return pdfRepairPromise;
}

function setPdfDisplayTitle(title) {
  document.title = title;
  const heading = document.querySelector('h1');
  if (heading) heading.textContent = title;
}

function applyPdfDisplayTitle(pdf, sourceUrl) {
  setPdfDisplayTitle(getPdfDisplayTitle({ sourceUrl }));
  Promise.resolve(pdf.getMetadata?.())
    .then(({ info } = {}) => {
      if (pdfDocument !== pdf) return;
      setPdfDisplayTitle(getPdfDisplayTitle({ metadataTitle: info?.Title, sourceUrl }));
    })
    .catch(suppressPdfViewerError);
}

async function renderPdf({ targetPage = null } = {}) {
  if (pdfViewerTornDown) return;
  pdfViewerInstanceToken = createPdfViewerInstanceToken();

  const sourceUrl = getPdfSourceUrl({ url: location.href });
  if (!sourceUrl || sourceUrl === location.href) throw new Error('No PDF source URL found.');

  statusEl.textContent = t("Loading PDF...");
  const wasmUrl = getPdfWasmUrl(chrome.runtime);
  const cMapUrl = getPdfCMapUrl(chrome.runtime);
  const standardFontDataUrl = getPdfStandardFontDataUrl(chrome.runtime);

  const documentParams = getPdfDocumentParams(sourceUrl, {
    runtime: chrome.runtime,
    wasmUrl,
    cMapUrl,
    standardFontDataUrl,
  }) || {
    url: sourceUrl,
    withCredentials: false,
    useSystemFonts: true,
    enableScripting: false,
    wasmUrl,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
  };
  pdfLoadingTask = pdfjs.getDocument(documentParams);
  const pdf = await pdfLoadingTask.promise;
  if (pdfViewerTornDown) {
    await pdf.destroy?.();
    return;
  }
  pdfDocument = pdf;
  applyPdfMemoryProfile(createPdfMemoryProfile({
    navigatorRef: navigator,
    pageCount: pdf.numPages,
  }));
  pdfToolbarState = updatePdfToolbarState(pdfToolbarState, { type: 'setPageCount', pageCount: pdf.numPages });
  if (targetPage && Number.isFinite(targetPage) && targetPage > 0) {
    pdfToolbarState = updatePdfToolbarState(pdfToolbarState, {
      type: 'setPage',
      pageNumber: Math.min(pdf.numPages, targetPage),
    });
  }
  renderPdfToolbar();
  applyPdfDisplayTitle(pdf, sourceUrl);

  statusEl.textContent = loadedPagesLabel(pdf.numPages);
  pageElements.clear();
  pageBaseViewports.clear();
  visiblePageIntersections.clear();
  const estimatedPageViewport = await getEstimatedPdfPageLayoutViewport(pdf);
  if (pdfViewerTornDown) return;
  const pageFragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (pdfViewerTornDown) return;
    const pageEl = createPdfPagePlaceholder(document, pageNumber, estimatedPageViewport);
    pageElements.set(pageNumber, pageEl);
    pageFragment.append(pageEl);
    observePage(pageEl);
  }
  pagesEl.replaceChildren(pageFragment);

  scrollInitialPageIntoView();
  await reconcilePdfRenderWindow(pdfToolbarState.currentPage);
  scheduleVisiblePageUpdate();
}

async function getPdfChunk(message = {}) {
  await pdfReadyPromise;
  if (!pdfDocument) throw new Error('PDF document is not ready.');
  assertCurrentPdfViewerInstance(message.instanceToken);

  const streamId = getPdfChunkStreamId(message.streamId);
  let stream = pdfChunkStreams.get(streamId);
  if (!stream) {
    stream = {
      instanceToken: pdfViewerInstanceToken,
      iterator: iteratePdfSpeechChunks(pdfDocument, {
        recognizePage: pdfOcr.recognizePage,
        startPage: message.startPage,
        maxLen: message.speechChunkOptions?.maxLen,
        targetMinLen: message.speechChunkOptions?.targetMinLen,
        pdfjs,
      })[Symbol.asyncIterator](),
      pendingPromise: Promise.resolve(),
    };
    pdfChunkStreams.set(streamId, stream);
  }
  if (stream.instanceToken !== pdfViewerInstanceToken) throw createStalePdfStreamError();

  if (stream.done) {
    pdfChunkStreams.delete(streamId);
    return { ok: true, done: true };
  }

  const count = getPdfChunkRequestCount(message);
  const nextPromise = stream.pendingPromise.then(
    () => readPdfChunkBatch(stream, count),
    () => readPdfChunkBatch(stream, count),
  );
  stream.pendingPromise = nextPromise.catch(suppressPdfViewerError);

  try {
    const batch = await nextPromise;
    if (!batch.chunks.length) {
      pdfChunkStreams.delete(streamId);
      return { ok: true, done: true };
    }
    if (batch.done) stream.done = true;
    if (batch.chunks.length === 1) return { ok: true, done: false, value: batch.chunks[0] };
    return { ok: true, done: false, chunks: batch.chunks };
  } catch (chunkError) {
    if (isPdfWorkerTerminatedError(chunkError)) {
      await repairPdfDocument('worker-terminated-chunk');
      return getPdfChunk({ ...message, instanceToken: pdfViewerInstanceToken });
    }
    throw chunkError;
  }
}

async function readPdfChunkBatch(stream, count) {
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const next = await stream.iterator.next();
    if (next.done) return { done: true, chunks };
    chunks.push(next.value);
  }
  return { done: false, chunks };
}

function getPdfChunkRequestCount(message = {}) {
  const count = Math.trunc(Number(message.count ?? message.maxChunks));
  return Number.isFinite(count) && count > 0 ? count : 1;
}

async function closePdfChunkStream(streamId, { instanceToken = null } = {}) {
  assertCurrentPdfViewerInstance(instanceToken);
  const key = getPdfChunkStreamId(streamId);
  const stream = pdfChunkStreams.get(key);
  if (!stream) return;
  pdfChunkStreams.delete(key);
  await stream.iterator.return?.();
}

function closeAllPdfChunkStreams() {
  const streams = [...pdfChunkStreams.values()];
  pdfChunkStreams.clear();
  for (const stream of streams) {
    Promise.resolve(stream.iterator.return?.()).catch((error) => pdfViewerLogger.error('Could not close PDF chunk stream.', error));
  }
}

function getPdfChunkStreamId(value) {
  const streamId = String(value || '').trim();
  return streamId || 'default';
}

function assertCurrentPdfViewerInstance(instanceToken) {
  if (instanceToken && instanceToken === pdfViewerInstanceToken) return;
  throw createStalePdfStreamError();
}

function createStalePdfStreamError() {
  const error = new Error('PDF viewer stream is stale. Please restart reading this PDF.');
  error.code = 'stale_pdf_stream';
  return error;
}

function createPdfViewerInstanceToken() {
  return `pdf-viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function teardownPdfViewerResources() {
  if (pdfViewerTornDown) return;
  pdfViewerTornDown = true;
  void pdfOcr.destroy().catch(suppressPdfViewerError);

  closeAllPdfChunkStreams();
  activePdfHighlightRequest = null;
  activePdfWordIndex = null;
  lastPdfSelection = null;
  lastSelectionStartPosition = null;
  pdfChunkStreams.clear();
  pageObserver?.disconnect?.();
  pdfRenderer.destroy?.();
  pdfRenderer.setProtectedPageNumbers?.([]);
  highlighter?.dispose?.();
  highlighter?.clearHighlights?.();
  pagesEl?.replaceChildren?.();
  pageElements.clear();
  pageBaseViewports.clear();
  visiblePageIntersections.clear();

  const documentToDestroy = pdfDocument;
  const loadingTaskToDestroy = pdfLoadingTask;
  pdfDocument = null;
  pdfLoadingTask = null;

  Promise.resolve(documentToDestroy?.destroy?.()).catch((error) => pdfViewerLogger.error('Could not destroy PDF document.', error));
  Promise.resolve(loadingTaskToDestroy?.destroy?.()).catch((error) => pdfViewerLogger.error('Could not destroy PDF loading task.', error));
}

function createPdfHighlighter(profile = pdfMemoryProfile) {
  const instance = createPageHighlighter(document, {
    pdfMode: true,
    defaultWordTrailLength: profile.pdfWordTrailLength,
    showQueuedRegion: profile.showQueuedPdfRegion,
    preferCssOnlyRegion: profile.preferCssOnlyPdfRegion,
  });
  if (currentHighlightSettings) instance.setHighlightSettings(currentHighlightSettings);
  return instance;
}

function createPdfRenderer(profile = pdfMemoryProfile) {
  return createVirtualPdfPageRenderer({
    documentRef: document,
    windowRef: window,
    pdfjs,
    getPageViewport: getRenderPageViewport,
    annotateTextLayer: annotatePdfTextLayer,
    renderOcrTextLayer: (pageEl, page, viewport) =>
      renderPdfOcrTextLayer(pageEl, pdfOcr.getItems(page.pageNumber), viewport, page.view),
    maxRenderedPages: profile.maxRenderedPages,
    unloadDelayMs: profile.unloadDelayMs,
  });
}

function applyPdfMemoryProfile(profile) {
  pdfMemoryProfile = profile;
  highlighter?.dispose?.();
  highlighter = createPdfHighlighter(profile);
  pdfRenderer.destroy?.();
  pdfRenderer = createPdfRenderer(profile);
  syncProtectedPdfHighlightPages();
  pageObserver?.disconnect?.();
  pageObserver = createPageObserver();
}

async function ensureHighlightedPageRendered(anchorId) {
  const pageNumber = getAnchorPageNumber(anchorId);
  if (!pageNumber) return;

  await pdfReadyPromise;
  const pageEl = pageElements.get(pageNumber) || document.querySelector(`[data-pagenarrator-id="pdf-page-${pageNumber}"]`);
  if (!pdfDocument || !pageEl) return;
  try {
    await pdfRenderer.ensurePageRendered(pdfDocument, pageEl, pageNumber);
    if (pdfOcr.hasPage(pageNumber)) {
      const page = await pdfDocument.getPage(pageNumber);
      const items = await pdfOcr.recognizePage(page);
      renderPdfOcrTextLayer(pageEl, items, getRenderPageViewport(page), page.view);
    }
  } catch (renderError) {
    if (isPdfWorkerTerminatedError(renderError)) {
      await repairPdfDocument('worker-terminated-render');
      const refreshedPageEl = pageElements.get(pageNumber) || document.querySelector(`[data-pagenarrator-id="pdf-page-${pageNumber}"]`);
      if (pdfDocument && refreshedPageEl) {
        await pdfRenderer.ensurePageRendered(pdfDocument, refreshedPageEl, pageNumber);
      }
      return;
    }
    throw renderError;
  }
}

function getAnchorPageNumber(anchorId) {
  const match = String(anchorId || '').match(/^pdf-page-(\d+)$/);
  if (!match) return 0;
  const pageNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(pageNumber) ? pageNumber : 0;
}

function getReadingStartPosition({ readSelection = false, afterFinishedRead = false } = {}) {
  highlighter.cancelPendingScroll();
  if (readSelection) return getCurrentSelectionStartPosition() || lastSelectionStartPosition;
  const position = getPreferredPageStartPosition();
  // Narration leaves the viewer on the page a finished read ended on; only a page the reader
  // moved to since then is a start. Otherwise the reader engine restarts from page 1.
  if (afterFinishedRead && (!position || position.pageNumber === lastNarratedPageNumber)) return null;
  return position;
}

function getPreferredPageStartPosition() {
  const visiblePosition = getVisiblePageStartPosition();
  if (isDeepPageStartPosition(visiblePosition)) return visiblePosition;

  const hashPosition = getHashPageStartPosition();
  if (isDeepPageStartPosition(hashPosition)) return hashPosition;

  return getToolbarPageStartPosition() || visiblePosition || hashPosition;
}

function isDeepPageStartPosition(position) {
  const pageNumber = Number(position?.pageNumber);
  return Number.isFinite(pageNumber) && pageNumber > 1;
}

function getPdfSelection() {
  const pdfSelection = getCurrentPdfSelection();
  if (pdfSelection?.text) {
    lastPdfSelection = pdfSelection;
    lastSelectionStartPosition = getSelectionStartPosition(pdfSelection);
    return pdfSelection;
  }
  return lastPdfSelection;
}

function getCurrentPdfSelection() {
  return createPdfSelectionFromSelection(window.getSelection?.(), {
    documentRef: document,
    pageCount: pdfDocument?.numPages || pdfToolbarState.pageCount,
  });
}

function getCurrentSelectionStartPosition() {
  return getSelectionStartPosition(getCurrentPdfSelection());
}

function getSelectionStartPosition(pdfSelection) {
  if (!pdfSelection?.text || !pdfSelection?.pageNumber) return null;
  return {
    source: 'selection',
    text: pdfSelection.text,
    pageNumber: pdfSelection.pageNumber,
    anchorId: pdfSelection.anchorId || `pdf-page-${pdfSelection.pageNumber}`,
    pageCount: Math.max(0, Math.trunc(Number(pdfSelection.pageCount) || 0)),
  };
}

function getToolbarPageStartPosition() {
  const pageNumber = Math.trunc(Number(pdfToolbarState.currentPage));
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
  return {
    source: 'page',
    pageNumber,
    anchorId: `pdf-page-${pageNumber}`,
  };
}

function getVisiblePageStartPosition() {
  const candidates = [...visiblePageIntersections.entries()]
    .map(([pageNumber, intersection]) => ({
      pageNumber,
      area: intersection.area,
      top: intersection.top,
    }))
    .filter((candidate) => candidate.area > 0)
    .sort((a, b) => {
      if (b.area !== a.area) return b.area - a.area;
      return a.top - b.top;
    });

  const pageNumber = candidates[0]?.pageNumber;
  if (!pageNumber) return null;

  return {
    source: 'viewport',
    pageNumber,
    anchorId: `pdf-page-${pageNumber}`,
  };
}

function getHashPageStartPosition() {
  const pageNumber = getPdfStartPageFromUrl(location.href);
  if (pageNumber <= 1) return null;

  return {
    source: 'page',
    pageNumber,
    anchorId: `pdf-page-${pageNumber}`,
  };
}

function scrollInitialPageIntoView() {
  const pageNumber = pdfToolbarState.currentPage || getPdfStartPageFromUrl(location.href);
  if (pageNumber <= 1) return;

  requestAnimationFrame(() => {
    pageElements.get(pageNumber)?.scrollIntoView?.({ block: 'start' });
  });
}

function getPageNumberFromElement(pageEl) {
  const pageNumber = Number(pageEl?.dataset?.pageNumber);
  return Number.isFinite(pageNumber) && pageNumber > 0 ? Math.trunc(pageNumber) : 0;
}

function bindPdfToolbar() {
  if (toolbarBound || !toolbarEls.toolbar) return;
  toolbarBound = true;

  toolbarEls.pageInput?.addEventListener('change', goToToolbarPage);
  toolbarEls.pageInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    goToToolbarPage();
  });
  toolbarEls.zoomOut?.addEventListener('click', () => applyToolbarAction({ type: 'zoomOut' }, { refreshLayout: true }));
  toolbarEls.zoomIn?.addEventListener('click', () => applyToolbarAction({ type: 'zoomIn' }, { refreshLayout: true }));
  toolbarEls.rotateLeft?.addEventListener('click', () => applyToolbarAction({ type: 'rotateCounterClockwise' }, { refreshLayout: true }));
  toolbarEls.rotateRight?.addEventListener('click', () => applyToolbarAction({ type: 'rotateClockwise' }, { refreshLayout: true }));
  toolbarEls.fitWidth?.addEventListener('click', () => applyToolbarAction({ type: 'setFitMode', fitMode: PDF_FIT_WIDTH }, { refreshLayout: true }));
  toolbarEls.fitPage?.addEventListener('click', () => applyToolbarAction({ type: 'setFitMode', fitMode: PDF_FIT_PAGE }, { refreshLayout: true }));
  window.addEventListener('scroll', scheduleVisiblePageUpdate, { passive: true });
  window.addEventListener('resize', () => scheduleLayoutRefresh(), { passive: true });
}

function goToToolbarPage() {
  const pageNumber = Number.parseInt(toolbarEls.pageInput?.value || '', 10);
  if (!Number.isFinite(pageNumber)) {
    renderPdfToolbar({ forcePageInputValue: true });
    return;
  }
  // A jump makes the pages seen so far stale; the observer reports the new ones after the scroll.
  highlighter.cancelPendingScroll();
  if (pageNumber !== pdfToolbarState.currentPage) visiblePageIntersections.clear();
  applyToolbarAction({ type: 'setPage', pageNumber }, { updateHash: true });
  renderPdfToolbar({ forcePageInputValue: true });
  pageElements.get(pdfToolbarState.currentPage)?.scrollIntoView?.({ block: 'start' });
}

function applyToolbarAction(action, { updateHash = false, refreshLayout = false } = {}) {
  const previous = pdfToolbarState;
  pdfToolbarState = updatePdfToolbarState(pdfToolbarState, action);
  const pageChanged = pdfToolbarState.currentPage !== previous.currentPage;
  renderPdfToolbar();

  const sourceUrl = getPdfSourceUrl({ url: location.href });
  saveSavedPdfPage(sourceUrl, pdfToolbarState.currentPage);

  if (updateHash || pageChanged) {
    updateLocationPageHash(pdfToolbarState.currentPage);
  }
  if (pageChanged) void reconcilePdfRenderWindow(pdfToolbarState.currentPage);
  if (refreshLayout) scheduleLayoutRefresh({ anchorPageNumber: pdfToolbarState.currentPage });
}

function renderPdfToolbar({ forcePageInputValue = false } = {}) {
  if (!toolbarEls.toolbar) return;
  const view = getPdfToolbarView(pdfToolbarState);
  for (const control of toolbarEls.toolbar.querySelectorAll('button, input')) {
    control.disabled = view.pageCount === 0;
  }
  if (toolbarEls.zoomOut) toolbarEls.zoomOut.disabled = !view.pageCount || !view.canZoomOut;
  if (toolbarEls.zoomIn) toolbarEls.zoomIn.disabled = !view.pageCount || !view.canZoomIn;
  if (toolbarEls.pageInput && (forcePageInputValue || document.activeElement !== toolbarEls.pageInput)) {
    toolbarEls.pageInput.value = String(view.currentPage);
  }
  if (toolbarEls.pageInput) {
    toolbarEls.pageInput.min = '1';
    toolbarEls.pageInput.max = String(Math.max(1, view.pageCount || 1));
    updatePdfPageInputA11y(view);
  }
  if (toolbarEls.pageCount) toolbarEls.pageCount.textContent = `/ ${view.pageCount || 1}`;
  if (toolbarEls.zoomLabel) toolbarEls.zoomLabel.textContent = view.zoomLabel;
  toolbarEls.fitWidth?.setAttribute('aria-pressed', String(view.fitMode === PDF_FIT_WIDTH));
  toolbarEls.fitPage?.setAttribute('aria-pressed', String(view.fitMode === PDF_FIT_PAGE));
}

function updatePdfPageInputA11y(view) {
  if (!toolbarEls.pageInput) return;
  toolbarEls.pageInput.setAttribute('aria-label', t("Page $1 of $2", [view.currentPage || 1, view.pageCount || 1]));
}

function scheduleVisiblePageUpdate() {
  if (layoutRefreshAnchorPageNumber) return;
  if (visiblePageUpdateScheduled) return;
  visiblePageUpdateScheduled = true;
  requestAnimationFrame(() => {
    if (layoutRefreshAnchorPageNumber) {
      visiblePageUpdateScheduled = false;
      return;
    }
    visiblePageUpdateScheduled = false;
    const position = getVisiblePageStartPosition();
    if (!position?.pageNumber || position.pageNumber === pdfToolbarState.currentPage) return;
    applyToolbarAction({ type: 'setPage', pageNumber: position.pageNumber }, { updateHash: true });
  });
}

function scheduleLayoutRefresh({ anchorPageNumber = pdfToolbarState.currentPage } = {}) {
  if (!pdfDocument) return;
  const normalizedAnchorPageNumber = normalizePdfPageNumber(anchorPageNumber);
  layoutRefreshAnchorPageNumber = normalizedAnchorPageNumber;
  const run = async () => {
    try {
      await refreshPdfLayout(normalizedAnchorPageNumber);
    } finally {
      if (layoutRefreshAnchorPageNumber === normalizedAnchorPageNumber) {
        layoutRefreshAnchorPageNumber = 0;
      }
    }
  };
  layoutRefreshPromise = layoutRefreshPromise
    .then(run, run)
    .catch((error) => pdfViewerLogger.error('PDF layout refresh failed.', error));
}

async function refreshPdfLayout(anchorPageNumber = pdfToolbarState.currentPage) {
  refreshEstimatedPdfPlaceholderLayout();
  await reconcilePdfRenderWindow(anchorPageNumber, { force: true });
  restorePdfLayoutAnchor(anchorPageNumber);
  restoreActivePdfHighlight();
}

function restorePdfLayoutAnchor(pageNumber) {
  const anchorPageNumber = normalizePdfPageNumber(pageNumber);
  if (!anchorPageNumber) return;

  visiblePageIntersections.clear();
  pdfToolbarState = updatePdfToolbarState(pdfToolbarState, { type: 'setPage', pageNumber: anchorPageNumber });
  renderPdfToolbar();
  updateLocationPageHash(anchorPageNumber);
  requestAnimationFrame(() => {
    pageElements.get(anchorPageNumber)?.scrollIntoView?.({ block: 'start' });
  });
}

function restoreActivePdfHighlight() {
  if (!activePdfHighlightRequest) return;
  const result = highlighter.highlightChunkByAnchor(activePdfHighlightRequest.anchorId, activePdfHighlightRequest.text, {
    chunkText: activePdfHighlightRequest.chunkText,
    domWordOffset: activePdfHighlightRequest.domWordOffset,
    ...(activePdfHighlightRequest.pdfNarration ? { pdfNarration: activePdfHighlightRequest.pdfNarration } : {}),
    preserveWordPlan: true,
    ...(activePdfHighlightRequest.pdfSelection ? { pdfSelection: true } : {}),
  });
  if (result?.ok && activePdfWordIndex !== null) {
    highlighter.highlightWord(activePdfWordIndex, pdfMemoryProfile.pdfWordTrailLength);
  }
}

function syncProtectedPdfHighlightPages() {
  const pageNumber = getAnchorPageNumber(activePdfHighlightRequest?.anchorId);
  pdfRenderer.setProtectedPageNumbers?.(pageNumber ? [pageNumber] : []);
}

function reconcilePdfRenderWindow(centerPage, { force = false } = {}) {
  if (!pdfDocument || pdfViewerTornDown) return Promise.resolve();

  const windowPageNumbers = getPdfRenderWindowPageNumbers(centerPage, {
    pageCount: pdfToolbarState.pageCount || pdfDocument.numPages,
    preloadBehind: pdfMemoryProfile.preloadBehind,
    preloadAhead: pdfMemoryProfile.preloadAhead,
  });
  const protectedPageNumber = getAnchorPageNumber(activePdfHighlightRequest?.anchorId);
  const retainedPageNumbers = new Set(windowPageNumbers);
  if (protectedPageNumber) retainedPageNumbers.add(protectedPageNumber);
  const targetPageNumbers = [...retainedPageNumbers].sort((a, b) => a - b);

  const run = async () => {
    if (!pdfDocument || pdfViewerTornDown) return;

    for (const pageNumber of pdfRenderer.getRenderedPageNumbers()) {
      if (force || !retainedPageNumbers.has(pageNumber)) {
        if (force) {
          pdfRenderer.unloadPage(pageNumber, { force: true });
        } else {
          pdfRenderer.unloadPage(pageNumber);
        }
      }
    }

    for (const pageNumber of targetPageNumbers) {
      if (!pdfDocument || pdfViewerTornDown) return;
      const pageEl = pageElements.get(pageNumber);
      if (!pageEl) continue;
      await pdfRenderer.ensurePageRendered(pdfDocument, pageEl, pageNumber);
    }

    for (const pageNumber of pdfRenderer.getRenderedPageNumbers()) {
      if (!retainedPageNumbers.has(pageNumber)) {
        pdfRenderer.unloadPage(pageNumber);
      }
    }
  };

  renderWindowPromise = renderWindowPromise.then(run, run).catch((error) => pdfViewerLogger.error('PDF render window failed.', error));
  return renderWindowPromise;
}

function updateLocationPageHash(pageNumber) {
  if (location.hash === getPdfPageHash(pageNumber)) return;
  history.replaceState(null, '', getPdfPageHash(pageNumber));
}

function getRenderPageViewport(page) {
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = getPdfPageViewport(baseViewport, pdfToolbarState, getViewportContainerSize());
  return page.getViewport({ scale: viewport.scale, rotation: viewport.rotation });
}

async function getPdfPageLayoutViewport(pdf, pageNumber) {
  const baseViewport = await getPdfPageBaseViewport(pdf, pageNumber);
  return getPdfPageViewport(baseViewport, pdfToolbarState, getViewportContainerSize());
}

async function getEstimatedPdfPageLayoutViewport(pdf) {
  const samplePageNumber = getEstimatedPdfPageNumber(pdf);
  const cachedBaseViewport = pageBaseViewports.get(samplePageNumber) || pageBaseViewports.values().next().value;
  if (cachedBaseViewport) return getPdfPageViewport(cachedBaseViewport, pdfToolbarState, getViewportContainerSize());
  return getPdfPageLayoutViewport(pdf, samplePageNumber);
}

function refreshEstimatedPdfPlaceholderLayout() {
  const baseViewport = getEstimatedPdfPageBaseViewport();
  const pageViewport = getPdfPageViewport(baseViewport, pdfToolbarState, getViewportContainerSize());
  for (const pageEl of pageElements.values()) {
    applyPdfViewportToPageElement(pageEl, pageViewport);
  }
}

function getEstimatedPdfPageBaseViewport() {
  const samplePageNumber = getEstimatedPdfPageNumber(pdfDocument);
  return pageBaseViewports.get(samplePageNumber) || pageBaseViewports.values().next().value || { width: 612, height: 792 };
}

function getEstimatedPdfPageNumber(pdf) {
  const pageCount = Math.max(0, Math.trunc(Number(pdf?.numPages) || 0));
  const currentPage = Math.max(1, Math.trunc(Number(pdfToolbarState.currentPage)) || 1);
  return pageCount > 0 ? Math.min(currentPage, pageCount) : currentPage;
}

function normalizePdfPageNumber(value) {
  const pageNumber = Math.trunc(Number(value));
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return 0;
  const pageCount = Math.max(0, Math.trunc(Number(pdfToolbarState.pageCount || pdfDocument?.numPages) || 0));
  return pageCount > 0 ? Math.min(pageNumber, pageCount) : pageNumber;
}

async function getPdfPageBaseViewport(pdf, pageNumber) {
  const normalizedPageNumber = Math.trunc(Number(pageNumber));
  if (!Number.isFinite(normalizedPageNumber) || normalizedPageNumber < 1) {
    return { width: 1, height: 1 };
  }

  const cached = pageBaseViewports.get(normalizedPageNumber);
  if (cached) return cached;

  const page = await pdf.getPage(normalizedPageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const baseViewport = {
      width: normalizePositive(viewport.width, 1),
      height: normalizePositive(viewport.height, 1),
      rotation: viewport.rotation || 0,
      ...(viewport.userUnit && viewport.userUnit !== 1 ? { userUnit: viewport.userUnit } : {}),
    };
    pageBaseViewports.set(normalizedPageNumber, baseViewport);
    return baseViewport;
  } finally {
    page.cleanup?.();
  }
}

function getViewportContainerSize() {
  const headerHeight = document.querySelector('.viewer-header')?.getBoundingClientRect?.().height || 0;
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 960,
    height: Math.max(320, (window.innerHeight || document.documentElement.clientHeight || 720) - headerHeight),
    padding: 40,
  };
}

function createPageObserver() {
  return new IntersectionObserver((entries) => {
    let hasVisiblePageChange = false;
    for (const entry of entries) {
      const pageNumber = getPageNumberFromElement(entry.target);
      if (!pageNumber) continue;
      if (entry.isIntersecting) {
        updateVisiblePageIntersection(pageNumber, entry);
        hasVisiblePageChange = true;
      } else {
        visiblePageIntersections.delete(pageNumber);
        hasVisiblePageChange = true;
      }
    }
    if (hasVisiblePageChange) scheduleVisiblePageUpdate();
  }, { rootMargin: `${pdfMemoryProfile.rootMarginPx}px 0px`, threshold: PAGE_VISIBILITY_THRESHOLDS });
}

function observePage(pageEl) {
  pageObserver.observe(pageEl);
}

function updateVisiblePageIntersection(pageNumber, entry) {
  const rect = entry.intersectionRect || {};
  const fallbackRect = entry.boundingClientRect || {};
  const width = Math.max(0, Number(rect.width) || (Number(rect.right) - Number(rect.left)) || 0);
  const height = Math.max(0, Number(rect.height) || (Number(rect.bottom) - Number(rect.top)) || 0);
  const area = width * height;
  if (area <= 0) {
    visiblePageIntersections.delete(pageNumber);
    return;
  }
  visiblePageIntersections.set(pageNumber, {
    area,
    top: Number(fallbackRect.top) || 0,
  });
}
