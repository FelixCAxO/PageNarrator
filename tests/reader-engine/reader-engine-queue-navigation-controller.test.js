import { describe, expect, it } from 'vitest';
import { createReaderEngineQueueNavigationController } from '../../src/lib/reader-engine-queue-navigation-controller.js';

function createEls() {
  return {
    queueNav: { hidden: true },
    queueFirst: { disabled: false },
    queueJumpInput: {
      disabled: false,
      min: '',
      max: '',
      value: '',
    },
    queueJump: { disabled: false },
    queueLast: { disabled: false },
  };
}

describe('readerEngine queue navigation controller', () => {
  it('jumps to first, last, and entered sections using loaded chunk bounds', () => {
    const els = createEls();
    const jumps = [];
    const state = {
      get chunks() {
        return ['one', 'two', 'three'];
      },
      get readingState() {
        return 'reading';
      },
    };
    const controller = createReaderEngineQueueNavigationController({
      els,
      state,
      requestJump: (index) => jumps.push(index),
    });

    controller.jumpToFirstChunk();
    controller.jumpToLastLoadedChunk();
    els.queueJumpInput.value = '2';
    controller.jumpToEnteredChunk();

    expect(jumps).toEqual([0, 2, 1]);
  });

  it('renders disabled queue controls when reading is not active', () => {
    const els = createEls();
    const controller = createReaderEngineQueueNavigationController({
      els,
      state: {
        get readingState() {
          return 'idle';
        },
      },
    });

    controller.renderQueueNavigation(['one', 'two'], 1);

    expect(els.queueNav.hidden).toBe(false);
    expect(els.queueJumpInput).toMatchObject({
      min: '1',
      max: '2',
      value: '2',
      disabled: true,
    });
    expect(els.queueFirst.disabled).toBe(true);
    expect(els.queueJump.disabled).toBe(true);
    expect(els.queueLast.disabled).toBe(true);
  });

  it('does not overwrite the section input while the user is editing it', () => {
    const els = createEls();
    els.queueJumpInput.value = 'custom';
    const controller = createReaderEngineQueueNavigationController({
      els,
      state: {
        get readingState() {
          return 'paused';
        },
      },
      document: { activeElement: els.queueJumpInput },
    });

    controller.renderQueueNavigation(['one', 'two', 'three'], 2);

    expect(els.queueJumpInput.value).toBe('custom');
    expect(els.queueLast.disabled).toBe(true);
  });
});
