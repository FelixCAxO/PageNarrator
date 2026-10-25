import {
  clampPlaybackSpeed,
  clampSectionPauseSeconds,
  DEFAULT_HIGHLIGHT_SETTINGS,
  formatSectionPauseLabel,
  getMaxPlaybackSpeed,
  normalizeHighlightSettings,
} from './playback-settings.js';

/**
 * Creates cohesive readerEngine settings behavior around injected DOM and storage dependencies.
 * @param {object} [options={}]
 * @param {Record<string, any>} [options.els]
 * @param {{ savePlaybackSettings?: Function }} [options.storage]
 * @param {() => HTMLAudioElement | null} [options.getCurrentAudio]
 * @param {Function} [options.configurePageHighlight]
 * @param {Function} [options.rescheduleCurrentSectionTiming]
 * @param {(error: unknown) => void} [options.onError]
 * @param {number} [options.debounceMs]
 */
export function createReaderEngineSettingsManager({
  els = {},
  storage = {},
  getCurrentAudio = () => null,
  configurePageHighlight = () => Promise.resolve(),
  rescheduleCurrentSectionTiming = () => {},
  onError = defaultErrorHandler,
  debounceMs = 150,
} = {}) {
  let highlightWriteTimer = null;

  function getPlaybackSpeed() {
    return clampPlaybackSpeed(els.speed?.value);
  }

  function setPlaybackSpeed(speed, { persist = true } = {}) {
    const value = clampPlaybackSpeed(speed);
    if (els.speed) {
      els.speed.max = String(getMaxPlaybackSpeed());
      els.speed.value = String(value);
    }
    if (els.speedOut) els.speedOut.textContent = `${value.toFixed(2)}x`;
    if (persist) storage.savePlaybackSettings?.({ speed: value });

    const currentAudio = getCurrentAudio();
    if (currentAudio) currentAudio.playbackRate = value;
  }

  function getSelectedHighlightSettings() {
    return normalizeHighlightSettings({
      area: {
        color: els.highlightAreaColor?.value,
        opacity: els.highlightAreaOpacity?.value,
      },
      word: {
        color: els.highlightWordColor?.value,
        opacity: els.highlightWordOpacity?.value,
      },
    });
  }

  function updateHighlightOpacityOutputs(settings = getSelectedHighlightSettings()) {
    if (els.highlightAreaOpacityOut) els.highlightAreaOpacityOut.textContent = `${Math.round(settings.area.opacity * 100)}%`;
    if (els.highlightWordOpacityOut) els.highlightWordOpacityOut.textContent = `${Math.round(settings.word.opacity * 100)}%`;
  }

  function renderHighlightSettings(settings = DEFAULT_HIGHLIGHT_SETTINGS) {
    const highlight = normalizeHighlightSettings(settings);
    if (els.highlightAreaColor) els.highlightAreaColor.value = highlight.area.color;
    if (els.highlightAreaOpacity) els.highlightAreaOpacity.value = String(highlight.area.opacity);
    if (els.highlightWordColor) els.highlightWordColor.value = highlight.word.color;
    if (els.highlightWordOpacity) els.highlightWordOpacity.value = String(highlight.word.opacity);
    updateHighlightOpacityOutputs(highlight);
  }

  function handleHighlightSettingsInput() {
    updateHighlightOpacityOutputs();
    clearTimeout(highlightWriteTimer);
    highlightWriteTimer = setTimeout(() => {
      storage.savePlaybackSettings?.({ highlight: getSelectedHighlightSettings() });
      void Promise.resolve(configurePageHighlight()).catch(onError);
    }, debounceMs);
  }

  function getSelectedSectionPauseSeconds() {
    return clampSectionPauseSeconds(els.sectionPause?.value);
  }

  function renderSectionPauseSetting(sectionPauseSeconds = 0) {
    const value = clampSectionPauseSeconds(sectionPauseSeconds);
    if (els.sectionPause) els.sectionPause.value = String(value);
    if (els.sectionPauseOut) els.sectionPauseOut.textContent = formatSectionPauseLabel(value);
  }

  function setSectionPause(sectionPauseSeconds, { persist = true } = {}) {
    const value = clampSectionPauseSeconds(sectionPauseSeconds);
    renderSectionPauseSetting(value);
    if (persist) storage.savePlaybackSettings?.({ sectionPauseSeconds: value });
    rescheduleCurrentSectionTiming();
  }

  return {
    getPlaybackSpeed,
    setPlaybackSpeed,
    getSelectedHighlightSettings,
    updateHighlightOpacityOutputs,
    renderHighlightSettings,
    handleHighlightSettingsInput,
    getSelectedSectionPauseSeconds,
    renderSectionPauseSetting,
    setSectionPause,
  };
}

function defaultErrorHandler() {
  return null;
}
