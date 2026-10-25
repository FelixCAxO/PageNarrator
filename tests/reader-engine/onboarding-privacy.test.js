import { describe, expect, it, vi } from 'vitest';
import {
  createReaderEngineOnboardingController,
  ONBOARDING_STORAGE_KEY,
} from '../../src/lib/reader-engine-onboarding-controller.js';
import {
  createReaderEngineReviewPromptController,
  REVIEW_STORAGE_KEY,
} from '../../src/lib/reader-engine-review-prompt-controller.js';

function createMemoryStorage() {
  const store = {};
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

function createOnboardingEls() {
  return {
    onboardingBanner: { hidden: true },
    onboardingTitle: { textContent: '' },
    onboardingBody: { textContent: '' },
    onboardingPrimary: { textContent: '', addEventListener() {} },
    onboardingDismiss: { addEventListener() {} },
  };
}

function createReviewEls() {
  return {
    reviewPrompt: { hidden: true },
    reviewPromptTitle: { textContent: '' },
    reviewPromptBody: { textContent: '' },
    reviewNever: { addEventListener() {} },
    reviewLater: { addEventListener() {} },
    reviewReview: { addEventListener() {} },
  };
}

describe('onboarding and review prompt privacy', () => {
  it('persists only progress metadata and opens only the Chrome Web Store review URL', async () => {
    const storage = createMemoryStorage();
    const openReview = vi.fn();
    let currentDay = '2026-06-14';
    const onboardingController = createReaderEngineOnboardingController({
      els: createOnboardingEls(),
      storage,
      getMessage: (key) => key,
    });
    const reviewPromptController = createReaderEngineReviewPromptController({
      els: createReviewEls(),
      storage,
      getMessage: (key) => key,
      now: () => new Date(`${currentDay}T12:00:00`),
      getExtensionId: () => 'abc',
      openReview,
    });

    await onboardingController.init();
    await reviewPromptController.init();
    await onboardingController.recordSuccessfulRead({
      source: 'selection',
      url: 'https://private.example/article',
      title: 'Private title',
      text: 'Selected private sentence.',
      href: 'https://private.example/link',
    });
    await onboardingController.recordSuccessfulRead({
      source: 'article',
      url: 'https://private.example/article',
      title: 'Private title',
      text: 'Full private article.',
      href: 'https://private.example/link',
    });
    onboardingController.render({ readingState: 'idle' });

    await reviewPromptController.recordSuccessfulRead();
    currentDay = '2026-06-15';
    await reviewPromptController.recordSuccessfulRead();
    currentDay = '2026-06-16';
    await reviewPromptController.recordSuccessfulRead();
    await reviewPromptController.maybeShow({ readingState: 'finished', protected: false });
    await reviewPromptController.setLater();
    await reviewPromptController.setNever();
    await reviewPromptController.openStoreReview();

    for (const write of storage.writes) {
      const [key, state] = Object.entries(write)[0];
      const allowedKeys = key === ONBOARDING_STORAGE_KEY
        ? ['completed', 'step', 'version']
        : ['dismissed', 'lastCountedDay', 'lastShownDay', 'laterAt', 'successDays', 'version'];

      expect([ONBOARDING_STORAGE_KEY, REVIEW_STORAGE_KEY]).toContain(key);
      expect(Object.keys(state).sort()).toEqual(allowedKeys);
      expect(JSON.stringify(state)).not.toMatch(/https?:/);
      expect(JSON.stringify(state)).not.toContain('Private title');
      expect(JSON.stringify(state)).not.toContain('private sentence');
      expect(JSON.stringify(state)).not.toContain('private article');
      expect(state).not.toHaveProperty('url');
      expect(state).not.toHaveProperty('title');
      expect(state).not.toHaveProperty('text');
      expect(state).not.toHaveProperty('href');
    }

    expect(openReview).toHaveBeenCalledWith('https://chromewebstore.google.com/detail/abc/reviews');
  });
});
