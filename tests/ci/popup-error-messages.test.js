import { describe, expect, it } from 'vitest';
import { getPopupRecoveryMessage } from '../../src/lib/ui-error-messages.js';

describe('popup recovery messages', () => {
  it('maps known extension access failures to actionable copy', () => {
    expect(getPopupRecoveryMessage({ code: 'PAGENARRATOR_TAB_URL_HIDDEN' })).toContain('PageNarrator icon');
    expect(getPopupRecoveryMessage({ code: 'PAGENARRATOR_UNSCRIPTABLE_URL' })).toContain('Chrome pages cannot be read');
    expect(getPopupRecoveryMessage({ code: 'PAGENARRATOR_STORAGE_QUOTA' })).toContain('Free browser storage');
  });

  it('does not surface raw Chrome permission text for host-access failures', () => {
    const message = getPopupRecoveryMessage(new Error('Cannot access contents of the page. Extension manifest must request permission.'));

    expect(message).toContain('Allow site access');
    expect(message).not.toContain('Extension manifest');
  });
});
