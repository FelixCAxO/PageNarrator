const ACTIVE_READING_STATES = new Set(['reading', 'paused']);

/** @param {any} [deps] */
export function createReaderEngineQueueNavigationController({
  els,
  state,
  requestJump = () => {},
  document = globalThis.document,
} = {}) {
  function jumpToFirstChunk() {
    requestJump(0);
  }

  function jumpToLastLoadedChunk() {
    requestJump(getChunks().length - 1);
  }

  function jumpToEnteredChunk() {
    const sectionNumber = Number.parseInt(els?.queueJumpInput?.value || '', 10);
    if (!Number.isFinite(sectionNumber)) return;
    requestJump(sectionNumber - 1);
  }

  function renderQueueNavigation(chunks = getChunks(), activeIndex = 0) {
    if (!els?.queueNav || !els?.queueJumpInput) return;

    const loadedCount = Array.isArray(chunks) ? chunks.length : 0;
    const canJump = loadedCount > 0 && ACTIVE_READING_STATES.has(state?.readingState);
    const safeActiveIndex = Number.isFinite(activeIndex)
      ? Math.max(0, Math.min(loadedCount - 1, Math.trunc(activeIndex)))
      : 0;

    els.queueNav.hidden = loadedCount === 0;
    els.queueJumpInput.min = '1';
    els.queueJumpInput.max = String(Math.max(1, loadedCount));
    if (document?.activeElement !== els.queueJumpInput) {
      els.queueJumpInput.value = String(Math.min(loadedCount || 1, safeActiveIndex + 1));
    }

    for (const control of [els.queueJumpInput, els.queueJump]) {
      if (control) control.disabled = !canJump;
    }
    if (els.queueFirst) els.queueFirst.disabled = !canJump || safeActiveIndex <= 0;
    if (els.queueLast) els.queueLast.disabled = !canJump || safeActiveIndex >= loadedCount - 1;
  }

  function getChunks() {
    return Array.isArray(state?.chunks) ? state.chunks : [];
  }

  return {
    jumpToEnteredChunk,
    jumpToFirstChunk,
    jumpToLastLoadedChunk,
    renderQueueNavigation,
  };
}
