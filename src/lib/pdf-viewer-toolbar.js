import { normalizePositive } from './number-validation.js';
export const PDF_FIT_WIDTH = 'width';
export const PDF_FIT_PAGE = 'page';

const DEFAULT_ZOOM = 1;
const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const DEFAULT_CONTAINER_WIDTH = 960;
const DEFAULT_CONTAINER_HEIGHT = 720;

export function createPdfToolbarState({
  currentPage = 1,
  pageCount = 0,
  zoom = DEFAULT_ZOOM,
  rotation = 0,
  fitMode = PDF_FIT_WIDTH,
} = {}) {
  const normalizedPageCount = normalizePageCount(pageCount);
  return {
    currentPage: clampPage(currentPage, normalizedPageCount),
    pageCount: normalizedPageCount,
    zoom: clampZoom(zoom),
    rotation: normalizeRotation(rotation),
    fitMode: normalizeFitMode(fitMode),
  };
}

export function updatePdfToolbarState(state, action = {}) {
  const current = createPdfToolbarState(state);

  if (action.type === 'setPage') {
    return createPdfToolbarState({ ...current, currentPage: action.pageNumber });
  }

  if (action.type === 'setPageCount') {
    return createPdfToolbarState({ ...current, pageCount: action.pageCount });
  }

  if (action.type === 'zoomIn') {
    return createPdfToolbarState({ ...current, zoom: current.zoom + ZOOM_STEP });
  }

  if (action.type === 'zoomOut') {
    return createPdfToolbarState({ ...current, zoom: current.zoom - ZOOM_STEP });
  }

  if (action.type === 'rotateClockwise') {
    return createPdfToolbarState({ ...current, rotation: current.rotation + 90 });
  }

  if (action.type === 'rotateCounterClockwise') {
    return createPdfToolbarState({ ...current, rotation: current.rotation - 90 });
  }

  if (action.type === 'setFitMode') {
    return createPdfToolbarState({ ...current, fitMode: action.fitMode, zoom: DEFAULT_ZOOM });
  }

  return current;
}

export function getPdfToolbarView(state) {
  const current = createPdfToolbarState(state);
  const pageCount = current.pageCount || 1;
  return {
    currentPage: current.currentPage,
    pageCount: current.pageCount,
    pageLabel: `${current.currentPage} / ${pageCount}`,
    zoomLabel: `${Math.round(current.zoom * 100)}%`,
    rotation: current.rotation,
    fitMode: current.fitMode,
    canGoPrevious: current.currentPage > 1,
    canGoNext: current.pageCount <= 0 || current.currentPage < current.pageCount,
    canZoomOut: current.zoom > MIN_ZOOM,
    canZoomIn: current.zoom < MAX_ZOOM,
  };
}

export function getPdfPageHash(pageNumber) {
  return `#page=${clampPage(pageNumber, 0)}`;
}

export function getPdfPageViewport(baseViewport, state, {
  width = DEFAULT_CONTAINER_WIDTH,
  height = DEFAULT_CONTAINER_HEIGHT,
  padding = 40,
} = {}) {
  const current = createPdfToolbarState(state);
  const sourceWidth = normalizePositive(baseViewport?.width, 1);
  const sourceHeight = normalizePositive(baseViewport?.height, 1);
  const rotated = current.rotation % 180 === 0
    ? { width: sourceWidth, height: sourceHeight }
    : { width: sourceHeight, height: sourceWidth };
  const availableWidth = Math.max(1, Number(width) - Number(padding || 0));
  const availableHeight = Math.max(1, Number(height) - Number(padding || 0));
  const widthScale = availableWidth / rotated.width;
  const pageScale = Math.min(widthScale, availableHeight / rotated.height);
  const fitScale = current.fitMode === PDF_FIT_PAGE ? pageScale : widthScale;
  const scale = fitScale < 0.05 ? fitScale * current.zoom : roundScale(fitScale * current.zoom);

  return {
    width: Math.floor(rotated.width * scale),
    height: Math.floor(rotated.height * scale),
    scale,
    rotation: normalizeRotation((Number(baseViewport?.rotation) || 0) + current.rotation),
    ...(baseViewport?.userUnit && baseViewport.userUnit !== 1 ? { userUnit: baseViewport.userUnit } : {}),
  };
}

export function applyPdfViewportToPageElement(pageEl, viewport) {
  if (!pageEl?.style || !viewport) return;
  pageEl.style.setProperty('--total-scale-factor', String((viewport.scale || 1) * (viewport.userUnit ?? 1)));
  pageEl.style.setProperty('--scale-round-x', '1px');
  pageEl.style.setProperty('--scale-round-y', '1px');
  pageEl.style.width = `${Math.floor(viewport.width)}px`;
  pageEl.style.height = `${Math.floor(viewport.height)}px`;
}

function normalizePageCount(value) {
  const pageCount = Math.trunc(Number(value));
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 0;
}

function clampPage(value, pageCount) {
  const page = Math.trunc(Number(value));
  const lowerBounded = Number.isFinite(page) && page > 0 ? page : 1;
  return pageCount > 0 ? Math.min(lowerBounded, pageCount) : lowerBounded;
}

function clampZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) * 100) / 100;
}

function normalizeRotation(value) {
  const rotation = Math.trunc(Number(value));
  if (!Number.isFinite(rotation)) return 0;
  return ((rotation % 360) + 360) % 360;
}

function normalizeFitMode(value) {
  return value === PDF_FIT_PAGE ? PDF_FIT_PAGE : PDF_FIT_WIDTH;
}

function roundScale(value) {
  return Math.round(value * 1000) / 1000;
}
