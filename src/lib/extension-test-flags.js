export const TEST_HOOKS_STORAGE_KEY = 'pnTestHooksEnabled';
export const TEST_SILENT_TTS_STORAGE_KEY = 'pnTestSilentTts';
export const TEST_RECORD_FLOW_STORAGE_KEY = 'pnTestRecordFlow';
export const TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY = 'pnTestForceKokoroFailure';

export const TEST_FLAG_STORAGE_KEYS = Object.freeze([
  TEST_HOOKS_STORAGE_KEY,
  TEST_SILENT_TTS_STORAGE_KEY,
  TEST_RECORD_FLOW_STORAGE_KEY,
  TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY,
]);

const TEST_FLAG_DEFAULTS = Object.freeze({
  [TEST_HOOKS_STORAGE_KEY]: false,
  [TEST_SILENT_TTS_STORAGE_KEY]: false,
  [TEST_RECORD_FLOW_STORAGE_KEY]: false,
  [TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY]: false,
});

export async function readExtensionTestFlags(storage, {
  removeStaleFlags = true,
  logger = null,
} = {}) {
  let state = {};
  try {
    state = await storage?.get?.(TEST_FLAG_DEFAULTS) || {};
  } catch (error) {
    logger?.warn?.('Could not read PageNarrator test flags.', error);
    return createResolvedTestFlags();
  }

  const hooksEnabled = state?.[TEST_HOOKS_STORAGE_KEY] === true;
  if (!hooksEnabled) {
    if (removeStaleFlags && hasStaleTestFlags(state)) {
      try {
        await storage?.remove?.(TEST_FLAG_STORAGE_KEYS);
      } catch (error) {
        logger?.warn?.('Could not clear stale PageNarrator test flags.', error);
      }
    }
    return createResolvedTestFlags();
  }

  return createResolvedTestFlags({
    hooksEnabled: true,
    silentTts: state?.[TEST_SILENT_TTS_STORAGE_KEY] === true,
    recordFlow: state?.[TEST_RECORD_FLOW_STORAGE_KEY] === true,
    forceKokoroFailure: state?.[TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY] === true,
  });
}

function createResolvedTestFlags({
  hooksEnabled = false,
  silentTts = false,
  recordFlow = false,
  forceKokoroFailure = false,
} = {}) {
  return {
    hooksEnabled,
    silentTts,
    recordFlow,
    forceKokoroFailure,
  };
}

function hasStaleTestFlags(state = {}) {
  return TEST_FLAG_STORAGE_KEYS.some((key) => state?.[key] === true);
}
