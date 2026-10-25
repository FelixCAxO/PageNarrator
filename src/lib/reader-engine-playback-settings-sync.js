import { normalizeLanguageCode } from './language-voice-options.js';
import { logSuppressedError } from './logger.js';

export async function applyPlaybackSettingsFromStorage({
  els = {},
  getSelectedLanguageCode = () => 'en',
  setSelectedLanguageCode = () => {},
  readerEngineStorage,
  readerEngineSettingsManager,
  populateVoices = async () => {},
  updateVoiceSettingsSummary = () => {},
  renderLanguageStatus = () => {},
  warmSelectedVoice = async () => {},
  renderTtsBackendPreferenceSetting = () => {},
  renderTtsPerformanceProfileSetting = () => {},
  renderIdleReleaseSetting = () => {},
  renderHighlightSettings = () => {},
  renderSkipCodeSettings = () => {},
  resetTtsPerformanceGovernor = () => {},
  renderVoiceEngineSetting = () => {},
  onVoiceSelectionChanged = () => {},
} = {}) {
  const settings = await readerEngineStorage?.getPlaybackSettings?.().catch(() => null);
  if (!settings) return;
  const engineChanged = (els.ttsEngine?.value || 'kokoro') !== settings.ttsEngine;
  renderVoiceEngineSetting(settings);

  const nextLanguage = normalizeLanguageCode(settings.language || getSelectedLanguageCode());
  const languageChanged = nextLanguage !== getSelectedLanguageCode();
  setSelectedLanguageCode(nextLanguage);
  if (els.language) els.language.value = nextLanguage;
  const storedVoiceForLang = settings.voicesByLanguage?.[nextLanguage] || settings.voice;
  const hasVoiceOption = storedVoiceForLang && Array.from(els.voice?.options || [])
    .some((option) => option.value === storedVoiceForLang);
  if (engineChanged || languageChanged || !hasVoiceOption) {
    await populateVoices();
  }
  const updatedHasVoiceOption = storedVoiceForLang && Array.from(els.voice?.options || [])
    .some((option) => option.value === storedVoiceForLang);
  if (updatedHasVoiceOption && els.voice) {
    els.voice.value = storedVoiceForLang;
  }
  updateVoiceSettingsSummary?.();
  void Promise.resolve(renderLanguageStatus?.()).catch(logSuppressedError);
  if (els.voice?.value) void Promise.resolve(warmSelectedVoice?.(els.voice.value)).catch(logSuppressedError);

  readerEngineSettingsManager?.setPlaybackSpeed?.(settings.speed, { persist: false });
  readerEngineSettingsManager?.setSectionPause?.(settings.sectionPauseSeconds, { persist: false });
  renderTtsBackendPreferenceSetting(settings.ttsBackendPreference);
  renderTtsPerformanceProfileSetting(settings.ttsPerformanceProfile);
  renderIdleReleaseSetting(settings.idleReleaseEnabled);
  renderHighlightSettings(settings.highlight);
  renderSkipCodeSettings(settings.skipCodeSnippets);
  resetTtsPerformanceGovernor(settings);
  onVoiceSelectionChanged();
}
