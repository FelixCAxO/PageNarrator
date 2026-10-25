import {
  createPdfPageNavigation,
  findNextPdfPageStartIndex,
  findPdfPageStartIndex,
  getCurrentPdfPage,
} from './pdf-page-navigation.js';

/** @param {any} [deps] */
export function createReaderEnginePdfNavigationController({
  els,
  state,
  readOrchestrator,
  requestJump = () => {},
  renderQueue = () => {},
  onError = () => {},
  document = globalThis.document,
} = {}) {
  function jumpToFirstPdfPage() {
    const nav = getPdfPageNavigation();
    if (!nav.visible) return undefined;
    return jumpToPdfPage(nav.firstPage).catch(onError);
  }

  function jumpToEnteredPdfPage() {
    const pageNumber = Number.parseInt(els?.pdfPageJumpInput?.value || '', 10);
    if (!Number.isFinite(pageNumber)) return undefined;
    return jumpToPdfPage(pageNumber).catch(onError);
  }

  function skipCurrentPdfPage() {
    return jumpToNextPdfPage().catch(onError);
  }

  async function jumpToPdfPage(pageNumber) {
    if (!canControlPdfPages()) return;
    const targetPage = normalizePdfPageNumber(pageNumber);
    if (!targetPage) return;

    const targetIndex = await ensurePdfPageStartIndex(targetPage);
    if (targetIndex === null) return;
    requestJump(targetIndex);
    renderPdfPageControls();
  }

  async function jumpToNextPdfPage() {
    if (!canControlPdfPages()) return;
    const targetIndex = await ensureNextPdfPageStartIndex();
    if (targetIndex === null) return;
    requestJump(targetIndex);
    renderPdfPageControls();
  }

  async function ensurePdfPageStartIndex(pageNumber) {
    let targetIndex = findPdfPageStartIndex(getChunks(), pageNumber);
    if (targetIndex !== null) return targetIndex;
    if (!getChunkIterator()) return null;

    while (getChunkIterator()) {
      const previousLength = getChunks().length;
      await readOrchestrator?.fillChunkBuffer?.(previousLength);
      const chunks = getChunks();
      if (chunks.length <= previousLength) break;

      targetIndex = findPdfPageStartIndex(chunks, pageNumber);
      if (targetIndex !== null) return targetIndex;

      const lastLoadedPage = getCurrentPdfPage(chunks, chunks.length - 1);
      if (Number.isFinite(lastLoadedPage) && lastLoadedPage > pageNumber) break;
    }

    renderQueue(getChunks(), getCurrentChunk());
    return null;
  }

  async function ensureNextPdfPageStartIndex() {
    let targetIndex = findNextPdfPageStartIndex(getChunks(), getCurrentChunk());
    if (targetIndex !== null) return targetIndex;
    if (!getChunkIterator()) return null;

    while (getChunkIterator()) {
      const previousLength = getChunks().length;
      await readOrchestrator?.fillChunkBuffer?.(previousLength);
      const chunks = getChunks();
      if (chunks.length <= previousLength) break;

      targetIndex = findNextPdfPageStartIndex(chunks, getCurrentChunk());
      if (targetIndex !== null) return targetIndex;
    }

    renderQueue(getChunks(), getCurrentChunk());
    return null;
  }

  function renderPdfPageControls() {
    if (!els?.pdfPageNav || !els?.pdfPageJumpInput) return;

    const nav = getPdfPageNavigation();
    els.pdfPageNav.hidden = !nav.visible;
    if (!nav.visible) return;

    els.pdfPageJumpInput.min = '1';
    els.pdfPageJumpInput.max = String(Math.max(1, nav.maxPage));
    if (document?.activeElement !== els.pdfPageJumpInput) {
      els.pdfPageJumpInput.value = nav.inputValue;
    }

    els.pdfPageJumpInput.disabled = !nav.canGoToPage;
    if (els.pdfPageJump) els.pdfPageJump.disabled = !nav.canGoToPage;
    if (els.pdfPageFirst) els.pdfPageFirst.disabled = !nav.canJumpFirst;
    if (els.pdfPageSkip) els.pdfPageSkip.disabled = !nav.canSkipCurrentPage;
  }

  function getPdfPageNavigation() {
    return createPdfPageNavigation({
      source: state?.articleSource,
      state: state?.readingState,
      chunks: getChunks(),
      currentChunk: getCurrentChunk(),
      pageCount: state?.pdfPageCount,
      canLoadMorePages: Boolean(getChunkIterator()),
    });
  }

  function canControlPdfPages() {
    return state?.articleSource === 'pdf' && (state?.readingState === 'reading' || state?.readingState === 'paused');
  }

  function normalizePdfPageNumber(pageNumber) {
    const page = Math.trunc(Number(pageNumber));
    if (!Number.isFinite(page) || page < 1) return 0;
    const pageCount = Number(state?.pdfPageCount);
    return pageCount > 0 ? Math.min(page, pageCount) : page;
  }

  function getChunks() {
    return Array.isArray(state?.chunks) ? state.chunks : [];
  }

  function getCurrentChunk() {
    return Number.isFinite(Number(state?.currentChunk)) ? Number(state.currentChunk) : 0;
  }

  function getChunkIterator() {
    return state?.chunkIterator || null;
  }

  return {
    getPdfPageNavigation,
    jumpToFirstPdfPage,
    jumpToEnteredPdfPage,
    jumpToPdfPage,
    jumpToNextPdfPage,
    renderPdfPageControls,
    skipCurrentPdfPage,
  };
}
