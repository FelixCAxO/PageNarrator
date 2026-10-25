import { describe, expect, it } from 'vitest';
import { createReaderEngineSessionContextController } from '../../src/lib/reader-engine-session-context-controller.js';

function createController(overrides = {}) {
  const calls = [];
  const state = {
    activeReadTabId: 7,
    readingState: 'idle',
    currentChunk: 3,
    totalChunks: 8,
    activeChunks: ['one', 'two'],
    activeChunkWordCounts: [1, 1],
    activeChunkIterator: {},
    activeArticleSource: 'html',
    activePdfPageCount: 2,
    activePageContextKey: '',
    activeReadingCursor: { chunk: 3 },
    ttsSectionReadyTransitionTracker: {},
    panelTargetTab: null,
    ...overrides.state,
  };
  const controller = createReaderEngineSessionContextController({
    state,
    storage: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    getResumePositionStorageKey: (url) => `resume:${url}`,
    getActiveReadableTab: overrides.getActiveReadableTab || (async () => overrides.targetTab || { id: 11, url: 'https://example.test/read' }),
    getTabContextKey: (tab) => `tab:${tab.id}:${tab.url}`,
    isPro: async () => true,
    readOrchestrator: {
      reset: () => calls.push(['reset']),
      compactPdfChunkHistory: () => state.activeChunks,
    },
    renderResumePrompt: (value) => calls.push(['resume', value]),
    renderCodeSuggestion: (value) => calls.push(['code', value]),
    setArticleSummary: (value) => calls.push(['summary', value]),
    setReadingState: (...args) => {
      calls.push(['readingState', ...args]);
      state.readingState = args[0];
    },
    renderQueue: (...args) => calls.push(['queue', ...args]),
    renderPdfPageControls: () => calls.push(['pdfControls']),
    clearTranscript: () => calls.push(['clearTranscript']),
    resetQueueSearch: () => calls.push(['resetQueueSearch']),
    sendPageMessage: async () => {},
    getSelectedHighlightSettings: () => ({ enabled: true }),
    messageTypes: { SET_HIGHLIGHT_SETTINGS: 'set-highlight-settings' },
    onError: overrides.onError,
  });
  return { calls, controller, state };
}

describe('createReaderEngineSessionContextController', () => {
  it('seeds the initial active-page context without clearing the read buffers', async () => {
    const { calls, controller, state } = createController();

    await controller.refreshActiveTabContext();

    expect(state.activePageContextKey).toBe('tab:11:https://example.test/read');
    expect(state.panelTargetTab).toEqual({ id: 11, url: 'https://example.test/read' });
    expect(state.activeChunks).toEqual(['one', 'two']);
    expect(calls).toEqual([]);
  });

  it('does not clear paused sessions when the active tab context changes', () => {
    const { calls, controller, state } = createController({
      state: { readingState: 'paused', activePageContextKey: 'tab:1:https://old.test' },
    });

    controller.handleActiveTabContextChanged('tab:2:https://new.test');

    expect(state.activePageContextKey).toBe('tab:2:https://new.test');
    expect(state.readingState).toBe('paused');
    expect(state.activeReadTabId).toBe(7);
    expect(state.activeChunks).toEqual(['one', 'two']);
    expect(calls).toEqual([]);
  });

  it.each([7, 22])('preserves a finished document when tab %s activation has no URL metadata', async (id) => {
    const panelTargetTab = { id: 7, url: 'https://example.test/book.pdf' };
    const { calls, controller, state } = createController({
      targetTab: { id },
      state: { readingState: 'finished', activePageContextKey: 'tab:7:https://example.test/book.pdf', panelTargetTab },
    });
    await controller.refreshActiveTabContext({ id });
    expect(state.readingState).toBe('finished');
    expect(state.activePageContextKey).toBe('tab:7:https://example.test/book.pdf');
    expect(state.panelTargetTab).toBe(panelTargetTab);
    expect(calls).toEqual([]);
  });

  it('preserves the finished document and reports a failed target lookup', async () => {
    const failure = new Error('No active tab found.');
    const errors = [];
    const panelTargetTab = { id: 7, url: 'https://example.test/book.pdf' };
    const { calls, controller, state } = createController({
      getActiveReadableTab: async () => { throw failure; },
      onError: (error) => errors.push(error),
      state: { readingState: 'finished', activePageContextKey: 'tab:7:https://example.test/book.pdf', panelTargetTab },
    });
    await controller.refreshActiveTabContext();
    expect(state.readingState).toBe('finished');
    expect(state.activePageContextKey).toBe('tab:7:https://example.test/book.pdf');
    expect(state.panelTargetTab).toBe(panelTargetTab);
    expect(calls).toEqual([]);
    expect(errors).toEqual([failure]);
  });

  it('clears idle read buffers and renders the idle state on tab context changes', () => {
    const { calls, controller, state } = createController({
      state: { activePageContextKey: 'tab:1:https://old.test' },
    });

    controller.handleActiveTabContextChanged('tab:2:https://new.test');

    expect(state.activePageContextKey).toBe('tab:2:https://new.test');
    expect(state.activeReadTabId).toBe(null);
    expect(state.activeChunks).toEqual([]);
    expect(state.activeArticleSource).toBe('');
    expect(state.activePdfPageCount).toBe(0);
    expect(calls).toContainEqual(['readingState', 'idle', { currentChunk: 0, totalChunks: 0 }]);
    expect(calls).toContainEqual(['reset']);
  });
});
