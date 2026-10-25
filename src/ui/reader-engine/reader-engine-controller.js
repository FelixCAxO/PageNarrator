/**
 * @param {object} [deps]
 * @param {any} [deps.session]
 * @param {any} [deps.readRunner]
 * @param {any} [deps.ttsService]
 */
export function createReaderEngineController({ session = null, readRunner = null, ttsService = null } = {}) {
  /**
   * @param {{ els?: Record<string, any>, document?: any, actions?: Record<string, any> }} [options]
   */
  function bind({ els = {}, document = null, actions = {} } = {}) {
    const on = (target, event, handler) => {
      if (typeof target?.addEventListener === 'function' && typeof handler === 'function') {
        target.addEventListener(event, handler);
      }
    };
    const run = (action) => () => {
      void Promise.resolve(action?.()).catch(actions.onError || (() => {}));
    };

    on(els.read, 'click', run(actions.handlePrimaryAction));
    on(els.readSelected, 'click', run(actions.handleReadSelectedAction));
    on(els.errorPrimaryAction, 'click', run(() => actions.handleErrorRecoveryAction?.(els.errorPrimaryAction?.dataset?.errorAction)));
    on(els.errorSecondaryAction, 'click', run(() => actions.handleErrorRecoveryAction?.(els.errorSecondaryAction?.dataset?.errorAction)));
    on(els.stop, 'click', run(actions.stopReading));
    on(els.prev, 'click', run(actions.skipToPreviousChunk));
    on(els.next, 'click', run(actions.skipToNextChunk));
    on(document, 'visibilitychange', actions.handleVoiceModelVisibilityChange);
    on(els.queueFirst, 'click', actions.jumpToFirstChunk);
    on(els.queueLast, 'click', actions.jumpToLastLoadedChunk);
    on(els.queueJump, 'click', actions.jumpToEnteredChunk);
    on(els.queueJumpInput, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      actions.jumpToEnteredChunk?.();
    });
    on(els.pdfPageFirst, 'click', actions.jumpToFirstPdfPage);
    on(els.pdfPageSkip, 'click', actions.skipCurrentPdfPage);
    on(els.pdfPageJump, 'click', actions.jumpToEnteredPdfPage);
    on(els.pdfPageJumpInput, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void Promise.resolve(actions.jumpToEnteredPdfPage?.()).catch(actions.onError || (() => {}));
    });
    on(els.queueSearchInput, 'input', actions.handleQueueSearchInput);
    on(els.resumeRead, 'click', actions.resumeSavedReading);
    on(els.resumeStartOver, 'click', actions.startOverFromResume);
    on(els.codeSuggestionAccept, 'click', run(actions.acceptCodeCleanupSuggestion));
  }

  function renderReadingState(viewModel = {}) {
    viewModel.render?.(viewModel);
  }

  return {
    session,
    readRunner,
    ttsService,
    bind,
    render: renderReadingState,
    renderReadingState,
  };
}
