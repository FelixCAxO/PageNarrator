import { describe, expect, it } from 'vitest';
import { getReaderEngineRecoveryActions } from '../../src/lib/reader-engine-error-notices.js';

describe('readerEngine recovery notices', () => {
  it('offers a same-session Grant site access action', () => {
    expect(getReaderEngineRecoveryActions({ code: 'host_permission_required' })).toEqual([
      { label: 'Grant site access', action: 'grant-access' },
    ]);
  });
});
