import { getMessage, t, languageName } from './i18n.js';
import {
  clampPlaybackSpeed,
  clampSectionPauseSeconds,
  DEFAULT_HIGHLIGHT_SETTINGS,
  DEFAULT_TTS_BACKEND_PREFERENCE,
  TTS_PERFORMANCE_PROFILE_DEFAULT,
  formatSectionPauseLabel,
  getMaxPlaybackSpeed,
  normalizeTtsBackendPreference,
} from './playback-settings.js';
import { getDefaultVoiceId } from './voice-registry.js';
import {
  getLanguageOption,
  getLanguageOptions,
  getSelectableVoicesForLanguage,
  groupVoicesByQuality,
  formatVoiceOptionLabel,
  isExperimentalVoice,
  normalizeLanguageCode,
  resolveVoiceSelection,
  getDetectedLanguageSuggestion,
  getUnsupportedLanguageMessage,
} from './language-voice-options.js';
import {
  createTtsPerformanceGovernor,
  formatTtsPerformanceProfileOptionLabel,
  formatTtsPerformanceProfileTooltip,
  getTtsPerformanceProfileConfig,
} from './tts-performance-profile.js';
import { DEFAULT_RUNTIME_POLICY } from '../tts/runtime/default-runtime-policy.js';
import { normalizeOmniVoiceSettings, VOICE_ENGINE_HELP } from './omnivoice-settings.js';
import { OMNIVOICE_LANGUAGES, getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';
import {
  saveIdleReleaseDiagnostic,
  savePlaybackSpeed,
  saveReadingCleanupSetting,
  saveTtsDiagnostics,
  saveVoiceSelection,
} from '../platform/storage/settings-store.js';

/** @param {any} [deps] */
export function createReaderEngineVoiceSettingsController({
  els,
  readerEngineStorage,
  readerEngineSettingsManager,
  state,
  navigator = globalThis.navigator,
  getNavigator = () => navigator,
  savePlaybackSettingsSoon,
  suppressReaderEngineError = () => {},
  releaseLoadedVoiceModel = async () => false,
  canReleaseLoadedVoiceModel = () => false,
  warmSelectedVoice = async () => {},
  onVoiceSelectionChanged = () => {},
} = {}) {
  let lastAdjustedProfileDecision = null;
  let ttsBackendPreference = DEFAULT_TTS_BACKEND_PREFERENCE;
  let lastDetectedLanguage = null;

  function getSelectedLanguageCode() {
    return state?.selectedLanguageCode || 'en';
  }

  function setSelectedLanguageCode(value) {
    state?.setSelectedLanguageCode?.(value);
  }

  function getTtsPerformanceGovernor() {
    return state?.ttsPerformanceGovernor || null;
  }

  function setTtsPerformanceGovernor(governor) {
    state?.setTtsPerformanceGovernor?.(governor);
  }

  function populateLanguageOptions() {
    els.language.replaceChildren();
    const languages = els.ttsEngine?.value === 'omnivoice' ? OMNIVOICE_LANGUAGES : getLanguageOptions();
    for (const language of languages) {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = languageName(language.code, language.label);
      els.language.appendChild(option);
    }
    if (!languages.some((language) => language.code === getSelectedLanguageCode())) {
      setSelectedLanguageCode(languages.find((language) => language.code === 'en')?.code
        || languages[0]?.code
        || 'en');
    }
    els.language.value = getSelectedLanguageCode();
  }

  async function populateVoices() {
    populateLanguageOptions();
    globalThis.__pnReaderEngineInitStage = 'voices-options';
    const voices = getSelectableVoicesForLanguage(getSelectedLanguageCode());
    const currentSelection = els.voice?.value || null;

    const fragment = document.createDocumentFragment();
    const { gradedVoices, experimentalVoices } = groupVoicesByQuality(voices);
    appendVoiceOptions(fragment, gradedVoices);

    if (experimentalVoices.length > 0) {
      const group = document.createElement('optgroup');
      group.label = t("Experimental - quality not validated");
      appendVoiceOptions(group, experimentalVoices);
      fragment.appendChild(group);
    }

    globalThis.__pnReaderEngineInitStage = 'voices-saved';
    const savedVoice = await readerEngineStorage.getStoredVoiceForLanguage(getSelectedLanguageCode()).catch(() => null);

    if (els.voice) els.voice.replaceChildren(fragment);

    if (savedVoice && voices.some((voice) => voice.id === savedVoice)) {
      if (els.voice) els.voice.value = savedVoice;
    } else if (currentSelection && voices.some((voice) => voice.id === currentSelection)) {
      if (els.voice) els.voice.value = currentSelection;
    } else {
      if (els.voice) els.voice.value = voices[0]?.id || getDefaultVoiceId();
    }

    updateVoiceSettingsSummary();
    globalThis.__pnReaderEngineInitStage = 'voices-ready';
    void renderLanguageStatus().catch(suppressReaderEngineError);
  }

  function appendVoiceOptions(parent, voices) {
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = formatVoiceOptionLabel(voice);
      parent.appendChild(option);
    }
  }

  function bindVoiceSettings() {
    els.ttsEngine?.addEventListener('change', async () => {
      if (els.readerSettings) els.readerSettings.open = true;
      updateVoiceSettingsSummary();
      await populateVoices();
      resetTtsPerformanceGovernor({ ttsPerformanceProfile: els.ttsPerformanceProfileSelect?.value, ttsBackendPreference });
      savePlaybackSettingsSoon({ ttsEngine: els.ttsEngine.value, language: getSelectedLanguageCode() });
      onVoiceSelectionChanged();
    });
    for (const control of [els.omniVoiceGender, els.omniVoiceVariation, els.omniVoiceWhisper]) {
      control?.addEventListener('input', () => {
        renderOmniVoiceSettings(getOmniVoiceSettings());
        updateVoiceSettingsSummary();
        savePlaybackSettingsSoon({ omniVoice: getOmniVoiceSettings() });
        onVoiceSelectionChanged();
      });
    }
    els.language.addEventListener('change', async () => {
      setSelectedLanguageCode(normalizeLanguageCode(els.language.value));
      await saveVoiceSelection({
        language: getSelectedLanguageCode(),
        storage: readerEngineStorage.rawStorage,
      }).catch(suppressReaderEngineError);
      await populateVoices();
      onVoiceSelectionChanged();
    });

    els.voice.addEventListener('change', async () => {
      void saveVoiceSelection({
        language: getSelectedLanguageCode(),
        voice: els.voice.value,
        storage: readerEngineStorage.rawStorage,
      }).catch(suppressReaderEngineError);
      updateVoiceSettingsSummary();
      void renderLanguageStatus().catch(suppressReaderEngineError);
      void warmSelectedVoice(els.voice.value).catch(suppressReaderEngineError);
      onVoiceSelectionChanged();
    });

    renderSpeedSetting();
    updateVoiceSettingsSummary();

    els.speed.addEventListener('input', () => {
      const speed = getPlaybackSpeed();
      els.speedOut.textContent = `${speed.toFixed(2)}x`;
      updateVoiceSettingsSummary();
      void savePlaybackSpeed(speed, {
        storage: readerEngineStorage.rawStorage,
      }).catch(suppressReaderEngineError);
    });

    if (areAdvancedTtsControlsEnabled()) {
      els.ttsPerformanceProfileSelect?.addEventListener('change', handleTtsPerformanceProfileInput);
      els.ttsBackendPreferenceSelect?.addEventListener('change', handleTtsBackendPreferenceInput);
      els.idleReleaseEnabled?.addEventListener('change', handleIdleReleaseInput);
    }
    els.sectionPause?.addEventListener('input', handleSectionPauseInput);

    for (const control of [
      els.highlightAreaColor,
      els.highlightAreaOpacity,
      els.highlightWordColor,
      els.highlightWordOpacity,
    ]) {
      control?.addEventListener('input', handleHighlightSettingsInput);
    }

    els.skipCodeSnippets?.addEventListener('change', handleSkipCodeSettingsInput);
  }

  function renderSpeedSetting() {
    const max = getMaxPlaybackSpeed();
    els.speed.max = String(max);
    els.speed.value = String(clampPlaybackSpeed(els.speed.value));
    els.speedOut.textContent = `${getPlaybackSpeed().toFixed(2)}x`;
    updateVoiceSettingsSummary();
  }

  function updateVoiceSettingsSummary() {
    const omni = els.ttsEngine?.value === 'omnivoice';
    if (els.omniVoiceSettings) els.omniVoiceSettings.hidden = !omni;
    if (els.voice?.closest('label')) els.voice.closest('label').hidden = omni;
    if (els.language?.closest('label')) els.language.closest('label').hidden = !omni;
    if (els.kokoroRequirements) els.kokoroRequirements.hidden = omni;
    if (els.voiceEngineHelp) els.voiceEngineHelp.textContent = t(VOICE_ENGINE_HELP[omni ? 'omnivoice' : 'kokoro']);
    if (!els.voiceSettingsSummary) return;
    const language = getLanguageOption(getSelectedLanguageCode());
    const selectedVoice = resolveSelectedVoice();
    const voiceLabel = getCompactVoiceLabel(selectedVoice);
    const languageLabel = languageName(getSelectedLanguageCode(), language?.label || 'English');
    els.voiceSettingsSummary.textContent = `${voiceLabel} · ${languageLabel} · ${getPlaybackSpeed().toFixed(2)}x`;
  }

  function getCompactVoiceLabel(voice) {
    const label = String(voice?.label || '').trim();
    if (!label) return t("Voice");
    return label.split(' - ')[0]?.trim() || label;
  }

  function renderTtsPerformanceProfileSetting(profile = TTS_PERFORMANCE_PROFILE_DEFAULT) {
    if (!els.ttsPerformanceProfileSelect) return;
    const normalized = ['auto', 'quality', 'balanced', 'lowPower'].includes(profile)
      ? profile
      : TTS_PERFORMANCE_PROFILE_DEFAULT;
    els.ttsPerformanceProfileSelect.value = normalized;
    const governor = getTtsPerformanceGovernor();
    const governorRequestedProfile = governor?.requestedProfile?.();
    const useGovernorProfile = governorRequestedProfile === normalized;
    const currentProfile = useGovernorProfile
      ? governor?.currentProfile?.() || normalized
      : (normalized === 'auto' ? null : normalized);
    const displayProfile = currentProfile || 'balanced';
    const currentConfig = useGovernorProfile
      ? governor?.currentConfig?.() || getTtsPerformanceProfileConfig(displayProfile)
      : getTtsPerformanceProfileConfig(displayProfile);
    const autoOption = els.ttsPerformanceProfileSelect.querySelector('option[value="auto"]');
    if (autoOption) {
      autoOption.textContent = formatTtsPerformanceProfileOptionLabel('auto', normalized === 'auto' ? currentProfile : null);
    }
    if (els.ttsPerformanceProfileBadge) {
      const adjusted = lastAdjustedProfileDecision
        && lastAdjustedProfileDecision.changed
        && lastAdjustedProfileDecision.nextProfile === displayProfile;
      els.ttsPerformanceProfileBadge.textContent = adjusted
        ? t("$1 - adjusted", [formatTtsPerformanceProfileOptionLabel(displayProfile)])
        : formatTtsPerformanceProfileOptionLabel(displayProfile);
      els.ttsPerformanceProfileBadge.setAttribute('aria-live', 'polite');
      if (adjusted) {
        els.ttsPerformanceProfileBadge.dataset.adjusted = 'true';
        els.ttsPerformanceProfileBadge.title = t("Voice quality adjusted after $1.", [lastAdjustedProfileDecision.reason]);
      } else {
        delete els.ttsPerformanceProfileBadge.dataset.adjusted;
        els.ttsPerformanceProfileBadge.removeAttribute('title');
      }
    }
    const helpText = formatTtsPerformanceProfileTooltip(displayProfile, currentConfig);
    if (els.ttsPerformanceProfileHelp) els.ttsPerformanceProfileHelp.textContent = helpText;
    if (els.ttsPerformanceProfileLabel) els.ttsPerformanceProfileLabel.title = helpText;
    els.ttsPerformanceProfileSelect.title = helpText;
  }

  function renderTtsBackendPreferenceSetting(preference = DEFAULT_TTS_BACKEND_PREFERENCE) {
    ttsBackendPreference = normalizeTtsBackendPreference(preference);
    if (els.ttsBackendPreferenceSelect) els.ttsBackendPreferenceSelect.value = ttsBackendPreference;
  }

  function renderTtsBackendStatus(plan = {}) {
    if (!els.ttsBackendStatus) return;
    const device = String(plan.device || '');
    const reason = String(plan.reason || '');
    if (device === 'webgpu') {
      els.ttsBackendStatus.textContent = reason === 'marginal-webgpu'
        ? t('Voice processing: GPU (WebGPU) with CPU-friendly settings.')
        : t('Voice processing: GPU (WebGPU).');
    } else if (device === 'wasm') {
      els.ttsBackendStatus.textContent = reason === 'no-webgpu'
        ? t('Voice processing: CPU only (WebAssembly) because WebGPU is unavailable.')
        : t('Voice processing: CPU only (WebAssembly).');
    } else if (device === 'browser') {
      els.ttsBackendStatus.textContent = t("Voice processing: system voice (browser or operating system).");
    } else {
      els.ttsBackendStatus.textContent = t("Voice processing: checked when reading starts.");
    }
    els.ttsBackendStatus.dataset.backend = device || 'pending';
  }

  function renderSectionPauseSetting(sectionPauseSeconds = 0) {
    if (!els.sectionPauseSettings || !els.sectionPause) return;
    const value = clampSectionPauseSeconds(sectionPauseSeconds);
    setSettingState(els.sectionPauseSettings, [els.sectionPause]);
    readerEngineSettingsManager.renderSectionPauseSetting(value);
  }

  function updateSectionPauseOutput(sectionPauseSeconds = getSelectedSectionPauseSeconds()) {
    if (!els.sectionPauseOut) return;
    els.sectionPauseOut.textContent = formatSectionPauseLabel(sectionPauseSeconds);
  }

  function renderHighlightSettings(settings = DEFAULT_HIGHLIGHT_SETTINGS) {
    if (!els.highlightSettings) return;
    setSettingState(els.highlightSettings, [
      els.highlightAreaColor,
      els.highlightAreaOpacity,
      els.highlightWordColor,
      els.highlightWordOpacity,
    ]);
    readerEngineSettingsManager.renderHighlightSettings(settings);
  }

  function renderSkipCodeSettings(skipCodeSnippets = false) {
    if (!els.skipCodeSettings || !els.skipCodeSnippets) return;
    setSettingState(els.skipCodeSettings, [els.skipCodeSnippets]);
    els.skipCodeSnippets.checked = skipCodeSnippets === true;
  }

  function renderIdleReleaseSetting(enabled = true) {
    if (!els.idleReleaseEnabled) return;
    els.idleReleaseEnabled.checked = enabled !== false;
  }

  function setSettingState(section, controls = []) {
    if (!section) return;
    section.hidden = false;
    delete section.dataset.locked;
    section.removeAttribute('aria-disabled');
    for (const control of controls) {
      if (!control) continue;
      control.disabled = false;
      control.removeAttribute('aria-disabled');
    }
    section.removeAttribute('tabindex');
    section.onclick = null;
    section.onkeydown = null;
    section.title = '';
    for (const control of controls) {
      control?.removeAttribute?.('aria-disabled');
    }
  }

  function getSelectedHighlightSettings() {
    return readerEngineSettingsManager.getSelectedHighlightSettings();
  }

  function handleHighlightSettingsInput() {
    readerEngineSettingsManager.handleHighlightSettingsInput();
  }

  function getSelectedSectionPauseSeconds() {
    return readerEngineSettingsManager.getSelectedSectionPauseSeconds();
  }

  function handleSectionPauseInput() {
    const sectionPauseSeconds = getSelectedSectionPauseSeconds();
    updateSectionPauseOutput(sectionPauseSeconds);
    savePlaybackSettingsSoon({ sectionPauseSeconds: getSelectedSectionPauseSeconds() });
  }

  function handleTtsPerformanceProfileInput() {
    const ttsPerformanceProfile = els.ttsPerformanceProfileSelect?.value || TTS_PERFORMANCE_PROFILE_DEFAULT;
    lastAdjustedProfileDecision = null;
    resetTtsPerformanceGovernor({ ttsPerformanceProfile });
    renderTtsPerformanceProfileSetting(ttsPerformanceProfile);
    void saveTtsDiagnostics({ ttsPerformanceProfile }, {
      storage: readerEngineStorage.rawStorage,
    }).catch(suppressReaderEngineError);
    maybeReleaseLoadedVoiceModelAfterPerformanceProfileChange();
  }

  function handleTtsBackendPreferenceInput() {
    renderTtsBackendPreferenceSetting(els.ttsBackendPreferenceSelect?.value);
    void saveTtsDiagnostics({ ttsBackendPreference }, {
      storage: readerEngineStorage.rawStorage,
    }).catch(suppressReaderEngineError);
    maybeReleaseLoadedVoiceModelAfterPerformanceProfileChange();
  }

  function getSelectedSkipCodeSnippets() {
    return Boolean(els.skipCodeSnippets?.checked);
  }

  function handleSkipCodeSettingsInput() {
    void saveReadingCleanupSetting(getSelectedSkipCodeSnippets(), {
      storage: readerEngineStorage.rawStorage,
    }).catch(suppressReaderEngineError);
  }

  function handleIdleReleaseInput() {
    const idleReleaseEnabled = els.idleReleaseEnabled?.checked !== false;
    state?.setIdleReleaseEnabled?.(idleReleaseEnabled);
    void saveIdleReleaseDiagnostic(idleReleaseEnabled, {
      storage: readerEngineStorage.rawStorage,
    }).catch(suppressReaderEngineError);
  }

  /** @param {any} [detected] */
  async function renderLanguageStatus(detected = null) {
    if (detected) lastDetectedLanguage = detected;
    detected = lastDetectedLanguage;
    const language = getLanguageOption(getSelectedLanguageCode());
    const selectedVoice = resolveSelectedVoice();
    const selectedLanguageLabel = languageName(getSelectedLanguageCode(), language?.label || getSelectedLanguageCode());
    const suggestion = getDetectedLanguageSuggestion(detected, selectedVoice?.engine || els.ttsEngine?.value || 'kokoro');
    if (suggestion && !suggestion.supported) {
      els.languageStatus.textContent = getUnsupportedLanguageMessage(suggestion.code);
      updateVoiceSettingsSummary();
      return;
    }
    const detectedText = detected?.reliable
      ? `${getMessage('languageDetected', [languageName(getLanguageOption(detected.code)?.code || detected.code, getLanguageOption(detected.code)?.label || detected.code), String(detected.percent)], {
        fallback: `Detected ${languageName(getLanguageOption(detected.code)?.code || detected.code, getLanguageOption(detected.code)?.label || detected.code)} (${detected.percent}%).`,
      })} `
      : detected ? `${getMessage('languageDetectionUncertain', undefined, { fallback: 'Language detection was uncertain.' })} ` : '';
    const voiceText = selectedVoice?.engine === 'omnivoice'
      ? [t('Using experimental OmniVoice on WebGPU.'), t('Model files download from Hugging Face; speech stays on this device.'), t('Choose Kokoro if WebGPU is unavailable.')].join(' ')
      : selectedVoice?.engine === 'kokoro'
      ? [t('Using Kokoro $1 voice.', [selectedLanguageLabel]), t('Missing voice files download from Hugging Face when you prepare or read.'), t('Speech runs on this device; cached files can be reused offline unless cleared.'),
        ...(isExperimentalVoice(selectedVoice) ? [t('Experimental quality: $1.', [selectedVoice.quality])] : [])].join(' ')
      : t("No $1 voice is available.", [selectedLanguageLabel]);
    els.languageStatus.textContent = `${detectedText}${voiceText}`;
    updateVoiceSettingsSummary();
  }
  function resolveSelectedVoice() {
    if (els.ttsEngine?.value === 'omnivoice') {
      const language = getSelectedLanguageCode();
      if (!getOmniVoiceLanguage(language)) return null;
      const omniVoice = getOmniVoiceSettings();
      return { id: `omnivoice:${language}:${JSON.stringify(omniVoice)}`, engine: 'omnivoice', label: 'OmniVoice', detectCode: language, lang: language, omniVoice };
    }
    return resolveVoiceSelection(els.voice.value, getSelectedLanguageCode());
  }

  /** Put back the voice that kept reading after a failed switch; save only its own engine's fields. */
  async function restoreVoiceSelection(voice) {
    const language = normalizeLanguageCode(voice.detectCode || voice.lang);
    setSelectedLanguageCode(language);
    if (els.ttsEngine) els.ttsEngine.value = voice.engine;
    if (voice.engine === 'omnivoice') renderOmniVoiceSettings(voice.omniVoice);
    await populateVoices();
    if (voice.engine === 'kokoro') els.voice.value = voice.id;
    updateVoiceSettingsSummary();
    savePlaybackSettingsSoon({ ttsEngine: voice.engine, language,
      ...(voice.engine === 'omnivoice' ? { omniVoice: voice.omniVoice } : { voice: voice.id }) });
  }

  function getOmniVoiceSettings() {
    return normalizeOmniVoiceSettings({ gender: els.omniVoiceGender?.value,
      variation: Number(els.omniVoiceVariation?.value), whisper: els.omniVoiceWhisper?.checked });
  }

  function renderOmniVoiceSettings(settings = {}) {
    const config = normalizeOmniVoiceSettings(settings);
    if (els.omniVoiceGender) els.omniVoiceGender.value = config.gender;
    if (els.omniVoiceVariation) els.omniVoiceVariation.value = String(config.variation);
    if (els.omniVoiceVariationOut) els.omniVoiceVariationOut.textContent = `${config.variation} / 10`;
    if (els.omniVoiceWhisper) els.omniVoiceWhisper.checked = config.whisper;
  }

  function renderVoiceEngineSetting(settings = {}) {
    if (els.ttsEngine) els.ttsEngine.value = settings?.ttsEngine === 'omnivoice' ? 'omnivoice' : 'kokoro';
    renderOmniVoiceSettings(settings?.omniVoice);
    updateVoiceSettingsSummary();
  }

  function getPlaybackSpeed() {
    return readerEngineSettingsManager?.getPlaybackSpeed?.() ?? 1;
  }

  function getSectionPauseDelayMs() {
    const seconds = getSelectedSectionPauseSeconds();
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
  }

  function getSectionEarlyAdvanceSeconds() {
    const seconds = getSelectedSectionPauseSeconds();
    return seconds < 0 ? Math.abs(seconds) : 0;
  }

  function resetTtsPerformanceGovernor(settings = {}) {
    const advancedTtsControls = areAdvancedTtsControlsEnabled();
    const requestedProfile = advancedTtsControls
      ? settings?.ttsPerformanceProfile
      : DEFAULT_RUNTIME_POLICY.requestedProfile;
    if (advancedTtsControls && settings && Object.prototype.hasOwnProperty.call(settings, 'ttsBackendPreference')) {
      renderTtsBackendPreferenceSetting(settings.ttsBackendPreference);
    }
    setTtsPerformanceGovernor(createTtsPerformanceGovernor({
      setting: requestedProfile,
      ttsPerformanceProfile: requestedProfile,
      hardwareProbeSummary: state?.cachedTtsHardwareProbeSummary,
      navigator: getNavigator(),
    }));
  }

  function renderTtsPerformanceGovernorDecision(decision) {
    const governor = getTtsPerformanceGovernor();
    if (!decision || !governor) return;
    if (decision.changed) {
      lastAdjustedProfileDecision = decision;
    }
    renderTtsPerformanceProfileSetting(governor.requestedProfile?.());
  }

  function getActiveTtsProfileConfig() {
    if (!getTtsPerformanceGovernor()) resetTtsPerformanceGovernor();
    const governor = getTtsPerformanceGovernor();
    return Object.freeze({
      ...governor.currentConfig(),
      ...(els.ttsEngine?.value === 'omnivoice' ? { maxChunkLength: 240, targetMinLength: 120, preloadAhead: 1, progressiveSegments: false, speechPreloadTimeoutMs: 60_000 } : {}),
      requestedProfile: governor.requestedProfile?.() || TTS_PERFORMANCE_PROFILE_DEFAULT,
    });
  }

  function shouldForceWasmVoiceModel() {
    return areAdvancedTtsControlsEnabled() && ttsBackendPreference === 'wasm';
  }

  function maybeReleaseLoadedVoiceModelAfterPerformanceProfileChange() {
    if (!state?.tts || !canReleaseLoadedVoiceModel()) return;
    releaseLoadedVoiceModel({ force: true }).catch(suppressReaderEngineError);
  }

  return {
    renderVoiceEngineSetting,
    bindVoiceSettings,
    getActiveTtsProfileConfig,
    getPlaybackSpeed,
    getSectionEarlyAdvanceSeconds,
    getSectionPauseDelayMs,
    getSelectedHighlightSettings,
    getSelectedSectionPauseSeconds,
    getSelectedSkipCodeSnippets,
    maybeReleaseLoadedVoiceModelAfterPerformanceProfileChange,
    populateLanguageOptions,
    populateVoices,
    renderHighlightSettings,
    renderIdleReleaseSetting,
    renderLanguageStatus,
    renderSectionPauseSetting,
    renderSkipCodeSettings,
    renderSpeedSetting,
    renderTtsBackendStatus,
    renderTtsBackendPreferenceSetting,
    renderTtsPerformanceGovernorDecision,
    renderTtsPerformanceProfileSetting,
    resetTtsPerformanceGovernor,
    resolveSelectedVoice,
    restoreVoiceSelection,
    shouldForceWasmVoiceModel,
    updateSectionPauseOutput,
    updateVoiceSettingsSummary,
    warmSelectedVoice,
  };
}

function areAdvancedTtsControlsEnabled() {
  return true;
}
