import { describe, expect, it, vi } from 'vitest';
import {
  readExtensionTestFlags,
  TEST_FLAG_STORAGE_KEYS,
  TEST_HOOKS_STORAGE_KEY,
} from '../../src/lib/extension-test-flags.js';

function createStorage(initialState = {}) {
  const state = { ...initialState };
  return {
    get: vi.fn(async (defaults) => ({
      ...defaults,
      ...state,
    })),
    remove: vi.fn(async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }),
    state,
  };
}

describe('extension test flags', () => {
  it('ignores and clears stale silent TTS flags unless test hooks are explicitly enabled', async () => {
    const storage = createStorage({
      pnTestSilentTts: true,
      pnTestRecordFlow: true,
      pnTestForceKokoroFailure: true,
    });

    await expect(readExtensionTestFlags(storage)).resolves.toEqual({
      hooksEnabled: false,
      silentTts: false,
      recordFlow: false,
      forceKokoroFailure: false,
    });
    expect(storage.remove).toHaveBeenCalledWith(TEST_FLAG_STORAGE_KEYS);
    expect(storage.state).toEqual({});
  });

  it('honors deterministic e2e flags only after the test hook guard is enabled', async () => {
    const storage = createStorage({
      [TEST_HOOKS_STORAGE_KEY]: true,
      pnTestSilentTts: true,
      pnTestRecordFlow: true,
      pnTestForceKokoroFailure: true,
    });

    await expect(readExtensionTestFlags(storage)).resolves.toEqual({
      hooksEnabled: true,
      silentTts: true,
      recordFlow: true,
      forceKokoroFailure: true,
    });
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
