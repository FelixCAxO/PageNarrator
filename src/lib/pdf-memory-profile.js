const PDF_RENDERED_PAGE_BYTE_BUDGET = 1_000_000;

export function createPdfMemoryProfile({
  navigatorRef = globalThis.navigator,
  pageCount = 0,
} = {}) {
  const deviceMemory = Number(navigatorRef?.deviceMemory);
  const memoryGb = Number.isFinite(deviceMemory) ? deviceMemory : null;
  const pages = Number(pageCount);

  const lowMemory = memoryGb !== null && memoryGb <= 4;
  const mediumMemory = memoryGb !== null && memoryGb <= 8;
  const largeDocument = Number.isFinite(pages) && pages >= 80;
  const pdfWordTrailLength = 4;
  const qualityWindow = {
    preloadBehind: 2,
    preloadAhead: 2,
    maxRenderedPages: 5,
    rootMarginPx: 0,
  };
  const lowMemoryWindow = {
    preloadBehind: 1,
    preloadAhead: 1,
    maxRenderedPages: 3,
    rootMarginPx: 0,
  };
  const largeDocumentWindow = {
    preloadBehind: 0,
    preloadAhead: 1,
    maxRenderedPages: 2,
    rootMarginPx: 0,
  };

  if (largeDocument) {
    return {
      name: 'large',
      ...largeDocumentWindow,
      renderWindowByteBudget: getRenderWindowByteBudget(largeDocumentWindow),
      unloadDelayMs: 150,
      pdfWordTrailLength,
      showQueuedPdfRegion: false,
      preferCssOnlyPdfRegion: true,
    };
  }

  if (lowMemory) {
    return {
      name: 'low',
      ...lowMemoryWindow,
      renderWindowByteBudget: getRenderWindowByteBudget(lowMemoryWindow),
      unloadDelayMs: 150,
      pdfWordTrailLength,
      showQueuedPdfRegion: false,
      preferCssOnlyPdfRegion: true,
    };
  }

  if (mediumMemory) {
    return {
      name: 'balanced',
      ...qualityWindow,
      renderWindowByteBudget: getRenderWindowByteBudget(qualityWindow),
      unloadDelayMs: 300,
      pdfWordTrailLength,
      showQueuedPdfRegion: false,
      preferCssOnlyPdfRegion: true,
    };
  }

  return {
    name: 'quality',
    ...qualityWindow,
    renderWindowByteBudget: getRenderWindowByteBudget(qualityWindow),
    unloadDelayMs: 500,
    pdfWordTrailLength,
    showQueuedPdfRegion: false,
    preferCssOnlyPdfRegion: true,
  };
}

function getRenderWindowByteBudget(windowProfile) {
  return windowProfile.maxRenderedPages * PDF_RENDERED_PAGE_BYTE_BUDGET;
}
