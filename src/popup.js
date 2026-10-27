import { t, localizeDocument, localizeLanguageOptions } from './lib/i18n.js';
import {
  clampPlaybackSpeed,
  clampSectionPauseSeconds,
  formatSectionPauseLabel,
  getMaxPlaybackSpeed,
  getPlaybackSettings,
  savePlaybackSettings,
} from './lib/playback-settings.js';
import { STORAGE_KEYS } from './lib/storage-keys.js';
import {
  getLanguageOptions,
  normalizeLanguageCode,
  getSelectableVoicesForLanguage,
  formatVoiceOptionLabel,
} from './lib/language-voice-options.js';
import { normalizeStoredVoiceId } from './lib/voice-registry.js';
import { injectContentScript, isContentScriptInjectableUrl } from './lib/content-script-injection.js';
import {
  createReadableTabSnapshot,
  getReadableTabTargetFromStorageValue,
  saveReadableTabTarget,
} from './lib/readable-tab-target.js';
import { createLogger, createSuppressedErrorHandler } from './lib/logger.js';
import { MESSAGE_TYPES, READER_ACTION_TYPES } from './lib/message-types.js';
import { getPopupRecoveryMessage } from './lib/ui-error-messages.js';
import { DEFAULT_TITLE as ENGINE_PLACEHOLDER_TITLE, getSetupView } from './lib/reader-engine-view.js';
import { installTrustedUiEventBoundary } from './lib/trusted-ui-events.js';
import { isTrustedExtensionPage } from './lib/extension-message-security.js';
import { normalizeOmniVoiceSettings, VOICE_ENGINE_HELP, isOmniVoiceWhisperAvailable, hasOmniVoiceWhisperWordLossRisk, OMNIVOICE_WHISPER_WARNING } from './lib/omnivoice-settings.js';
import { getOmniVoiceLanguageOptions } from './tts/omnivoice/languages.js';

const logger = createLogger('popup');
const suppressError = createSuppressedErrorHandler(logger, 'Best-effort popup operation failed.');
const activeStates = new Set(['preparing', 'reading', 'paused']);
export function getPopupElements(doc = globalThis.document) {
  if (!doc) return {};
  const byId = (id) => doc.getElementById?.(id) || null;
  return {
    status: byId('popup-status'), error: byId('popup-error'), setup: byId('popup-setup'),
    setupDetail: byId('popup-setup-detail'), setupProgress: byId('popup-setup-progress'),
    setupStart: byId('popup-setup-start'), setupSkip: byId('popup-setup-skip'),
    player: byId('popup-player'), playerTitle: byId('popup-player-title'), progress: byId('popup-progress'),
    previous: byId('popup-previous'), toggle: byId('popup-toggle'), stop: byId('popup-stop'), next: byId('popup-next'),
    idleActions: byId('popup-idle-actions'), start: byId('start-reading'), fromStart: byId('read-from-start'), selected: byId('read-selected'),
    settings: byId('popup-settings'), settingsSummary: byId('popup-settings-summary'), language: byId('popup-language'), voice: byId('popup-voice'),
    voiceEngineHelp: byId('popup-voice-model-help'),
    ttsEngine: byId('popup-tts-engine'), omniVoiceSettings: byId('popup-omnivoice-settings'),
    omniVoiceGender: byId('popup-omnivoice-gender'),
    omniVoiceVariation: byId('popup-omnivoice-variation'),
    omniVoiceVariationOut: byId('popup-omnivoice-variation-out'), omniVoiceWhisper: byId('popup-omnivoice-whisper'),
    speed: byId('popup-speed'), speedOut: byId('popup-speed-out'),
    sectionPause: byId('popup-section-pause'), sectionPauseOut: byId('popup-section-pause-out'),
    performanceProfile: byId('popup-performance-profile'), backendPreference: byId('popup-backend-preference'),
    idleRelease: byId('popup-idle-release'),
    skipCode: byId('popup-skip-code'), areaColor: byId('popup-area-color'), wordColor: byId('popup-word-color'),
    areaOpacity: byId('popup-area-opacity'), areaOpacityOut: byId('popup-area-opacity-out'),
    wordOpacity: byId('popup-word-opacity'), wordOpacityOut: byId('popup-word-opacity-out'),
    hardwareStatus: byId('popup-hardware-status'),
    transcriptCard: byId('popup-transcript-card'), transcriptCount: byId('popup-transcript-count'), transcript: byId('popup-transcript'),
    queueCard: byId('popup-queue-card'), queueCount: byId('popup-queue-count'), queueSearch: byId('popup-queue-search'),
    queueFirst: byId('popup-queue-first'), queueJump: byId('popup-queue-jump'), queueGo: byId('popup-queue-go'),
    queueLast: byId('popup-queue-last'), queue: byId('popup-queue'),
  };
}

export function createPopupApp({
  document: doc = globalThis.document,
  chrome: chromeApi = globalThis.chrome,
  window: win = globalThis.window,
} = {}) {
  localizeDocument(doc, { i18n: chromeApi?.i18n });
  const els = getPopupElements(doc);
  let popupVoices = [];
  let readerSnapshot = { state: 'idle', queue: [], transcript: '' };
  let readerStateRevision = 0;
  let readerDetailRevision = 0;
  let startupSync = null;
  let readStartPending = false;

  const getSpeed = () => clampPlaybackSpeed(els.speed?.value);
  const getPause = () => clampSectionPauseSeconds(els.sectionPause?.value);
  const isOmniVoice = () => els.ttsEngine?.value === 'omnivoice';
  const getOmniVoiceSettings = () => normalizeOmniVoiceSettings({ gender: els.omniVoiceGender?.value,
    variation: Number(els.omniVoiceVariation?.value), whisper: els.omniVoiceWhisper?.checked }, els.language?.value);

  function renderOmniVoiceSettings(value) {
    const settings = normalizeOmniVoiceSettings(value, els.language?.value);
    if (els.omniVoiceGender) els.omniVoiceGender.value = settings.gender;
    if (els.omniVoiceVariation) els.omniVoiceVariation.value = String(settings.variation);
    if (els.omniVoiceWhisper) {
      els.omniVoiceWhisper.checked = settings.whisper;
      els.omniVoiceWhisper.disabled = !isOmniVoiceWhisperAvailable(els.language?.value);
    }
    if (els.omniVoiceVariationOut) els.omniVoiceVariationOut.textContent = `${settings.variation} / 10`;
  }

  function showError(error) {
    if (!els.error) return;
    els.error.textContent = getPopupRecoveryMessage(error);
    els.error.hidden = false;
  }

  function clearError() {
    if (!els.error) return;
    els.error.textContent = '';
    els.error.hidden = true;
  }

  function setPending(button, label = t('Working…')) {
    if (!button) return;
    clearError();
    button.dataset.label = button.textContent;
    button.dataset.pending = 'true';
    button.textContent = label;
    button.disabled = true;
  }

  function clearPending(button) {
    if (!button) return;
    if (button.dataset.label) button.textContent = button.dataset.label;
    delete button.dataset.pending;
    button.disabled = false;
    renderReaderState(readerSnapshot);
  }

  function selectedVoice() {
    return popupVoices.find((voice) => voice.id === els.voice?.value) || null;
  }

  function renderSettingsSummary() {
    if (!els.settingsSummary) return;
    const name = isOmniVoice() ? 'OmniVoice' : String(selectedVoice()?.label || '').split(' - ')[0];
    if (els.omniVoiceSettings) els.omniVoiceSettings.hidden = !isOmniVoice();
    if (els.voice?.closest('label')) els.voice.closest('label').hidden = isOmniVoice();
    if (els.language?.closest('label')) els.language.closest('label').hidden = !isOmniVoice();
    if (els.backendPreference?.closest('label')) els.backendPreference.closest('label').hidden = isOmniVoice();
    if (els.performanceProfile?.closest('label')) els.performanceProfile.closest('label').hidden = isOmniVoice();
    if (els.voiceEngineHelp) els.voiceEngineHelp.textContent = t(VOICE_ENGINE_HELP[isOmniVoice() ? 'omnivoice' : 'kokoro']);
    if (isOmniVoice() && els.voiceEngineHelp && hasOmniVoiceWhisperWordLossRisk(els.language?.value)) els.voiceEngineHelp.textContent += ' ' + t(OMNIVOICE_WHISPER_WARNING);
    renderOmniVoiceSettings(getOmniVoiceSettings());
    els.settingsSummary.textContent = `${name ? t('$1 voice', [name]) : t('Voice')} · ${getSpeed().toFixed(2)}x`;
    if (els.speedOut) els.speedOut.textContent = `${getSpeed().toFixed(2)}x`;
    if (els.sectionPauseOut) els.sectionPauseOut.textContent = formatSectionPauseLabel(getPause());
    if (els.areaOpacity && els.areaOpacityOut) els.areaOpacityOut.textContent = `${Math.round(Number(els.areaOpacity.value) * 100)}%`;
    if (els.wordOpacity && els.wordOpacityOut) els.wordOpacityOut.textContent = `${Math.round(Number(els.wordOpacity.value) * 100)}%`;
  }

  function renderHardware(plan = readerSnapshot.backend) {
    if (!els.hardwareStatus) return;
    const device = String(plan?.device || plan?.backend || '').toLowerCase();
    // gpuClass comes from gpu-calibration.js: 'discrete', 'integrated-probable' or 'unknown'.
    const gpuClass = String(plan?.calibration?.gpuClass || '');
    els.hardwareStatus.textContent = device.includes('webgpu')
      ? gpuClass === 'discrete'
        ? t("Processing: WebGPU (dedicated GPU)")
        : gpuClass.startsWith('integrated')
          ? t("Processing: WebGPU (integrated GPU)")
          : t("Processing: WebGPU")
      : device.includes('wasm') || device.includes('cpu')
        ? t("Processing: CPU / WebAssembly (slower)")
        : t("Processing shown after reading starts.");
  }

  // The engine sends modelSetup as { phase, progress, detail, eta }; getSetupView is how
  // its own UI reads that payload, so the popup cannot drift from it.
  function setupProgressPercent(setup = readerSnapshot.modelSetup) {
    return setup?.phase === 'loading' ? getSetupView(setup).progressPercent : null;
  }

  function renderSetup(setup = readerSnapshot.modelSetup) {
    if (!els.setup) return;
    const phase = String(setup?.phase || '');
    const loading = phase === 'loading';
    const pending = readerSnapshot.setupPending === true;
    // During a read the player line shows setup progress, so a second card would repeat it.
    els.setup.hidden = activeStates.has(readerSnapshot.state) || (!pending && !['loading', 'error'].includes(phase));
    const progress = setupProgressPercent(setup) ?? 0;
    if (els.setupProgress) {
      els.setupProgress.hidden = !loading;
      els.setupProgress.value = progress;
    }
    // A disabled "Prepare voice" while loading is a dead control; the progress bar says enough.
    if (els.setupStart) els.setupStart.hidden = loading;
    if (els.setupSkip) els.setupSkip.hidden = loading;
    if (els.setupDetail) {
      els.setupDetail.textContent = loading
        ? (setup?.detail || t("Preparing local voice… $1%", [progress]))
        : phase === 'error'
          ? (setup?.detail || t("Voice preparation failed. Try again."))
          : t("Missing voice files download from Hugging Face before setup.");
    }
    if (els.setupStart) els.setupStart.textContent = phase === 'error' ? t("Retry") : t("Prepare voice");
  }

  function formatSectionCount(count) {
    return count ? count === 1 ? t('$1 section', [count]) : t('$1 sections', [count]) : t("Available when reading starts");
  }

  // State broadcasts arrive on every chunk change with the full queue and transcript.
  // Rebuilding thousands of queue buttons each time stalls the popup, so the DOM is only
  // rebuilt when the queue or search changes; otherwise just the active item moves.
  let renderedTranscript = null;
  let renderedQueue = [];
  let renderedQuery = null;
  let renderedButtons = new Map();

  function renderTranscript() {
    if (!els.transcript) return;
    const transcript = String(readerSnapshot.transcript || '').trim() || t("Transcript appears when text loads.");
    const count = Array.isArray(readerSnapshot.queue) ? readerSnapshot.queue.length : 0;
    if (transcript !== renderedTranscript) {
      els.transcript.textContent = transcript;
      renderedTranscript = transcript;
    }
    if (els.transcriptCount) els.transcriptCount.textContent = formatSectionCount(count);
    // An empty panel is a dead control before the first read; it appears with the queue.
    if (els.transcriptCard) els.transcriptCard.hidden = count === 0;
  }

  function isSameQueue(queue) {
    if (queue.length !== renderedQueue.length) return false;
    for (let index = 0; index < queue.length; index += 1) {
      if (String(queue[index] || '') !== renderedQueue[index]) return false;
    }
    return true;
  }

  function renderQueueItems(queue, query) {
    const filtered = queue.map((text, index) => ({ text: String(text || ''), index }))
      .filter((item) => !query || item.text.toLowerCase().includes(query));
    renderedButtons = new Map();
    els.queue.replaceChildren(...filtered.map((item) => {
      const li = (doc || document).createElement('li');
      const button = (doc || document).createElement('button');
      button.type = 'button';
      button.textContent = `${item.index + 1}. ${item.text}`;
      button.addEventListener('click', () => jumpTo(item.index));
      renderedButtons.set(item.index, button);
      li.append(button);
      return li;
    }));
    renderedQueue = queue.map((text) => String(text || ''));
    renderedQuery = query;
  }

  function renderQueue() {
    if (!els.queue) return;
    const queue = Array.isArray(readerSnapshot.queue) ? readerSnapshot.queue : [];
    const query = (els.queueSearch?.value || '').trim().toLowerCase();
    if (query !== renderedQuery || !isSameQueue(queue)) renderQueueItems(queue, query);
    const currentChunk = Number(readerSnapshot.currentChunk || 0);
    for (const button of els.queue.querySelectorAll('button.active')) {
      if (button !== renderedButtons.get(currentChunk)) {
        button.classList.remove('active');
        button.removeAttribute('aria-current');
      }
    }
    renderedButtons.get(currentChunk)?.classList.add('active');
    renderedButtons.get(currentChunk)?.setAttribute('aria-current', 'true');
    const empty = doc?.getElementById('popup-queue-empty');
    if (empty) empty.hidden = !query || renderedButtons.size > 0;
    if (els.queueCount) els.queueCount.textContent = formatSectionCount(queue.length);
    if (els.queueCard) els.queueCard.hidden = queue.length === 0;
    if (els.queueJump) {
      els.queueJump.max = String(Math.max(1, queue.length));
      if (doc?.activeElement !== els.queueJump) {
        els.queueJump.value = String(Math.min(queue.length || 1, Number(readerSnapshot.currentChunk || 0) + 1));
      }
    }
    for (const button of [els.queueFirst, els.queueGo, els.queueLast]) {
      if (button) button.disabled = queue.length === 0;
    }
  }

  function renderReaderState(snapshot = {}) {
    const previousState = readerSnapshot.state;
    readerSnapshot = { ...readerSnapshot, ...snapshot };
    if (readerSnapshot.modelSetup?.phase === 'ready') {
      readerSnapshot.setupPending = false;
      void chromeApi?.storage?.local?.set?.({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: false })?.catch?.(suppressError);
    }
    const state = readerSnapshot.state || 'idle';
    const active = activeStates.has(state);
    // Preparing can last a minute on CPU (first audio); keep the title and Stop in reach.
    if (els.player) els.player.hidden = !active;
    if (els.idleActions) els.idleActions.hidden = active;
    const title = String(readerSnapshot.title || '').trim();
    if (els.playerTitle) {
      els.playerTitle.textContent = title && title !== ENGINE_PLACEHOLDER_TITLE ? title : t("Current page");
      els.playerTitle.title = els.playerTitle.textContent;
    }
    if (els.progress) {
      const setupProgress = setupProgressPercent();
      els.progress.textContent = state === 'preparing'
        ? (readerSnapshot.modelSetup?.detail || (setupProgress === null ? t('Preparing…') : t("Preparing voice… $1%", [setupProgress])))
        : [readerSnapshot.progressLabel, readerSnapshot.remainingLabel].filter(Boolean).join(' · ') || t('Preparing…');
    }
    if (els.toggle) {
      // The progress line says "Preparing…"; a longer label clips in the four-button row.
      els.toggle.textContent = state === 'paused' ? t("Resume") : t("Pause");
      els.toggle.disabled = state === 'preparing' || Boolean(els.toggle.dataset.pending);
    }
    if (els.previous) els.previous.disabled = state === 'preparing' || Boolean(els.previous.dataset.pending) || Number(readerSnapshot.currentChunk || 0) <= 0;
    if (els.next) els.next.disabled = state === 'preparing' || Boolean(els.next.dataset.pending) || Number(readerSnapshot.currentChunk || 0) >= Number(readerSnapshot.totalChunks || 0) - 1;
    if (els.status) {
      els.status.textContent = ({ idle: t("Ready to read"), preparing: t("Preparing voice…"), reading: t("Reading"), paused: t("Paused"), finished: t("Finished"), error: t("Needs attention") })[state] || t("Ready to read");
      els.status.dataset.state = state;
    }
    if (state === 'error') showError({ code: readerSnapshot.errorCode, message: readerSnapshot.message });
    else if (previousState === 'error') clearError();
    renderSetup();
    renderHardware();
    renderTranscript();
    renderQueue();
  }

  // Rapid input would otherwise queue one read-merge-write per event, leaving the newest
  // value behind stale writes when the popup closes. Keep one write in flight and one
  // follow-up that reads the controls when it runs.
  let settingsSaveInFlight = null;
  let settingsSaveQueued = false;

  function saveSettings() {
    renderSettingsSummary();
    if (!els.language) return Promise.resolve();
    if (settingsSaveInFlight) {
      settingsSaveQueued = true;
      return settingsSaveInFlight;
    }
    settingsSaveInFlight = (async () => {
      do {
        settingsSaveQueued = false;
        await persistSettingsFromControls();
      } while (settingsSaveQueued);
    })().finally(() => { settingsSaveInFlight = null; });
    return settingsSaveInFlight;
  }

  async function persistSettingsFromControls() {
    const voice = selectedVoice();
    await savePlaybackSettings({
      ttsEngine: isOmniVoice() ? 'omnivoice' : 'kokoro',
      omniVoice: getOmniVoiceSettings(),
      language: els.language.value,
      ...(!isOmniVoice() ? { voice: voice?.id || null, voicesByLanguage: voice?.id ? { [els.language.value]: voice.id } : {} } : {}),
      speed: getSpeed(),
      sectionPauseSeconds: getPause(),
      ttsPerformanceProfile: els.performanceProfile?.value,
      ttsBackendPreference: els.backendPreference?.value,
      idleReleaseEnabled: els.idleRelease?.checked,
      skipCodeSnippets: els.skipCode?.checked,
      highlight: {
        area: { color: els.areaColor?.value, opacity: Number(els.areaOpacity?.value) },
        word: { color: els.wordColor?.value, opacity: Number(els.wordOpacity?.value) },
      },
    }, { storage: chromeApi?.storage?.local });
  }

  async function getActiveTab() {
    const currentTabPromise = Promise.resolve(chromeApi?.tabs?.getCurrent?.()).catch(() => null);
    const storedPromise = Promise.resolve(chromeApi?.storage?.local?.get?.(STORAGE_KEYS.READABLE_TAB_TARGET)).catch(() => ({}));
    const queryPromise = Promise.resolve(chromeApi?.tabs?.query?.({ active: true, currentWindow: true })).catch(() => []);
    const [currentTab, stored, tabs] = await Promise.all([currentTabPromise, storedPromise, queryPromise]);
    const target = getReadableTabTargetFromStorageValue(stored?.[STORAGE_KEYS.READABLE_TAB_TARGET]);
    if (/\/src\/popup\.html(?:[?#].*)?$/i.test(String(currentTab?.url || '')) && target?.id) return target;
    if (currentTab?.openerTabId) {
      if (target?.id === currentTab.openerTabId) return target;
    }
    const tab = tabs?.[0];
    if (String(tab?.url || '').startsWith('chrome-extension://') && target?.id) return target;
    return tab || null;
  }

  async function warmContentScriptAccess(tab) {
    if (!tab?.id) return;
    const url = tab.url || tab.pendingUrl || '';
    if (url && !isContentScriptInjectableUrl(url)) return;
    try {
      await chromeApi?.tabs?.sendMessage?.(tab.id, { type: MESSAGE_TYPES.PAGENARRATOR_PING });
    } catch {
      await injectContentScript({ tab, scripting: chromeApi?.scripting, permissions: chromeApi?.permissions, getContentScriptFile: () => 'src/content.js' });
    }
  }

  async function sendAction(action, { tab = null } = {}) {
    const response = await chromeApi?.runtime?.sendMessage?.({
      type: MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST,
      action,
      ...(tab ? { tab: createReadableTabSnapshot(tab) } : {}),
    });
    if (response?.ok === false) throw new Error(response.error || 'PageNarrator player failed.');
    return response;
  }

  async function startRead(action, button) {
    if (readStartPending) return;
    readStartPending = true;
    setPending(button, 'Starting…');
    for (const control of [els.start, els.fromStart, els.selected]) if (control) control.disabled = true;
    try {
      const tab = await getActiveTab();
      await warmContentScriptAccess(tab);
      await saveSettings();
      void saveReadableTabTarget({ storage: chromeApi?.storage?.local, tabId: tab?.id, tab }).catch(suppressError);
      await sendAction(action, { tab });
    } catch (error) {
      showError(error);
    } finally {
      readStartPending = false;
      for (const control of [els.start, els.fromStart, els.selected]) if (control) control.disabled = false;
      clearPending(button);
    }
  }

  async function runControl(action, button) {
    if (button?.dataset.pending) return;
    setPending(button);
    try { await sendAction(action); } catch (error) { showError(error); } finally { clearPending(button); }
  }

  async function jumpTo(index) {
    const total = Array.isArray(readerSnapshot.queue) ? readerSnapshot.queue.length : 0;
    const target = Math.max(0, Math.min(total - 1, Number(index)));
    if (total) await sendAction({ type: READER_ACTION_TYPES.JUMP_TO_CHUNK, index: target }).catch(showError);
  }

  function jumpFromInput() {
    if (els.queueJump?.reportValidity()) void jumpTo(Number(els.queueJump.value) - 1);
  }

  function languageOptions(selected) {
    const languages = isOmniVoice() ? getOmniVoiceLanguageOptions(selected) : getLanguageOptions();
    return languages.length ? languages : [{ code: 'en', label: 'English' }];
  }

  function voicesForLanguage(language) {
    return getSelectableVoicesForLanguage(language);
  }

  function populateLanguages(selected = 'en') {
    if (!els.language) return;
    selected = normalizeLanguageCode(selected);
    const options = localizeLanguageOptions(languageOptions(selected));
    const OptionConstructor = win?.Option || Option;
    els.language.replaceChildren(...options.map((language) => new OptionConstructor(language.label, language.code)));
    els.language.value = options.some(({ code }) => code === selected) ? selected : options.find(({ code }) => code === 'en')?.code || options[0].code;
  }

  function populateVoices(storedVoice) {
    if (!els.voice || !els.language) return;
    popupVoices = voicesForLanguage(isOmniVoice() ? 'en' : els.language.value);
    const OptionConstructor = win?.Option || Option;
    els.voice.replaceChildren(...popupVoices.map((voice) => new OptionConstructor(formatVoiceOptionLabel(voice), voice.id)));
    const normalized = normalizeStoredVoiceId(storedVoice);
    els.voice.value = popupVoices.some(({ id }) => id === normalized) ? normalized : popupVoices[0]?.id || '';
    renderSettingsSummary();
  }

  async function prepareVoice() {
    setPending(els.setupStart, t('Preparing…'));
    try {
      await saveSettings();
      await sendAction({ type: READER_ACTION_TYPES.PREPARE_VOICE });
    } catch (error) {
      showError(error);
    } finally {
      clearPending(els.setupStart);
    }
  }

  async function skipSetup() {
    await chromeApi?.storage?.local?.set?.({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: false });
    readerSnapshot.setupPending = false;
    readerSnapshot.modelSetup = null;
    renderSetup();
  }

  async function init() {
    chromeApi?.runtime?.onMessage?.addListener?.((message, sender) => {
      if (!isTrustedExtensionPage(sender, chromeApi?.runtime, 'src/reader-engine.html')) return false;
      if (message?.type === MESSAGE_TYPES.READER_STATE_CHANGED) {
        if (startupSync && message.syncRequestId === startupSync.id && readerDetailRevision > startupSync.detailRevision) return false;
        readerStateRevision += 1;
        if (message.transcript || message.queue?.length || message.modelSetup?.phase) readerDetailRevision = readerStateRevision;
        renderReaderState(message);
      }
      return false;
    });

    // Controls that do not depend on stored settings listen before the first await, so
    // queue search and playback input made while storage loads is not dropped.
    els.previous?.addEventListener?.('click', () => runControl({ type: READER_ACTION_TYPES.PREVIOUS }, els.previous));
    els.toggle?.addEventListener?.('click', () => runControl({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, els.toggle));
    els.stop?.addEventListener?.('click', () => runControl({ type: READER_ACTION_TYPES.STOP }, els.stop));
    els.next?.addEventListener?.('click', () => runControl({ type: READER_ACTION_TYPES.NEXT }, els.next));
    els.setupStart?.addEventListener?.('click', prepareVoice);
    els.setupSkip?.addEventListener?.('click', () => void skipSetup().catch(showError));
    els.queueSearch?.addEventListener?.('input', renderQueue);
    els.queueFirst?.addEventListener?.('click', () => jumpTo(0));
    els.queueLast?.addEventListener?.('click', () => jumpTo(readerSnapshot.queue.length - 1));
    els.queueGo?.addEventListener?.('click', jumpFromInput);
    els.queueJump?.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      jumpFromInput();
    });
    for (const card of [els.transcriptCard, els.queueCard]) {
      card?.querySelector?.('summary')?.addEventListener?.('click', () => {
        if (!card.open) void sendAction({ type: READER_ACTION_TYPES.SYNC_STATE }).catch(suppressError);
      });
    }

    // runtime.onInstalled can write the setup flag after a freshly installed popup opens.
    // A change event is newer than the initial read below, so it wins.
    let setupFlagChanged = false;
    chromeApi?.storage?.onChanged?.addListener?.((changes, areaName) => {
      const change = changes?.[STORAGE_KEYS.VOICE_SETUP_PENDING];
      if (areaName !== 'local' || !change) return;
      setupFlagChanged = true;
      readerSnapshot.setupPending = change.newValue === true;
      renderSetup();
    });
    const [settings, setupState] = await Promise.all([
      getPlaybackSettings({ storage: chromeApi?.storage?.local }),
      chromeApi?.storage?.local?.get?.(STORAGE_KEYS.VOICE_SETUP_PENDING) || {},
    ]);
    if (!setupFlagChanged) readerSnapshot.setupPending = setupState?.[STORAGE_KEYS.VOICE_SETUP_PENDING] === true;
    if (els.ttsEngine) els.ttsEngine.value = settings.ttsEngine;
    populateLanguages(settings.language);
    renderOmniVoiceSettings(settings.omniVoice);
    const initialVoice = settings.voicesByLanguage?.[settings.language] || settings.voice;
    populateVoices(initialVoice);
    if (els.speed) {
      els.speed.max = String(getMaxPlaybackSpeed());
      els.speed.value = String(settings.speed);
    }
    if (els.sectionPause) els.sectionPause.value = String(settings.sectionPauseSeconds);
    if (els.performanceProfile) els.performanceProfile.value = settings.ttsPerformanceProfile;
    if (els.backendPreference) els.backendPreference.value = settings.ttsBackendPreference;
    if (els.idleRelease) els.idleRelease.checked = settings.idleReleaseEnabled;
    if (els.skipCode) els.skipCode.checked = settings.skipCodeSnippets;
    if (els.areaColor) els.areaColor.value = settings.highlight.area.color;
    if (els.areaOpacity) els.areaOpacity.value = String(settings.highlight.area.opacity);
    if (els.wordColor) els.wordColor.value = settings.highlight.word.color;
    if (els.wordOpacity) els.wordOpacity.value = String(settings.highlight.word.opacity);
    renderSettingsSummary();

    els.ttsEngine?.addEventListener?.('change', async () => {
      if (els.settings) els.settings.open = true;
      populateLanguages(els.language?.value);
      renderSettingsSummary();
      const currentSettings = await getPlaybackSettings({ storage: chromeApi?.storage?.local }).catch(() => null);
      populateVoices(currentSettings?.voicesByLanguage?.en || currentSettings?.voice);
      void saveSettings().catch(suppressError);
    });
    els.language?.addEventListener?.('change', async () => {
      const currentSettings = await getPlaybackSettings({ storage: chromeApi?.storage?.local }).catch(() => null);
      const storedVoice = currentSettings?.voicesByLanguage?.[els.language.value] || currentSettings?.voice;
      populateVoices(storedVoice);
      void saveSettings().catch(suppressError);
    });
    els.voice?.addEventListener?.('change', () => { void saveSettings().catch(suppressError); });
    for (const input of [els.omniVoiceGender, els.omniVoiceVariation, els.omniVoiceWhisper, els.speed, els.sectionPause, els.performanceProfile, els.backendPreference, els.idleRelease, els.skipCode, els.areaColor, els.areaOpacity, els.wordColor, els.wordOpacity]) {
      input?.addEventListener?.('input', () => void saveSettings().catch(suppressError));
    }
    els.start?.addEventListener?.('click', () => startRead({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, els.start));
    els.fromStart?.addEventListener?.('click', () => startRead({ type: READER_ACTION_TYPES.READ_FROM_START }, els.fromStart));
    els.selected?.addEventListener?.('click', () => startRead({ type: READER_ACTION_TYPES.READ_SELECTED }, els.selected));
    if (els.start) els.start.disabled = false;
    if (els.fromStart) els.fromStart.disabled = false;
    if (els.selected) els.selected.disabled = false;
    const revision = readerStateRevision;
    const state = await chromeApi?.runtime?.sendMessage?.({ type: MESSAGE_TYPES.READER_ENGINE_GET_STATE })?.catch?.(() => ({ state: 'idle' })) || { state: 'idle' };
    if (readerStateRevision === revision || readerDetailRevision === 0) renderReaderState(state);
    if (readerDetailRevision === 0 && state.state !== 'idle') {
      startupSync = { id: `popup-${Date.now()}`, detailRevision: 0 };
      await sendAction({ type: READER_ACTION_TYPES.SYNC_STATE, requestId: startupSync.id }).catch(suppressError);
    }
  }

  return {
    init,
    startRead,
    runControl,
    jumpTo,
    renderReaderState,
    showError,
    clearError,
    saveSettings,
    warmContentScriptAccess,
    sendAction,
    getActiveTab,
    populateLanguages,
    populateVoices,
    prepareVoice,
    skipSetup,
    els,
  };
}

const defaultApp = typeof document !== 'undefined' ? createPopupApp() : null;

export const init = defaultApp ? defaultApp.init : () => {};
export const startRead = defaultApp ? defaultApp.startRead : () => {};
export const runControl = defaultApp ? defaultApp.runControl : () => {};
export const jumpTo = defaultApp ? defaultApp.jumpTo : () => {};
export const renderReaderState = defaultApp ? defaultApp.renderReaderState : () => {};
export const showError = defaultApp ? defaultApp.showError : () => {};
export const clearError = defaultApp ? defaultApp.clearError : () => {};
export const saveSettings = defaultApp ? defaultApp.saveSettings : () => {};
export const warmContentScriptAccess = defaultApp ? defaultApp.warmContentScriptAccess : () => {};
export const sendAction = defaultApp ? defaultApp.sendAction : () => {};
export const getActiveTab = defaultApp ? defaultApp.getActiveTab : () => {};
export const populateLanguages = defaultApp ? defaultApp.populateLanguages : () => {};
export const populateVoices = defaultApp ? defaultApp.populateVoices : () => {};
export const prepareVoice = defaultApp ? defaultApp.prepareVoice : () => {};
export const skipSetup = defaultApp ? defaultApp.skipSetup : () => {};
export const els = defaultApp ? defaultApp.els : {};

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('start-reading') && !globalThis.__pnDisablePopupAutoInit) {
  installTrustedUiEventBoundary(document);
  defaultApp?.init()?.catch?.((error) => {
    logger.error('PageNarrator popup failed to initialize.', error);
    defaultApp?.showError?.(error);
  });
}
