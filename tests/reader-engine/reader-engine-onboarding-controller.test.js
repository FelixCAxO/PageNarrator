import { describe, expect, it } from 'vitest';
import {
  createReaderEngineOnboardingController,
  ONBOARDING_STORAGE_KEY,
} from '../../src/lib/reader-engine-onboarding-controller.js';

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

function createOnboardingEls() {
  const listeners = new Map();
  const button = (id) => ({
    id,
    textContent: '',
    hidden: false,
    addEventListener(type, callback) {
      listeners.set(`${id}:${type}`, callback);
    },
  });
  return {
    listeners,
    els: {
      onboardingBanner: { hidden: true },
      onboardingTitle: { textContent: '' },
      onboardingBody: { textContent: '' },
      onboardingPrimary: button('primary'),
      onboardingDismiss: button('dismiss'),
      readSelected: button('read-selected'),
    },
  };
}

describe('readerEngine onboarding controller', () => {
  it('starts fresh users at the selected-text quick win', async () => {
    const storage = createMemoryStorage();
    const controller = createReaderEngineOnboardingController({ storage });

    await controller.init();

    expect(ONBOARDING_STORAGE_KEY).toBe('pn:onboard:progress.v1');
    expect(controller.getStep()).toBe('quick-win');
    expect(controller.isComplete()).toBe(false);
  });

  it('renders the quick-win prompt only while the reader is at rest', async () => {
    const storage = createMemoryStorage();
    const { els } = createOnboardingEls();
    const controller = createReaderEngineOnboardingController({
      els,
      storage,
      getMessage: (key) => key,
    });

    await controller.init();
    controller.render({ readingState: 'idle' });

    expect(els.onboardingBanner.hidden).toBe(false);
    expect(els.onboardingTitle.textContent).toBe('onboardingQuickWinTitle');
    expect(els.onboardingBody.textContent).toBe('onboardingQuickWinBody');
    expect(els.onboardingPrimary.textContent).toBe('onboardingQuickWinCta');
    expect(els.readSelected.hidden).toBe(true);

    controller.render({ readingState: 'reading' });

    expect(els.onboardingBanner.hidden).toBe(true);
    expect(els.readSelected.hidden).toBe(true);
  });

  it('advances from selected text to full-page and completes after a smart read', async () => {
    const storage = createMemoryStorage();
    const stepChanges = [];
    const { els } = createOnboardingEls();
    const controller = createReaderEngineOnboardingController({
      els,
      storage,
      getMessage: (key) => key,
      onStepChange: (event) => stepChanges.push(event),
    });

    await controller.init();
    controller.render({ readingState: 'idle' });
    await controller.recordSuccessfulRead({ source: 'selection' });

    expect(controller.getStep()).toBe('full-page');
    expect(controller.isComplete()).toBe(false);
    expect(storage.writes.at(-1)).toEqual({
      [ONBOARDING_STORAGE_KEY]: { version: 1, step: 'full-page', completed: false },
    });
    expect(stepChanges.at(-1)).toEqual({
      from: 'quick-win',
      to: 'full-page',
      completed: false,
      source: 'selection',
    });

    controller.render({ readingState: 'idle' });
    expect(els.onboardingBanner.hidden).toBe(false);
    expect(els.onboardingTitle.textContent).toBe('onboardingFullPageTitle');
    expect(els.onboardingBody.textContent).toBe('onboardingFullPageBody');
    expect(els.onboardingPrimary.textContent).toBe('onboardingFullPageCta');

    await controller.recordSuccessfulRead({ source: 'article' });

    expect(controller.getStep()).toBe('done');
    expect(controller.isComplete()).toBe(true);
    expect(storage.writes.at(-1)).toEqual({
      [ONBOARDING_STORAGE_KEY]: { version: 1, step: 'done', completed: true },
    });
    expect(stepChanges.at(-1)).toEqual({
      from: 'full-page',
      to: 'done',
      completed: true,
      source: 'article',
    });

    controller.render({ readingState: 'idle' });
    expect(els.onboardingBanner.hidden).toBe(true);
    expect(els.readSelected.hidden).toBe(false);
  });

  it('lets users dismiss onboarding permanently', async () => {
    const storage = createMemoryStorage();
    const { els } = createOnboardingEls();
    const controller = createReaderEngineOnboardingController({
      els,
      storage,
      getMessage: (key) => key,
    });

    await controller.init();
    controller.render({ readingState: 'idle' });
    await controller.dismiss();

    expect(controller.getStep()).toBe('done');
    expect(controller.isComplete()).toBe(true);
    expect(els.onboardingBanner.hidden).toBe(true);
    expect(els.readSelected.hidden).toBe(false);
    expect(storage.writes.at(-1)).toEqual({
      [ONBOARDING_STORAGE_KEY]: { version: 1, step: 'done', completed: true },
    });
  });

  it('does not overwrite completed progress while storage initialization is still loading', async () => {
    const storage = createDeferredStorage({
      [ONBOARDING_STORAGE_KEY]: { version: 1, step: 'done', completed: true },
    });
    const controller = createReaderEngineOnboardingController({ storage });

    const init = controller.init();
    const record = controller.recordSuccessfulRead({ source: 'selection' });
    storage.releaseGet();
    await Promise.all([init, record]);

    expect(controller.isComplete()).toBe(true);
    expect(controller.getStep()).toBe('done');
    expect(storage.writes).toEqual([]);
  });
});
