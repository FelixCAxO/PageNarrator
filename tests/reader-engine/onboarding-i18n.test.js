import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REQUIRED_MESSAGES = [
  'onboardingQuickWinTitle',
  'onboardingQuickWinBody',
  'onboardingQuickWinCta',
  'onboardingFullPageTitle',
  'onboardingFullPageBody',
  'onboardingFullPageCta',
  'onboardingDismiss',
  'reviewPromptTitle',
  'reviewPromptBody',
  'reviewNever',
  'reviewLater',
  'reviewReview',
];

describe('onboarding and review prompt i18n', () => {
  it('defines launch copy for every onboarding and review prompt key', () => {
    const messages = JSON.parse(
      readFileSync(new URL('../../_locales/en/messages.json', import.meta.url), 'utf8'),
    );

    for (const key of REQUIRED_MESSAGES) {
      expect(messages[key]?.message, `${key} must have copy`).toEqual(expect.any(String));
      expect(messages[key].message.trim(), `${key} must not be empty`).not.toBe('');
    }
  });
});
