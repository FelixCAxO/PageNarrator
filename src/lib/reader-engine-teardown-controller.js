import { MESSAGE_TYPES } from './message-types.js';

/** @param {any} [deps] */
export function createReaderEngineTeardownController({
  state,
  playbackSession,
  playbackAudioPool,
  activeVoiceSynthesisTracker,
  voiceModelReleaseController,
  runCleanupAfterSettled,
  stopReading,
  flushPendingPlaybackSettings,
  clearActiveSpeechPreloads,
  clearReadSessionBuffers,
  isPageNarratorPdfViewerUrl,
  sendPdfViewerMessage,
  releaseLoadedVoiceModel,
  suppressError,
} = {}) {
  function handlePanelPageHide() {
    flushPendingPlaybackSettings();
    tearDownEverything();
  }

  function tearDownEverything() {
    playbackSession.markReleaseBuffersAfterCleanup();
    state.releaseReadSessionAfterCleanup = true;
    const readCleanup = stopReading({ releaseBuffers: true });
    state.activeChunkIterator?.return?.().catch(suppressError);
    clearActiveSpeechPreloads();
    state.clearCurrentAudioEventListeners();
    state.clearCurrentAudioEventListeners = () => {};
    playbackAudioPool.destroy();
    state.currentAudio = null;
    state.currentAudioWatchdog?.dispose?.();
    state.currentAudioWatchdog = null;
    state.activeSectionPauseDelay = null;
    clearReadSessionBuffers();
    tearDownPdfViewerTab();
    releaseLoadedVoiceModelAfterReadCleanup(readCleanup);
  }

  function releaseLoadedVoiceModelAfterReadCleanup(readCleanup) {
    runCleanupAfterSettled(readCleanup, async () => {
      const released = await releaseLoadedVoiceModel();
      if (!released && activeVoiceSynthesisTracker.isActive()) voiceModelReleaseController.schedule();
    }).catch(suppressError);
  }

  function tearDownPdfViewerTab() {
    const panelTargetTab = state.panelTargetTab;
    const tabId = state.activeArticleSource === 'pdf'
      ? state.activeReadTabId || panelTargetTab?.id
      : panelTargetTab?.id && isPageNarratorPdfViewerUrl(panelTargetTab.url || '')
        ? panelTargetTab.id
        : null;
    if (!tabId) return;
    sendPdfViewerMessage(tabId, { type: MESSAGE_TYPES.TEAR_DOWN_PDF_VIEWER }).catch(suppressError);
  }

  return {
    handlePanelPageHide,
    tearDownEverything,
    tearDownPdfViewerTab,
  };
}
