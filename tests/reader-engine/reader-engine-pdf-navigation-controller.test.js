import { describe, expect, it } from 'vitest';
import { createReaderEnginePdfNavigationController } from '../../src/lib/reader-engine-pdf-navigation-controller.js';

function createEls() {
  return {
    pdfPageNav: { hidden: true },
    pdfPageFirst: { disabled: false },
    pdfPageJumpInput: {
      disabled: false,
      min: '',
      max: '',
      value: '',
    },
    pdfPageJump: { disabled: false },
    pdfPageSkip: { disabled: false },
  };
}

function createControllerHarness(overrides = {}) {
  const els = createEls();
  const state = {
    source: 'pdf',
    readingState: 'reading',
    chunks: [
      { speech: 'Page one opening.', pageNumber: 1 },
      { speech: 'Page one more.', pageNumber: 1 },
    ],
    currentChunk: 0,
    pdfPageCount: 5,
    chunkIterator: {},
    ...overrides.state,
  };
  const jumps = [];
  const queueRenders = [];
  const fillRequests = [];
  const controller = createReaderEnginePdfNavigationController({
    els,
    state: {
      get articleSource() {
        return state.source;
      },
      get readingState() {
        return state.readingState;
      },
      get chunks() {
        return state.chunks;
      },
      get currentChunk() {
        return state.currentChunk;
      },
      get pdfPageCount() {
        return state.pdfPageCount;
      },
      get chunkIterator() {
        return state.chunkIterator;
      },
    },
    readOrchestrator: {
      async fillChunkBuffer(index) {
        fillRequests.push(index);
        await overrides.fillChunkBuffer?.({ state, index });
      },
    },
    requestJump(index) {
      jumps.push(index);
      state.currentChunk = index;
    },
    renderQueue(chunks, activeIndex) {
      queueRenders.push({ chunks: [...chunks], activeIndex });
    },
    document: overrides.document || { activeElement: null },
    onError: (error) => {
      throw error;
    },
  });

  return { controller, els, fillRequests, jumps, queueRenders, state };
}

describe('readerEngine PDF navigation controller', () => {
  it('clamps entered PDF page jumps to the document page count while streaming chunks', async () => {
    const { controller, els, fillRequests, jumps, state } = createControllerHarness({
      async fillChunkBuffer({ state: currentState }) {
        if (currentState.chunks.length === 2) {
          currentState.chunks.push({ speech: 'Page two.', pageNumber: 2 });
          return;
        }
        currentState.chunks.push({ speech: 'Page five.', pageNumber: 5 });
      },
    });
    els.pdfPageJumpInput.value = '99';

    await controller.jumpToEnteredPdfPage();

    expect(fillRequests).toEqual([2, 3]);
    expect(jumps).toEqual([3]);
    expect(state.currentChunk).toBe(3);
  });

  it('refuses page jumps when the active read is not a controllable PDF session', async () => {
    const { controller, jumps, fillRequests } = createControllerHarness({
      state: {
        source: 'html',
        readingState: 'idle',
      },
    });

    await controller.jumpToPdfPage(1);

    expect(jumps).toEqual([]);
    expect(fillRequests).toEqual([]);
  });

  it('stops streaming once loaded pages have passed the requested PDF page', async () => {
    const { controller, jumps, queueRenders } = createControllerHarness({
      state: {
        chunks: [{ speech: 'Page one.', pageNumber: 1 }],
        pdfPageCount: 10,
      },
      async fillChunkBuffer({ state }) {
        state.chunks.push({ speech: 'Page four.', pageNumber: 4 });
      },
    });

    await controller.jumpToPdfPage(3);

    expect(jumps).toEqual([]);
    expect(queueRenders).toHaveLength(1);
    expect(queueRenders[0].chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 4]);
  });

  it('renders PDF page controls from the current navigation state', () => {
    const { controller, els, state } = createControllerHarness({
      state: {
        chunks: [
          { speech: 'Page one.', pageNumber: 1 },
          { speech: 'Page two.', pageNumber: 2 },
        ],
        currentChunk: 1,
        pdfPageCount: 5,
      },
    });

    controller.renderPdfPageControls();

    expect(els.pdfPageNav.hidden).toBe(false);
    expect(els.pdfPageJumpInput).toMatchObject({
      min: '1',
      max: '5',
      value: '2',
      disabled: false,
    });
    expect(els.pdfPageFirst.disabled).toBe(false);
    expect(els.pdfPageSkip.disabled).toBe(false);

    state.source = 'html';
    controller.renderPdfPageControls();

    expect(els.pdfPageNav.hidden).toBe(true);
  });
});
