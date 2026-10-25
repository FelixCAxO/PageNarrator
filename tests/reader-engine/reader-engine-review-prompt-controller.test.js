import { describe, expect, it, vi } from 'vitest';
import {
  createReaderEngineReviewPromptController,
  REVIEW_STORAGE_KEY,
  REVIEW_THRESHOLD,
} from '../../src/lib/reader-engine-review-prompt-controller.js';

function createMemoryStorage(initial = {}) {
  const store = { ...initial };
  const writes = [];
  return {
    writes,
    async get(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
    },
    async set(value) {
      writes.push(value);
      Object.assign(store, value);
    },
  };
}

function createDeferredStorage(initial = {}) {
  let resolveGet;
  const getStarted = new Promise((resolve) => {
    resolveGet = resolve;
  });
  const storage = createMemoryStorage(initial);
  return {
    ...storage,
    getStarted,
    releaseGet: () => resolveGet(),
    async get(key) {
      await getStarted;
      return storage.get(key);
    },
  };
}

function createReviewEls() {
  const listeners = new Map();
  const button = (id) => ({
    id,
    addEventListener(type, callback) {
      listeners.set(`${id}:${type}`, callback);
    },
  });
  return {
    listeners,
    els: {
      reviewPrompt: { hidden: true },
      reviewPromptTitle: { textContent: '' },
      reviewPromptBody: { textContent: '' },
      reviewNever: button('never'),
      reviewLater: button('later'),
      reviewReview: button('review'),
    },
  };
}

describe('readerEngine review prompt controller', () => {
  it('shows only after three successful reads on distinct days', async () => {
    let currentDay = '2026-06-14';
    const storage = createMemoryStorage();
    const { els } = createReviewEls();
    const openReview = vi.fn();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      getMessage: (key) => key,
      now: () => new Date(`${currentDay}T12:00:00`),
      getExtensionId: () => 'abc',
      openReview,
    });

    await controller.init();
    await controller.recordSuccessfulRead();

    expect(REVIEW_STORAGE_KEY).toBe('pn:onboard:reviewState.v1');
    expect(REVIEW_THRESHOLD).toBe(3);
    expect(storage.writes.at(-1)[REVIEW_STORAGE_KEY].successDays).toBe(1);
    expect(await controller.maybeShow({ readingState: 'finished', protected: false })).toBe(false);
    expect(els.reviewPrompt.hidden).toBe(true);

    currentDay = '2026-06-15';
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-16';
    await controller.recordSuccessfulRead();

    expect(storage.writes.at(-1)[REVIEW_STORAGE_KEY].successDays).toBe(3);
    expect(await controller.maybeShow({ readingState: 'finished', protected: false })).toBe(true);
    expect(els.reviewPrompt.hidden).toBe(false);
    expect(els.reviewPromptTitle.textContent).toBe('reviewPromptTitle');
    expect(els.reviewPromptBody.textContent).toBe('reviewPromptBody');
    expect(openReview).not.toHaveBeenCalled();
  });

  it('counts same-day successful reads once per readerEngine session', async () => {
    const storage = createMemoryStorage();
    const openReview = vi.fn();
    const createController = async () => {
      const { els } = createReviewEls();
      const controller = createReaderEngineReviewPromptController({
        els,
        storage,
        getMessage: (key) => key,
        now: () => new Date('2026-06-14T12:00:00'),
        getExtensionId: () => 'abc',
        openReview,
      });
      await controller.init();
      return { controller, els };
    };

    const firstSession = await createController();
    await firstSession.controller.recordSuccessfulRead();
    await firstSession.controller.recordSuccessfulRead();
    expect(storage.writes.at(-1)[REVIEW_STORAGE_KEY].successDays).toBe(1);

    const secondSession = await createController();
    await secondSession.controller.recordSuccessfulRead();
    expect(storage.writes.at(-1)[REVIEW_STORAGE_KEY].successDays).toBe(2);

    const thirdSession = await createController();
    await thirdSession.controller.recordSuccessfulRead();
    expect(storage.writes.at(-1)[REVIEW_STORAGE_KEY].successDays).toBe(3);
    expect(await thirdSession.controller.maybeShow({ readingState: 'finished', protected: false })).toBe(true);
    expect(thirdSession.els.reviewPrompt.hidden).toBe(false);
  });

  it('never shows on the first successful read', async () => {
    const storage = createMemoryStorage();
    const { els } = createReviewEls();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      now: () => new Date('2026-06-14T12:00:00'),
      getMessage: (key) => key,
    });

    await controller.init();
    await controller.recordSuccessfulRead();

    expect(await controller.maybeShow({ readingState: 'finished', protected: false })).toBe(false);
    expect(els.reviewPrompt.hidden).toBe(true);
  });

  it('shows only when the reader is at rest', async () => {
    let currentDay = '2026-06-14';
    const storage = createMemoryStorage();
    const { els } = createReviewEls();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      now: () => new Date(`${currentDay}T12:00:00`),
      getMessage: (key) => key,
    });

    await controller.init();
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-15';
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-16';
    await controller.recordSuccessfulRead();

    expect(await controller.maybeShow({ readingState: 'preparing', protected: false })).toBe(false);
    expect(els.reviewPrompt.hidden).toBe(true);
  });

  it('honors Never as a permanent dismissal', async () => {
    let currentDay = '2026-06-14';
    const storage = createMemoryStorage();
    const { els } = createReviewEls();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      now: () => new Date(`${currentDay}T12:00:00`),
      getMessage: (key) => key,
    });

    await controller.init();
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-15';
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-16';
    await controller.recordSuccessfulRead();
    await controller.setNever();

    expect(await controller.maybeShow({ readingState: 'finished', protected: false })).toBe(false);
    expect(els.reviewPrompt.hidden).toBe(true);
  });

  it('hides a visible prompt when an active read starts', async () => {
    let currentDay = '2026-06-14';
    const storage = createMemoryStorage();
    const { els } = createReviewEls();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      now: () => new Date(`${currentDay}T12:00:00`),
      getMessage: (key) => key,
    });

    await controller.init();
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-15';
    await controller.recordSuccessfulRead();
    currentDay = '2026-06-16';
    await controller.recordSuccessfulRead();
    await controller.maybeShow({ readingState: 'finished', protected: false });

    expect(els.reviewPrompt.hidden).toBe(false);

    controller.hide();

    expect(els.reviewPrompt.hidden).toBe(true);
  });

  it('does not overwrite dismissed state while storage initialization is still loading', async () => {
    const storage = createDeferredStorage({
      [REVIEW_STORAGE_KEY]: {
        version: 1,
        successDays: 3,
        lastCountedDay: '2026-06-13',
        lastShownDay: '2026-06-13',
        dismissed: true,
        laterAt: '',
      },
    });
    const { els } = createReviewEls();
    const controller = createReaderEngineReviewPromptController({
      els,
      storage,
      now: () => new Date('2026-06-14T12:00:00'),
      getMessage: (key) => key,
    });

    const init = controller.init();
    const record = controller.recordSuccessfulRead();
    storage.releaseGet();
    await Promise.all([init, record]);

    expect(storage.writes).toEqual([]);
    expect(await controller.maybeShow({ readingState: 'finished', protected: false })).toBe(false);
    expect(els.reviewPrompt.hidden).toBe(true);
  });
});
