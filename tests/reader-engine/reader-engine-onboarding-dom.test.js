import { describe, expect, it } from 'vitest';
import { getReaderEngineElements } from '../../src/lib/reader-engine-dom.js';

describe('readerEngine onboarding and review DOM registration', () => {
  it('registers onboarding and review prompt elements by stable ids', () => {
    const documentRef = {
      getElementById(id) {
        return { id };
      },
      querySelector(selector) {
        return { selector };
      },
    };

    const els = getReaderEngineElements(documentRef);

    expect(els.onboardingBanner).toEqual({ id: 'onboarding-banner' });
    expect(els.onboardingTitle).toEqual({ id: 'onboarding-title' });
    expect(els.onboardingBody).toEqual({ id: 'onboarding-body' });
    expect(els.onboardingPrimary).toEqual({ id: 'onboarding-primary-btn' });
    expect(els.onboardingDismiss).toEqual({ id: 'onboarding-dismiss-btn' });
    expect(els.reviewPrompt).toEqual({ id: 'review-prompt' });
    expect(els.reviewPromptTitle).toEqual({ id: 'review-prompt-title' });
    expect(els.reviewPromptBody).toEqual({ id: 'review-prompt-body' });
    expect(els.reviewNever).toEqual({ id: 'review-never-btn' });
    expect(els.reviewLater).toEqual({ id: 'review-later-btn' });
    expect(els.reviewReview).toEqual({ id: 'review-review-btn' });
  });
});
