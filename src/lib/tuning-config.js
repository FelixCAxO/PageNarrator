const TTS_PROFILE_CONFIGS = Object.freeze({
  quality: Object.freeze({
    profile: 'quality',
    maxChunkLength: 480,
    targetMinLength: 260,
    preloadAhead: 4,
    speechPreloadTimeoutMs: 60_000,
    progressiveSegments: false,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    maxChunkLength: 320,
    targetMinLength: 180,
    preloadAhead: 2,
    speechPreloadTimeoutMs: 60_000,
    progressiveSegments: false,
  }),
  lowPower: Object.freeze({
    profile: 'lowPower',
    maxChunkLength: 240,
    targetMinLength: 120,
    preloadAhead: 2,
    speechPreloadTimeoutMs: 60_000,
    progressiveSegments: true,
  }),
});

export const TUNING_CONFIG = Object.freeze({
  ttsProfiles: Object.freeze({
    slowCpuRealTimeFactor: 0.95,
    slowModelLoadMs: 20000,
    slowSectionTransitionMs: 2000,
    lowPowerMemoryGb: 2,
    balancedMemoryGb: 8,
    lowCoreCpuCount: 2,
    configs: TTS_PROFILE_CONFIGS,
  }),
  speechChunking: Object.freeze({
    defaultMaxLength: 480,
    defaultTargetMinLength: 260,
  }),
  playback: Object.freeze({
    wordHighlightLeadSeconds: 0,
    sectionEarlyAdvanceTailSeconds: 0.05,
    audioEndedGapThresholdSeconds: 0.5,
    audioEndedGapMaxDelayMs: 250,
    highlightPlanResyncDriftSeconds: 0.03,
    defaultAudioWatchdogDelayMs: 65000,
    fastPlaybackWatchdogBufferMs: 10000,
    normalPlaybackWatchdogBufferMs: 15000,
    streamSynthesisTimeoutMs: 2500,
    pdfViewerMessageTimeoutMs: 8000,
    pdfRenderUnloadDelayMs: 500,
    browserSpeechBoundaryTimeoutMs: 250,
    playbackSettingsWriteDebounceMs: 150,
    speechPreloadFailureBackoffMs: 1000,
  }),
  memoryBudgets: Object.freeze({
    lowPowerCorpusRssBytes: 2 * 1024 * 1024 * 1024,
    longSessionRetainedHeapBytes: 50 * 1024 * 1024,
  }),
});
