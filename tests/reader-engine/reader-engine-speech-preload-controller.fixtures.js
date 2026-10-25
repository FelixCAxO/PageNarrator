import {
  createReaderEngineSpeechPreloadController,
} from '../../src/lib/reader-engine-speech-preload-controller.js';

export function createController(overrides = {}) {
  const { state: stateOverrides = {}, ...rest } = overrides;
  return createReaderEngineSpeechPreloadController({
    state: {
      activeChunks: [],
      activeSpeechPreloadCleanup: () => {},
      selectedLanguageCode: 'en',
      testForceKokoroFailureEnabled: false,
      testSilentTtsEnabled: false,
      getSelectedVoiceId: () => 'af_heart',
      ...stateOverrides,
    },
    playbackSession: {
      setActiveSpeechPreloadCleanup() {},
      clearActiveSpeechPreloads() {},
    },
    readRunTracker: { isCurrentRun: () => true },
    getActiveTtsProfileConfig: () => ({ preloadAhead: 1, progressiveSegments: false }),
    resolveSelectedVoice: () => ({ engine: 'kokoro', id: 'af_heart', detectCode: 'en' }),
    trackActiveVoiceSynthesisPromise: (promise) => promise,
    trackActiveVoiceSynthesisSegments: (segments) => segments,
    highlightQueuedChunk: async () => {},
    suppressError: () => {},
    recordFirstSynthesis: () => {},
    recordSectionSynthesis: () => {},
    ...rest,
  });
}
