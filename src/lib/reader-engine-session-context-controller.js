import { createResumePosition, getSavedResumeChunk } from './resume-position.js';

/** @param {any} [deps] */
export function createReaderEngineSessionContextController({
  state,
  storage,
  getResumePositionStorageKey,
  getActiveReadableTab,
  getTabContextKey,
  readOrchestrator,
  renderResumePrompt,
  renderCodeSuggestion,
  setArticleSummary,
  setReadingState,
  renderQueue,
  renderPdfPageControls,
  clearTranscript = () => {},
  resetQueueSearch = () => {},
  sendPageMessage,
  getSelectedHighlightSettings,
  getChunkWordCounts = () => [],
  messageTypes,
  onError = () => {},
  onLoadError = onError,
} = {}) {
  async function loadSavedResumePosition(url, chunks = [], options = {}) {
    if (!url || !Array.isArray(chunks)) return null;
    const key = getResumePositionStorageKey(url);
    const stored = await storage.get(key).catch(onLoadError);
    const saved = stored?.[key];
    if (chunks.length <= 1) return options.allowUnverified ? saved : null;
    const chunk = getSavedResumeChunk(saved, chunks);
    return chunk > 0 ? { ...saved, chunk } : options.allowUnverified ? saved : null;
  }

  async function saveResumeChunk(article, chunk, total) {
    if (!article?.url || !Number.isFinite(chunk)) return;
    const key = getResumePositionStorageKey(article.url);
    const safeTotal = Number.isFinite(total) && total > 0 ? total : state.activeChunks.length;
    if (chunk <= 0 || (safeTotal > 0 && chunk >= safeTotal && !state.activeChunkIterator)) {
      await storage.remove(key).catch(onError);
      return;
    }
    const resume = createResumePosition({ article, chunks: state.activeChunks, chunk, total: safeTotal });
    if (!resume) return;
    await storage.set({ [key]: resume }).catch(onError);
  }

  async function refreshActiveTabContext(tab = null) {
    try {
      const targetTab = await getActiveReadableTab({ queuedTab: tab });
      // Chrome can redact tab URLs; incomplete metadata does not prove navigation.
      if (!targetTab?.url && !targetTab?.pendingUrl) return;
      const nextKey = getTabContextKey(targetTab);
      if (!state.activePageContextKey) {
        state.activePageContextKey = nextKey;
        state.panelTargetTab = targetTab;
        return;
      }
      if (nextKey && nextKey !== state.activePageContextKey) handleActiveTabContextChanged(nextKey);
      state.panelTargetTab = targetTab;
    } catch (error) {
      onError(error);
    }
  }

  function handleActiveTabContextChanged(nextKey = '') {
    state.activePageContextKey = nextKey;
    if (state.readingState === 'reading' || state.readingState === 'paused' || state.readingState === 'preparing') return;
    state.activeReadTabId = null;
    clearReadSessionBuffers();
    setReadingState('idle', { currentChunk: 0, totalChunks: 0 });
  }

  function clearReadSessionBuffers() {
    state.activeChunks = [];
    state.activeChunkWordCounts = [];
    state.currentChunk = 0;
    state.totalChunks = 0;
    state.activeChunkIterator = null;
    state.activeArticleSource = '';
    state.activePdfPageCount = 0;
    state.activeReadingCursor = null;
    state.ttsSectionReadyTransitionTracker = null;
    resetQueueSearch();
    clearTranscript();
    readOrchestrator.reset();
    renderResumePrompt(null);
    renderCodeSuggestion?.({ visible: false });
    setArticleSummary({});
    renderQueue([], 0);
    renderPdfPageControls();
  }

  async function configurePageHighlight(tabId = state.activeReadTabId) {
    await sendPageMessage(tabId, {
      type: messageTypes.SET_HIGHLIGHT_SETTINGS,
      highlightSettings: getSelectedHighlightSettings(),
    });
  }

  function compactActivePdfChunkHistory(currentIndex) {
    const compacted = readOrchestrator.compactPdfChunkHistory(currentIndex);
    if (compacted === state.activeChunks) return;
    state.activeChunkWordCounts = getChunkWordCounts(state.activeChunks);
  }

  return {
    loadSavedResumePosition,
    saveResumeChunk,
    refreshActiveTabContext,
    handleActiveTabContextChanged,
    clearReadSessionBuffers,
    configurePageHighlight,
    compactActivePdfChunkHistory,
  };
}
