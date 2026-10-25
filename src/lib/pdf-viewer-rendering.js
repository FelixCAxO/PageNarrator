import {
  normalizeNonNegativeInteger,
  normalizePositive,
  normalizePositiveInteger,
} from './number-validation.js';
import { PDF_RENDER_UNLOAD_DELAY_MS } from './timing-config.js';

export const MAX_RENDERED_PAGES = 7;
export const MAX_OUTPUT_SCALE = 1;
// Explicit viewer backing-store policy; these are not PDF or browser limits.
export const MAX_RENDER_CANVAS_PIXELS = 32_000_000;
export const MAX_RENDER_CANVAS_SIDE = 16_384;
const UNLOAD_DELAY_MS = PDF_RENDER_UNLOAD_DELAY_MS;

export function getCappedOutputScale(devicePixelRatio, maxOutputScale = MAX_OUTPUT_SCALE) {
  const scale = Number(devicePixelRatio);
  const maxScale = normalizePositive(maxOutputScale, MAX_OUTPUT_SCALE);
  if (!Number.isFinite(scale) || scale <= 0) return Math.min(1, maxScale);
  return Math.min(scale, maxScale);
}

export function getPdfRenderWindowPageNumbers(centerPage, {
  pageCount = 0,
  preloadBehind = 2,
  preloadAhead = 2,
} = {}) {
  const totalPages = Math.max(0, Math.trunc(Number(pageCount)) || 0);
  const normalizedCenter = normalizePageNumber(centerPage) || 1;
  const clampedCenter = totalPages > 0 ? Math.min(normalizedCenter, totalPages) : normalizedCenter;
  const behind = normalizePreloadDistance(preloadBehind);
  const ahead = normalizePreloadDistance(preloadAhead);
  const firstPage = Math.max(1, clampedCenter - behind);
  const lastPage = totalPages > 0
    ? Math.min(totalPages, clampedCenter + ahead)
    : clampedCenter + ahead;

  const pageNumbers = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
    pageNumbers.push(pageNumber);
  }
  return pageNumbers;
}

export function createPdfPagePlaceholder(documentRef, pageNumber, viewport) {
  const pageEl = documentRef.createElement('section');
  pageEl.className = 'pdf-page';
  pageEl.dataset.pageNumber = String(pageNumber);
  pageEl.dataset.pagenarratorId = `pdf-page-${pageNumber}`;
  applyPageViewportStyles(pageEl, viewport);
  return pageEl;
}

export function applyPageViewportStyles(pageEl, viewport = {}) {
  if (!pageEl?.style) return pageEl;
  pageEl.style.setProperty('--total-scale-factor', String((viewport.scale || 1) * (viewport.userUnit ?? 1)));
  pageEl.style.setProperty('--scale-round-x', '1px');
  pageEl.style.setProperty('--scale-round-y', '1px');
  pageEl.style.width = `${Math.floor(viewport.width)}px`;
  pageEl.style.height = `${Math.floor(viewport.height)}px`;
  return pageEl;
}

export function createVirtualPdfPageRenderer({
  documentRef = document,
  windowRef = window,
  pdfjs,
  maxRenderedPages = MAX_RENDERED_PAGES,
  maxOutputScale = MAX_OUTPUT_SCALE,
  unloadDelayMs = UNLOAD_DELAY_MS,
  getPageScale = defaultGetPageScale,
  getPageViewport = null,
  annotateTextLayer = null,
  renderOcrTextLayer = null,
} = {}) {
  const renderedPages = new Map();
  const unloadTimers = new Map();
  const renderedPageLimit = normalizeRenderedPageLimit(maxRenderedPages);
  const canvasPool = [];
  const maxCanvasPoolSize = Math.max(1, Math.min(3, renderedPageLimit));
  let protectedPageNumbers = new Set();

  async function ensurePageRendered(pdf, pageEl, pageNumber) {
    clearUnloadTimer(pageNumber);
    const existing = renderedPages.get(pageNumber);
    if (existing) return existing.promise;

    evictPageIfNeeded(pageNumber);

    const record = { page: null, pageNumber, pageEl, cleaned: false, renderTask: null, textLayerTask: null, promise: null, canvas: null };
    renderedPages.set(pageNumber, record);

    record.promise = (async () => {
      const page = await pdf.getPage(pageNumber);
      record.page = page;
      if (renderedPages.get(pageNumber) !== record) {
        cleanupRecordPage(record);
        return null;
      }
      await renderPageInto(page, pageEl, record);
    })().catch((error) => {
      if (renderedPages.get(pageNumber) === record) {
        renderedPages.delete(pageNumber); disposeRecord(record);
      } else cleanupRecordPage(record);
      if (error?.name === 'RenderingCancelledException') return null;
      throw error;
    });
    return record.promise;
  }

  function cleanupRecordPage(record) {
    if (record.page && !record.cleaned) { record.cleaned = true; record.page.cleanup?.(); }
  }
  function disposeRecord(record) {
    record.renderTask?.cancel?.(); record.textLayerTask?.cancel?.(); cleanupRecordPage(record);
    releaseRenderCanvas(record.canvas); record.canvas = null; record.pageEl.replaceChildren();
  }

  async function renderPageInto(page, pageEl, record, retryCount = 0) {
    const checkCurrent = () => { if (renderedPages.get(record.pageNumber) !== record) { const error = new Error('PDF page rendering cancelled.'); error.name = 'RenderingCancelledException'; throw error; } };
    const viewport = typeof getPageViewport === 'function'
      ? getPageViewport(page, windowRef)
      : page.getViewport({ scale: getPageScale(page, windowRef) });
    const outputScale = getCappedOutputScale(windowRef.devicePixelRatio, maxOutputScale);
    const canvasWidth = Math.floor(viewport.width * outputScale), canvasHeight = Math.floor(viewport.height * outputScale);
    if (typeof page.render === 'function' && (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight)
      || canvasWidth < 1 || canvasHeight < 1 || canvasWidth > MAX_RENDER_CANVAS_SIDE || canvasHeight > MAX_RENDER_CANVAS_SIDE
      || !Number.isSafeInteger(canvasWidth * canvasHeight) || canvasWidth * canvasHeight > MAX_RENDER_CANVAS_PIXELS)) {
      const error = new RangeError('PDF page backing canvas limit exceeded.'); error.code = 'pdf_limit'; throw error;
    }

    applyPageViewportStyles(pageEl, viewport);

    if (typeof page.render !== 'function') {
      const textContent = await page.getTextContent();
      checkCurrent();
      if (pageEl.childElementCount > 0) return;
      const textLayerEl = documentRef.createElement('div');
      textLayerEl.className = 'textLayer';
      pageEl.replaceChildren(textLayerEl);
      const textLayer = new pdfjs.TextLayer({
        page,
        textContentSource: textContent,
        container: textLayerEl,
        viewport,
      });
      record.textLayerTask = textLayer;
      await textLayer.render();
      checkCurrent();
      annotateTextLayer?.(textLayerEl, textContent.items, { pageView: page.view, pageRotation: page.rotate || 0 });
      return;
    }

    let canvas = acquireRenderCanvas();
    record.canvas = canvas;
    let context = canvas.getContext('2d');
    if (!context || context.isContextLost?.()) {
      canvas = documentRef.createElement('canvas');
      record.canvas = canvas;
      context = canvas.getContext('2d');
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const textLayerEl = documentRef.createElement('div');
    textLayerEl.className = 'textLayer';
    pageEl.replaceChildren(canvas, textLayerEl);

    try {
      record.renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
      });
      await record.renderTask.promise;
      checkCurrent();
    } catch (renderError) {
      if (renderError?.name === 'RenderingCancelledException') throw renderError;
      if (retryCount < 2) {
        releaseRenderCanvas(canvas);
        record.canvas = null;
        return renderPageInto(page, pageEl, record, retryCount + 1);
      }
      throw renderError;
    }

    const textContent = await page.getTextContent();
    checkCurrent();
    const textLayer = new pdfjs.TextLayer({
      page,
      textContentSource: textContent,
      container: textLayerEl,
      viewport,
    });
    record.textLayerTask = textLayer;
    await textLayer.render();
    checkCurrent();
    annotateTextLayer?.(textLayerEl, textContent.items, { pageView: page.view, pageRotation: page.rotate || 0 });
    renderOcrTextLayer?.(pageEl, page, viewport);
  }

  function unloadPageSoon(pageNumber) {
    clearUnloadTimer(pageNumber);
    if (isProtectedPageNumber(pageNumber)) return;
    unloadTimers.set(pageNumber, windowRef.setTimeout(() => unloadPage(pageNumber), unloadDelayMs));
  }

  function evictPageIfNeeded(pageNumber) {
    const evicted = [];
    while (!isProtectedPageNumber(pageNumber) && getRegularRenderedPageCount() >= renderedPageLimit) {
      const candidate = getEvictionCandidate(pageNumber);
      if (!candidate) break;
      unloadPage(candidate);
      evicted.push(candidate);
    }
    return evicted;
  }

  function unloadPage(pageNumber, { force = false } = {}) {
    clearUnloadTimer(pageNumber);
    if (!force && isProtectedPageNumber(pageNumber)) return;
    const record = renderedPages.get(pageNumber);
    if (!record) return;

    disposeRecord(record);
    renderedPages.delete(pageNumber);
  }

  function acquireRenderCanvas() {
    while (canvasPool.length > 0) {
      const candidate = canvasPool.pop();
      try {
        const ctx = candidate?.getContext?.('2d');
        if (ctx && !ctx.isContextLost?.()) return candidate;
      } catch {
        // discard broken canvas
      }
    }
    return documentRef.createElement('canvas');
  }

  function releaseRenderCanvas(canvas) {
    if (!canvas) return;
    try {
      const ctx = canvas.getContext?.('2d');
      if (ctx?.isContextLost?.()) return;
    } catch {
      return;
    }
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = '';
    canvas.style.height = '';
    if (canvasPool.length < maxCanvasPoolSize) canvasPool.push(canvas);
  }

  function clearUnloadTimer(pageNumber) {
    const timer = unloadTimers.get(pageNumber);
    if (!timer) return;
    windowRef.clearTimeout(timer);
    unloadTimers.delete(pageNumber);
  }

  function getEvictionCandidate(targetPageNumber) {
    const pages = [...renderedPages.keys()];
    if (!pages.length) return null;

    return pages
      .filter((pageNumber) => pageNumber !== targetPageNumber && !isProtectedPageNumber(pageNumber))
      .sort((a, b) => {
        const distanceA = Math.abs(a - targetPageNumber);
        const distanceB = Math.abs(b - targetPageNumber);
        return distanceB - distanceA;
      })[0] || null;
  }

  function getRegularRenderedPageCount() {
    return [...renderedPages.keys()].filter((pageNumber) => !isProtectedPageNumber(pageNumber)).length;
  }

  function setProtectedPageNumbers(pageNumbers = []) {
    protectedPageNumbers = new Set(
      pageNumbers
        .map(normalizePageNumber)
        .filter(Boolean),
    );

    for (const pageNumber of protectedPageNumbers) {
      clearUnloadTimer(pageNumber);
    }
  }

  function isProtectedPageNumber(pageNumber) {
    return protectedPageNumbers.has(normalizePageNumber(pageNumber));
  }

  function destroy() {
    protectedPageNumbers = new Set();
    for (const timer of unloadTimers.values()) {
      windowRef.clearTimeout(timer);
    }
    unloadTimers.clear();

    for (const pageNumber of [...renderedPages.keys()]) {
      unloadPage(pageNumber, { force: true });
    }
  }

  return {
    ensurePageRendered,
    evictPageIfNeeded,
    unloadPageSoon,
    unloadPage,
    setProtectedPageNumbers,
    destroy,
    getRenderedPageNumbers: () => [...renderedPages.keys()],
  };
}

function normalizeRenderedPageLimit(value) {
  return normalizePositiveInteger(value, MAX_RENDERED_PAGES);
}

function normalizePageNumber(value) {
  return normalizePositiveInteger(value, 0);
}

function normalizePreloadDistance(value) {
  return normalizeNonNegativeInteger(value, 0);
}

function defaultGetPageScale(page, windowRef = window) {
  const viewport = page.getViewport({ scale: 1 });
  const maxWidth = Math.max(320, windowRef.innerWidth - 40);
  return Math.min(1.5, maxWidth / viewport.width);
}
