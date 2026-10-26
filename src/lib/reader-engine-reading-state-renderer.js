import { t } from './i18n.js';
import { HIDDEN_TAB_URL_ACCESS_ERROR_CODE } from './content-script-injection.js';
import { MESSAGE_TYPES } from './message-types.js';
import { getPanelView } from './reader-engine-view.js';
import { getChunkSpeechText } from './reader-engine-chunks.js';

export function createReaderEngineReadingStateRenderer({
  els,
  session,
  state,
  chrome,
  icons,
  renderQueue,
  renderPdfPageControls,
  renderReaderEngineErrorNotice,
  hideReaderEngineErrorNotice,
  onboardingController,
  reviewPromptController,
  onRendered = () => {},
  onError = () => {},
} = {}) {
  function setReadingState(nextState, options = {}) {
    const previousReadingState = state.readingState;
    session.setReadingState(nextState);
    if (Number.isFinite(options.totalChunks)) state.totalChunks = options.totalChunks;
    if (Number.isFinite(options.currentChunk)) state.currentChunk = options.currentChunk;

    const view = getPanelView({
      state: nextState,
      message: options.message,
      errorCode: options.errorCode,
      currentChunk: state.currentChunk,
      totalChunks: state.totalChunks,
      wordCounts: state.activeChunkWordCounts,
      totalReadableWordCount: state.totalReadableWordCount,
      pageCount: state.activePdfPageCount,
      pageNumber: state.activeChunks?.[state.currentChunk]?.pageNumber,
      source: options.source || state.activeArticleSource,
      modelSetup: state.modelSetupState,
    });

    els.subtitle.textContent = view.subtitle;
    els.statusLabel.textContent = view.statusText;
    els.status.dataset.tone = view.statusTone;
    els.status.classList.toggle('error', view.isError);
    if (nextState === 'error') {
      renderReaderEngineErrorNotice(els, { code: options.errorCode, message: options.message });
    } else {
      hideReaderEngineErrorNotice(els);
    }
    renderAccessGuidance(nextState === 'error' && options.errorCode === HIDDEN_TAB_URL_ACCESS_ERROR_CODE);
    els.panel.classList.toggle('is-reading', view.mode === 'reading');
    els.panel.classList.toggle('is-paused', view.statusTone === 'paused');
    renderActionButton(els.read, view.primaryAction.label, nextState === 'reading' ? 'pause' : 'play');
    els.read.disabled = view.primaryAction.disabled;
    state.activePrimaryAction = view.primaryAction.action || null;
    const stopAction = view.secondaryActions.find((action) => action.id === 'stop');
    els.stop.hidden = !stopAction;
    if (stopAction) renderActionButton(els.stop, stopAction.label, 'stop');

    const hasProgress = nextState === 'reading' || nextState === 'paused';
    els.prev.hidden = !hasProgress;
    els.next.hidden = !hasProgress;
    if (els.readSelected) els.readSelected.hidden = hasProgress || nextState === 'preparing';
    renderQueue(state.activeChunks, state.currentChunk);
    renderPdfPageControls();
    els.readingProgress.hidden = !hasProgress;
    els.readingProgress.setAttribute('aria-hidden', String(!hasProgress));
    els.readingProgress.setAttribute('aria-valuenow', String(view.progressPercent));
    els.readingProgress.setAttribute('aria-valuetext', view.progressLabel);
    els.readingProgressBar.style.width = `${view.progressPercent}%`;
    els.readingProgressLabel.textContent = view.progressLabel;
    els.readingRemainingLabel.textContent = view.remainingLabel;
    els.readingStateLabel.textContent = view.statusTone === 'paused' ? t("Paused") : t("Reading");
    broadcastPlayerState(options);
    onRendered(nextState);

    if (nextState === 'finished' && previousReadingState !== 'finished') {
      void recordSuccessfulRead(nextState).catch(onError);
    } else {
      onboardingController.render({ readingState: nextState });
      if (!['idle', 'finished'].includes(nextState)) reviewPromptController.hide();
    }
  }

  async function recordSuccessfulRead(readingState) {
    await onboardingController.recordSuccessfulRead({ source: state.activeArticleSource });
    onboardingController.render({ readingState });
    await reviewPromptController.recordSuccessfulRead();
    await reviewPromptController.maybeShow({
      readingState,
      protected: isReviewProtected(),
    });
  }

  function isReviewProtected() {
    return !onboardingController.isComplete()
      || state.modelSetupState?.phase === 'loading';
  }

  function broadcastPlayerState({ message = '', errorCode = '', syncRequestId = '' } = {}) {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.READER_STATE_CHANGED,
      state: state.readingState,
      title: els.readingTitle.textContent,
      currentChunk: state.currentChunk,
      totalChunks: state.totalChunks,
      progressLabel: els.readingProgressLabel.textContent,
      remainingLabel: els.readingRemainingLabel.textContent,
      message,
      errorCode,
      queue: state.activeChunks.map((chunk) => getChunkSpeechText(chunk)),
      transcript: state.activeTranscript,
      modelSetup: state.modelSetupState,
      backend: state.backendPlan,
      ...(syncRequestId ? { syncRequestId } : {}),
    }).catch(onError);
  }

  function renderActionButton(button, label, iconName) {
    button.dataset.label = label;
    button.innerHTML = icons[iconName];
    const caption = button.ownerDocument.createElement('span');
    caption.textContent = label;
    button.appendChild(caption);
  }

  function renderAccessGuidance(visible) {
    if (!els.accessGuidance) return;
    if (visible && els.accessGuidanceIcon && !els.accessGuidanceIcon.src) els.accessGuidanceIcon.src = chrome.runtime.getURL('icons/icon-32.png');
    els.accessGuidance.hidden = !visible;
  }

  return { setReadingState, broadcastPlayerState };
}
