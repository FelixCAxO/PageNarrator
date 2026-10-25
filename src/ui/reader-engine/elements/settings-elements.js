

export function getReaderEngineSettingsElements(documentRef = globalThis.document) {
  const byId = (id) => documentRef.getElementById(id);

  return {
    readerSettings: byId('reader-settings'),
    voiceSettingsSummary: byId('voice-settings-summary'),
    language: byId('language-select'),
    languageStatus: byId('language-status'),
    voice: byId('voice-select'),
    ttsEngine: byId('tts-engine-select'),
    voiceEngineHelp: byId('voice-model-help'),
    kokoroRequirements: byId('kokoro-requirements'),
    omniVoiceSettings: byId('omnivoice-settings'),
    omniVoiceGender: byId('omnivoice-gender'),
    omniVoiceVariation: byId('omnivoice-variation'),
    omniVoiceVariationOut: byId('omnivoice-variation-out'),
    omniVoiceWhisper: byId('omnivoice-whisper'),
    speed: byId('speed'),
    speedOut: byId('speed-out'),
    ttsBackendStatus: byId('tts-backend-status'),
    sectionPauseSettings: byId('section-pause-settings'),
    sectionPause: byId('section-pause'),
    sectionPauseOut: byId('section-pause-out'),
    ttsPerformanceProfileLabel: byId('tts-performance-profile-label'),
    ttsPerformanceProfileSelect: byId('tts-performance-profile-select'),
    ttsPerformanceProfileBadge: byId('tts-performance-profile-badge'),
    ttsPerformanceProfileHelp: byId('tts-performance-profile-help'),
    ttsBackendPreferenceSelect: byId('tts-backend-preference-select'),
    idleReleaseEnabled: byId('idle-release-enabled'),
    highlightSettings: byId('highlight-settings'),
    highlightAreaColor: byId('highlight-area-color'),
    highlightAreaOpacity: byId('highlight-area-opacity'),
    highlightAreaOpacityOut: byId('highlight-area-opacity-out'),
    highlightWordColor: byId('highlight-word-color'),
    highlightWordOpacity: byId('highlight-word-opacity'),
    highlightWordOpacityOut: byId('highlight-word-opacity-out'),
    skipCodeSettings: byId('skip-code-settings'),
    skipCodeSnippets: byId('skip-code-snippets'),
  };
}
