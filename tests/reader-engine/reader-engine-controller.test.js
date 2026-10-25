import { describe, expect, it, vi } from 'vitest';
import { createReaderEngineController } from '../../src/ui/reader-engine/reader-engine-controller.js';

function createTarget(dataset = {}) {
  const handlers = new Map();
  return {
    dataset,
    addEventListener(event, handler) {
      handlers.set(event, handler);
    },
    fire(event, payload = {}) {
      handlers.get(event)?.(payload);
    },
  };
}

function enterEvent() {
  return {
    key: 'Enter',
    preventDefault: vi.fn(),
  };
}

describe('readerEngine controller button matrix', () => {
  it('binds every readerEngine button and Enter-key control to its action', () => {
    const els = {
      read: createTarget(),
      readSelected: createTarget(),
      errorPrimaryAction: createTarget({ errorAction: 'read-selected' }),
      errorSecondaryAction: createTarget({ errorAction: 'try-again' }),
      stop: createTarget(),
      prev: createTarget(),
      next: createTarget(),
      queueFirst: createTarget(),
      queueLast: createTarget(),
      queueJump: createTarget(),
      queueJumpInput: createTarget(),
      pdfPageFirst: createTarget(),
      pdfPageSkip: createTarget(),
      pdfPageJump: createTarget(),
      pdfPageJumpInput: createTarget(),
      queueSearchInput: createTarget(),
      resumeRead: createTarget(),
      resumeStartOver: createTarget(),
      codeSuggestionAccept: createTarget(),
    };
    const document = createTarget();
    const actions = Object.fromEntries([
      'handlePrimaryAction',
      'handleReadSelectedAction',
      'handleErrorRecoveryAction',
      'stopReading',
      'skipToPreviousChunk',
      'skipToNextChunk',
      'handleVoiceModelVisibilityChange',
      'jumpToFirstChunk',
      'jumpToLastLoadedChunk',
      'jumpToEnteredChunk',
      'jumpToFirstPdfPage',
      'skipCurrentPdfPage',
      'jumpToEnteredPdfPage',
      'handleQueueSearchInput',
      'resumeSavedReading',
      'startOverFromResume',
      'acceptCodeCleanupSuggestion',
    ].map((name) => [name, vi.fn()]));

    createReaderEngineController().bind({ els, document, actions });

    els.read.fire('click');
    els.readSelected.fire('click');
    els.errorPrimaryAction.fire('click');
    els.errorSecondaryAction.fire('click');
    els.stop.fire('click');
    els.prev.fire('click');
    els.next.fire('click');
    document.fire('visibilitychange');
    els.queueFirst.fire('click');
    els.queueLast.fire('click');
    els.queueJump.fire('click');
    const queueEnter = enterEvent();
    els.queueJumpInput.fire('keydown', queueEnter);
    els.pdfPageFirst.fire('click');
    els.pdfPageSkip.fire('click');
    els.pdfPageJump.fire('click');
    const pdfEnter = enterEvent();
    els.pdfPageJumpInput.fire('keydown', pdfEnter);
    els.queueSearchInput.fire('input');
    els.resumeRead.fire('click');
    els.resumeStartOver.fire('click');
    els.codeSuggestionAccept.fire('click');
    expect(actions.handlePrimaryAction).toHaveBeenCalledTimes(1);
    expect(actions.handleReadSelectedAction).toHaveBeenCalledTimes(1);
    expect(actions.handleErrorRecoveryAction).toHaveBeenCalledWith('read-selected');
    expect(actions.handleErrorRecoveryAction).toHaveBeenCalledWith('try-again');
    expect(actions.stopReading).toHaveBeenCalledTimes(1);
    expect(actions.skipToPreviousChunk).toHaveBeenCalledTimes(1);
    expect(actions.skipToNextChunk).toHaveBeenCalledTimes(1);
    expect(actions.handleVoiceModelVisibilityChange).toHaveBeenCalledTimes(1);
    expect(actions.jumpToFirstChunk).toHaveBeenCalledTimes(1);
    expect(actions.jumpToLastLoadedChunk).toHaveBeenCalledTimes(1);
    expect(actions.jumpToEnteredChunk).toHaveBeenCalledTimes(2);
    expect(queueEnter.preventDefault).toHaveBeenCalledTimes(1);
    expect(actions.jumpToFirstPdfPage).toHaveBeenCalledTimes(1);
    expect(actions.skipCurrentPdfPage).toHaveBeenCalledTimes(1);
    expect(actions.jumpToEnteredPdfPage).toHaveBeenCalledTimes(2);
    expect(pdfEnter.preventDefault).toHaveBeenCalledTimes(1);
    expect(actions.handleQueueSearchInput).toHaveBeenCalledTimes(1);
    expect(actions.resumeSavedReading).toHaveBeenCalledTimes(1);
    expect(actions.startOverFromResume).toHaveBeenCalledTimes(1);
    expect(actions.acceptCodeCleanupSuggestion).toHaveBeenCalledTimes(1);
  });
});
