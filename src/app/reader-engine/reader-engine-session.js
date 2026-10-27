import { t } from '../../lib/i18n.js';
import { getInitialPreview } from '../../lib/speech-chunks.js';
import {
  createProgressiveSegmentChunk,
  getChunkSpeechText,
} from '../../lib/reader-engine-chunks.js';
import {
  createArticleSummary,
  createResumePrompt,
  getChunkWordCounts,
} from '../../lib/reader-engine-view.js';
import { createLogger, createSuppressedErrorHandler } from '../../lib/logger.js';
import { MESSAGE_TYPES } from '../../lib/message-types.js';
import { isTrustedBackgroundSender } from '../../lib/extension-message-security.js';
import {
  getMaxPlaybackSpeed,
} from '../../lib/playback-settings.js';
import { findStartChunkIndexByText } from '../../lib/reading-start.js';
import {
  createReaderEngineTargetResolver,
  isPageNarratorPdfViewerUrl,
  READABLE_TAB_TARGET_KEY,
} from '../../lib/reader-engine-target-resolver.js';
import { STORAGE_KEYS, getResumePositionStorageKey } from '../../lib/storage-keys.js';
import {
  compactCompletedPdfChunks,
  createReusableAudioElementPool,
  createReadRunTracker,
  runCleanupAfterSettled,
} from '../../lib/reader-engine-read-lifecycle.js';
import { createReadOrchestrator } from '../../lib/core/reader-engine-read-orchestrator.js';
import { normalizeLanguageCode } from '../../lib/language-voice-options.js';
import { createReaderEngineTtsProbeController } from '../../lib/reader-engine-tts-probe-controller.js';
import { createReaderEngineVoiceSettingsController } from '../../lib/reader-engine-voice-settings-controller.js';
import { createReaderEngineReadingStateRenderer } from '../../lib/reader-engine-reading-state-renderer.js';
import { createReaderEngineReadControlsController } from '../../lib/reader-engine-read-controls-controller.js';
import { createReaderEngineSessionContextController } from '../../lib/reader-engine-session-context-controller.js';
import { createReaderEngineVoiceRuntimeController } from '../../lib/reader-engine-voice-runtime-controller.js';
import { createReaderEnginePdfNavigationController } from '../../lib/reader-engine-pdf-navigation-controller.js';
import { createReaderEngineQueueNavigationController } from '../../lib/reader-engine-queue-navigation-controller.js';
import { createReaderEngineStorageAdapter } from '../../lib/reader-engine-storage-adapter.js';
import { createReaderEngineMessageRouter } from '../../lib/core/reader-engine-message-router.js';
import { createReaderEngineSettingsManager } from '../../lib/reader-engine-settings-manager.js';
import { applyPlaybackSettingsFromStorage as applyStoredPlaybackSettings } from '../../lib/reader-engine-playback-settings-sync.js';
import { createPlaybackSession } from '../../lib/playback-session.js';
import { createFlowRecorder } from '../../lib/flow-recorder.js';
import {
  createAudioOutputLatencyReader,
  createAudioPlaybackManager,
} from '../../lib/reader-engine-audio-playback.js';
import { playProgressiveSpeechSegments as playProgressiveSpeechSegmentsHelper } from '../../lib/progressive-segment-playback.js';
import { createReadLoopOrchestrator } from '../../lib/reader-engine-read-loop.js';
import { createReaderEngineQueueRenderer } from '../../lib/reader-engine-queue-renderer.js';
import { createReaderEngineArticleSummaryController } from '../../lib/reader-engine-article-summary-controller.js';
import { createReaderEngineOnboardingController } from '../../lib/reader-engine-onboarding-controller.js';
import { createReaderEngineReviewPromptController } from '../../lib/reader-engine-review-prompt-controller.js';
import { createReaderEngineSpeechPreloadController } from '../../lib/reader-engine-speech-preload-controller.js';
import { hideReaderEngineErrorNotice, renderReaderEngineErrorNotice } from '../../lib/reader-engine-error-notices.js';
import { createReaderEnginePageHighlightController } from '../../lib/reader-engine-page-highlight-controller.js';
import { createReaderEngineTeardownController } from '../../lib/reader-engine-teardown-controller.js';
import { PLAYBACK_SETTINGS_WRITE_DEBOUNCE_MS } from '../../lib/timing-config.js';
import { getReaderEngineElements } from '../../lib/reader-engine-dom.js';
import { createReaderEngineInitialState } from '../../lib/reader-engine-state.js';
import { readExtensionTestFlags } from '../../lib/extension-test-flags.js';
import { saveReadingCleanupSetting } from '../../platform/storage/settings-store.js';
import { requestContentScriptAccess } from '../../lib/content-script-injection.js';

// Controller graph contract: Init order: storage, targets, settings, preload, read loop. Teardown order: abort run, stop audio, clear preloads, release runtimes. One owner per signal: each controller owns only the abort signal it creates.
/** @param {any} [deps] */
export function createReaderEngineChromeAdapter({
  document: appDocument = globalThis.document,
  chrome: appChrome = globalThis.chrome,
  navigator: _appNavigator = globalThis.navigator,
  performance: appPerformance = globalThis.performance,
  window: appWindow = globalThis.window,
  productCore,
} = {}) {
  const { session, readRunner, ttsService, controller } = productCore;
  return {
    start() {
      const document = appDocument;
      const chrome = appChrome;
      const performance = appPerformance;
      const window = appWindow;
      const sessionState = session.state;

      // Controller graph contract: Init order: storage, targets, settings, preload, read loop. Teardown order: abort run, stop audio, clear preloads, release runtimes. One owner per signal: each controller owns only the abort signal it creates.
      const els = getReaderEngineElements(document);
      const initialState = createReaderEngineInitialState({ performance });

      const ICONS = {
        play: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
        pause: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>',
        stop: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>',
        miniPlay: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
        miniPause: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>',
      };

      let tts;
      tts = null;
      let currentAudio = null;
      const readState = {
        get activeReadTabId() { return sessionState.activeReadTabId; },
        set activeReadTabId(value) { sessionState.activeReadTabId = value; },
        get readingState() { return sessionState.readingState; },
        set readingState(value) { session.setReadingState(value); },
        get currentChunk() { return sessionState.currentChunk; },
        set currentChunk(value) { session.setCurrentChunk(value); },
        get totalChunks() { return sessionState.totalChunks; },
        set totalChunks(value) { sessionState.totalChunks = value; },
        get activeChunks() { return sessionState.activeChunks; },
        set activeChunks(value) { sessionState.activeChunks = Array.isArray(value) ? value : []; },
        get activeChunkIterator() { return sessionState.activeChunkIterator; },
        set activeChunkIterator(value) { sessionState.activeChunkIterator = value; },
      };
      let activeChunkWordCounts = sessionState.activeChunkWordCounts;
      let totalReadableWordCount = 0;
      let activeArticleSource = sessionState.activeArticleSource;
      let activePdfPageCount = sessionState.activePdfPageCount;
      let modelSetupState = sessionState.modelSetupState;
      let activeTranscript = '';
      let backendPlan = null;
      let activePageContextKey = sessionState.activePageContextKey;
      let panelTargetTab = null;
      let lastReadOptions = null;
      let activeReadingCursor = sessionState.activeReadingCursor;
      let currentAudioWatchdog = null;
      let activeSectionPauseDelay = null;
      let activePrimaryAction = null;
      let rescheduleCurrentSectionTiming = () => {};
      let selectedLanguageCode = 'en';
      let queueSearchQuery = '';
      let ttsPerformanceGovernor = null;
      let idleReleaseEnabled = true;
      let releaseReadSessionAfterCleanup = false;
      let clearCurrentAudioEventListeners = () => {};
      let activeSpeechPreloadCleanup = () => {};
      /** @type {any} */
      let activeReadPromise = sessionState.activeReadPromise;
      /** @type {any} */
      let pendingReadPauseGate = sessionState.pendingReadPauseGate;
      let ttsSectionReadyTransitionTracker = null;
      let cachedTtsHardwareProbeSummary = null;
      let testSilentTtsEnabled = false;
      let testRecordFlowEnabled = false;
      let testForceKokoroFailureEnabled = false;
      const readerEngineOpenedAtMs = initialState.readerEngineOpenedAtMs;
      const playbackSession = createPlaybackSession();
      const flowRecorder = createFlowRecorder({
        enabled: () => testRecordFlowEnabled,
        target: window,
        now: () => performance.now() / 1000,
      });
      const readAudioOutputLatencySeconds = createAudioOutputLatencyReader();

      const readerEngineLogger = createLogger('readerEngine');
      const logSuppressedReaderEngineError = (message) => createSuppressedErrorHandler(readerEngineLogger, message);
      const logBestEffortReaderEngineError = logSuppressedReaderEngineError(t("Best-effort readerEngine operation failed."));
      const suppressReaderEngineError = (error) => {
        logBestEffortReaderEngineError(error);
        renderReaderEngineErrorNotice(els, error);
      };
      const readerEngineStorage = createReaderEngineStorageAdapter({ storage: chrome.storage.local });
      const readerEngineMessageRouter = createReaderEngineMessageRouter({
        tabs: chrome.tabs,
        getPlaybackSpeed: () => getPlaybackSpeed(),
        actions: {
          handlePrimaryAction: (...args) => { void Promise.resolve(handlePrimaryAction(...args)).catch(suppressReaderEngineError); },
          handleReadSelectedAction: (...args) => { void Promise.resolve(handleReadSelectedAction(...args)).catch(suppressReaderEngineError); },
          handleReadFromStartAction: (...args) => { void Promise.resolve(handleReadFromStartAction(...args)).catch(suppressReaderEngineError); },
          stopReading: () => { void Promise.resolve(stopReading()).catch(suppressReaderEngineError); },
          skipToNextChunk: () => { void Promise.resolve(skipToNextChunk()).catch(suppressReaderEngineError); },
          skipToPreviousChunk: () => { void Promise.resolve(skipToPreviousChunk()).catch(suppressReaderEngineError); },
          setPlaybackSpeed: (speed) => setPlaybackSpeed(speed),
          setSectionPause: (seconds) => setSectionPause(seconds),
          requestJump: (index) => { void Promise.resolve(requestJump(index)).catch(suppressReaderEngineError); },
          syncPlayerState: (action) => readingStateRenderer?.broadcastPlayerState({ syncRequestId: action.requestId }),
          prepareVoice: () => { void Promise.resolve(ensureModel({ warmupVoice: resolveSelectedVoice()?.id })).catch(suppressReaderEngineError); },
        },
      });
      const readerEngineTargetResolver = createReaderEngineTargetResolver({
        tabs: chrome.tabs, scripting: chrome.scripting, permissions: chrome.permissions,
        runtime: chrome.runtime, storage: readerEngineStorage.rawStorage, messageRouter: readerEngineMessageRouter,
        state: {
          getPanelTargetTab: () => panelTargetTab, setPanelTargetTab: (value) => { panelTargetTab = value; },
          getActiveReadTabId: () => readState.activeReadTabId,
        },
        getActiveTtsProfileConfig: () => getActiveTtsProfileConfig(),
        getContentDiagnosticFlags: () => ({ recordFlow: testRecordFlowEnabled }),
      });
      const {
        extractActiveTab,
        getActiveReadableTab,
        getTabContextKey,
        sendPageMessage,
        sendPdfViewerMessage,
        updatePanelTargetTabFromStorageValue,
        warmActiveTabContentScriptAccess,
      } = readerEngineTargetResolver;
      const readRunTracker = createReadRunTracker();
      const playbackAudioPool = createReusableAudioElementPool({
        createAudio: () => new Audio(),
      });
      let voiceRuntimeController = null;
      let readControlsController = null;
      let sessionContextController = null;
      let speechPreloadController = null;
      let readingStateRenderer = null;
      const voiceSelectionListeners = new Set();
      const setReadingState = (...args) => readingStateRenderer.setReadingState(...args);
      const ensureModel = (...args) => voiceRuntimeController.ensureModel(...args);
      const prepareTtsBackendPlanForChunking = (...args) => voiceRuntimeController.prepareTtsBackendPlanForChunking(...args);
      const releaseLoadedVoiceModel = (...args) => voiceRuntimeController.releaseLoadedVoiceModel(...args);
      const canReleaseLoadedVoiceModel = (...args) => voiceRuntimeController.canReleaseLoadedVoiceModel(...args);
      const handleVoiceModelVisibilityChange = (...args) => voiceRuntimeController.handleVoiceModelVisibilityChange(...args);
      const trackActiveVoiceSynthesisPromise = (...args) => voiceRuntimeController.trackActiveVoiceSynthesisPromise(...args);
      const trackActiveVoiceSynthesisSegments = (...args) => voiceRuntimeController.trackActiveVoiceSynthesisSegments(...args);
      const handlePrimaryAction = (...args) => readControlsController.handlePrimaryAction(...args);
      const handleReadSelectedAction = (...args) => readControlsController.handleReadSelectedAction(...args);
      const handleReadFromStartAction = (...args) => readControlsController.handleReadFromStartAction(...args);
      const handleErrorRecoveryAction = (...args) => readControlsController.handleErrorRecoveryAction(...args);
      const waitForReadPause = (...args) => readControlsController.waitForReadPause(...args);
      const waitBetweenSections = (...args) => readControlsController.waitBetweenSections(...args);
      const handleReadTabRemoved = (...args) => readControlsController.handleReadTabRemoved(...args);
      const stopReading = (...args) => readControlsController.stopReading(...args);
      const skipToNextChunk = (...args) => readControlsController.skipToNextChunk(...args);
      const skipToPreviousChunk = (...args) => readControlsController.skipToPreviousChunk(...args);
      const requestJump = (...args) => readControlsController.requestJump(...args);
      const loadSavedResumePosition = (...args) => sessionContextController.loadSavedResumePosition(...args);
      const saveResumeChunk = (...args) => sessionContextController.saveResumeChunk(...args);
      const refreshActiveTabContext = (...args) => sessionContextController.refreshActiveTabContext(...args);
      const clearReadSessionBuffers = (...args) => sessionContextController.clearReadSessionBuffers(...args);
      const configurePageHighlight = (...args) => sessionContextController.configurePageHighlight(...args);
      const compactActivePdfChunkHistory = (...args) => sessionContextController.compactActivePdfChunkHistory(...args);
      const clearActiveSpeechPreloads = (...args) => speechPreloadController.clearActiveSpeechPreloads(...args);
      const readOrchestrator = createReadOrchestrator({
        state: {
          get iterator() {
            return readState.activeChunkIterator;
          },
          set iterator(value) {
            readState.activeChunkIterator = value;
          },
          get chunks() {
            return readState.activeChunks;
          },
          set chunks(value) {
            readState.activeChunks = value;
          },
          get wordCounts() {
            return activeChunkWordCounts;
          },
          set wordCounts(value) {
            activeChunkWordCounts = value;
          },
          get isStreaming() {
            return Boolean(readState.activeChunkIterator);
          },
          get articleSource() {
            return activeArticleSource;
          },
        },
        getChunkSpeechText,
        getChunkWordCount: (chunk) => getChunkWordCounts([chunk])[0] || 0,
        findStartChunkIndexByText,
        compactCompletedPdfChunks,
        isStopped: (options = {}) => {
          const { runId = null, signal = null } = /** @type {{ runId?: number|null, signal?: AbortSignal|null }} */ (options);
          return signal?.aborted || (runId != null && !readRunTracker.isCurrentRun(runId));
        },
      });
      function readSelectedHighlightSettings() { return getSelectedHighlightSettings(); }
      const queueNavigationController = createReaderEngineQueueNavigationController({
        els,
        state: {
          get chunks() { return readState.activeChunks; },
          get readingState() { return readState.readingState; },
        },
        requestJump,
      });
      const {
        jumpToEnteredChunk,
        jumpToFirstChunk,
        jumpToLastLoadedChunk,
        renderQueueNavigation,
      } = queueNavigationController;
      const queueRenderer = createReaderEngineQueueRenderer({
        els,
        requestJump,
        renderQueueNavigation,
        getQueueSearchQuery: () => queueSearchQuery,
        shouldAutoOpenQueue: () => false,
      });
      const renderQueue = queueRenderer.renderQueue;
      const renderTranscript = (text) => {
        activeTranscript = String(text || '');
        queueRenderer.renderTranscript(text);
      };
      const {
        setArticleSummary,
        renderResumePrompt,
        renderCodeSuggestion,
      } = createReaderEngineArticleSummaryController({
        els,
        renderTranscript,
        renderQueue,
        getInitialPreview,
        createArticleSummary,
        createResumePrompt,
        getState: () => ({ activeChunks: readState.activeChunks, currentChunk: readState.currentChunk }),
      });
      const pdfNavigationController = createReaderEnginePdfNavigationController({
        els,
        state: {
          get articleSource() { return activeArticleSource; },
          get readingState() { return readState.readingState; },
          get chunks() { return readState.activeChunks; },
          get currentChunk() { return readState.currentChunk; },
          get pdfPageCount() { return activePdfPageCount; },
          get chunkIterator() { return readState.activeChunkIterator; },
        },
        readOrchestrator,
        requestJump,
        renderQueue,
        onError: (error) => readerEngineLogger.warn('PDF page navigation failed.', error),
      });
      const {
        jumpToFirstPdfPage,
        jumpToEnteredPdfPage,
        renderPdfPageControls,
        skipCurrentPdfPage,
      } = pdfNavigationController;
      sessionContextController = createReaderEngineSessionContextController({
        state: {
          get activeReadTabId() { return readState.activeReadTabId; },
          set activeReadTabId(value) { readState.activeReadTabId = value; },
          get readingState() { return readState.readingState; },
          get currentChunk() { return readState.currentChunk; },
          set currentChunk(value) { readState.currentChunk = value; },
          set totalChunks(value) { readState.totalChunks = value; },
          get activeChunks() { return readState.activeChunks; },
          set activeChunks(value) { readState.activeChunks = value; },
          get activeChunkIterator() { return readState.activeChunkIterator; },
          set activeChunkIterator(value) { readState.activeChunkIterator = value; },
          get activeChunkWordCounts() { return activeChunkWordCounts; },
          set activeChunkWordCounts(value) { activeChunkWordCounts = value; sessionState.activeChunkWordCounts = value; },
          get activeArticleSource() { return activeArticleSource; },
          set activeArticleSource(value) { activeArticleSource = value; sessionState.activeArticleSource = value; },
          set activePdfPageCount(value) { activePdfPageCount = value; sessionState.activePdfPageCount = value; },
          get activePageContextKey() { return activePageContextKey; },
          set activePageContextKey(value) { activePageContextKey = value; sessionState.activePageContextKey = value; },
          set activeReadingCursor(value) { activeReadingCursor = value; sessionState.activeReadingCursor = value; },
          set ttsSectionReadyTransitionTracker(value) { ttsSectionReadyTransitionTracker = value; },
          get panelTargetTab() { return panelTargetTab; },
          set panelTargetTab(value) { panelTargetTab = value; },
        },
        storage: readerEngineStorage,
        getResumePositionStorageKey,
        getActiveReadableTab,
        getTabContextKey,
        readOrchestrator,
        renderResumePrompt,
        renderCodeSuggestion,
        setArticleSummary,
        setReadingState,
        renderQueue,
        renderPdfPageControls,
        clearTranscript: () => els.transcript.replaceChildren(),
        resetQueueSearch: () => {
          queueSearchQuery = '';
          if (els.queueSearchInput) els.queueSearchInput.value = '';
        },
        sendPageMessage,
        getSelectedHighlightSettings: readSelectedHighlightSettings,
        getChunkWordCounts,
        messageTypes: MESSAGE_TYPES,
        onError: suppressReaderEngineError,
        onLoadError: logSuppressedReaderEngineError(t("Could not load resume position")),
      });
      let pendingPlaybackSettingsWrite = null;
      let playbackSettingsWriteTimer = null;

      function savePlaybackSettingsSoon(settings) {
        pendingPlaybackSettingsWrite = {
          ...(pendingPlaybackSettingsWrite || {}),
          ...(settings || {}),
        };
        clearTimeout(playbackSettingsWriteTimer);
        playbackSettingsWriteTimer = setTimeout(() => {
          const next = pendingPlaybackSettingsWrite;
          pendingPlaybackSettingsWrite = null;
          readerEngineStorage.savePlaybackSettings(next).catch(suppressReaderEngineError);
        }, PLAYBACK_SETTINGS_WRITE_DEBOUNCE_MS);
      }

      function flushPendingPlaybackSettings() {
        if (!pendingPlaybackSettingsWrite) return;
        clearTimeout(playbackSettingsWriteTimer);
        const next = pendingPlaybackSettingsWrite;
        pendingPlaybackSettingsWrite = null;
        readerEngineStorage.savePlaybackSettings(next).catch(suppressReaderEngineError);
      }

      const readerEngineSettingsManager = createReaderEngineSettingsManager({
        els,
        storage: {
          savePlaybackSettings: savePlaybackSettingsSoon,
        },
        getCurrentAudio: () => currentAudio,
        configurePageHighlight: () => configurePageHighlight(),
        rescheduleCurrentSectionTiming: () => rescheduleCurrentSectionTiming(),
        onError: suppressReaderEngineError,
        debounceMs: 0,
      });
      const ttsProbeController = createReaderEngineTtsProbeController({
        readerEngineStorage,
        now: getNowMs,
        suppressError: suppressReaderEngineError,
        setCachedSummary: (value) => { cachedTtsHardwareProbeSummary = value; },
        getSectionReadyTransitionTracker: () => ttsSectionReadyTransitionTracker,
        recordSectionTransitionDecision: (event) => ttsPerformanceGovernor?.recordSectionTransition(event),
        renderGovernorDecision: (decision) => renderTtsPerformanceGovernorDecision(decision),
      });
      const {
        init: initTtsHardwareProbe,
        isRecordingEnabled: isTtsHardwareProbeRecordingEnabled,
        recordBackendPlan: recordTtsProbeBackendPlan,
        recordModelFallback: recordTtsProbeModelFallback,
        recordModelLoad: recordTtsProbeModelLoad,
        recordFirstSynthesis: recordTtsProbeFirstSynthesis,
        recordTimingSources: recordTtsProbeTimingSources,
        recordSectionSynthesisWithReadyTransition: recordTtsSectionSynthesis,
        recordSectionTransition: recordTtsProbeSectionTransition,
        recordSectionPlaybackStart: recordTtsProbeSectionPlaybackStart,
        recordSectionPlaybackEnd: recordTtsProbeSectionPlaybackEnd,
        recordSectionPause: recordTtsProbeSectionPause,
        recordPreTtsLatency: recordTtsProbePreTtsLatency,
      } = ttsProbeController;
      const voiceSettingsController = createReaderEngineVoiceSettingsController({
        els,
        readerEngineStorage,
        readerEngineSettingsManager,
        state: {
          get selectedLanguageCode() {
            return selectedLanguageCode;
          },
          setSelectedLanguageCode(value) {
            selectedLanguageCode = value;
          },
          get ttsPerformanceGovernor() {
            return ttsPerformanceGovernor;
          },
          setTtsPerformanceGovernor(value) {
            ttsPerformanceGovernor = value;
          },
          get cachedTtsHardwareProbeSummary() {
            return cachedTtsHardwareProbeSummary;
          },
          get tts() {
            return tts;
          },
          get testSilentTtsEnabled() {
            return testSilentTtsEnabled;
          },
          setIdleReleaseEnabled(value) {
            idleReleaseEnabled = value;
          },
        },
        savePlaybackSettingsSoon,
        suppressReaderEngineError,
        releaseLoadedVoiceModel,
        canReleaseLoadedVoiceModel,
        onVoiceSelectionChanged: () => { for (const listener of voiceSelectionListeners) listener(); },
        warmSelectedVoice: async (voiceId) => {
          if (!tts || !voiceId || resolveSelectedVoice()?.engine === 'omnivoice' || ['preparing', 'reading', 'paused'].includes(readState.readingState)) return;
          await ensureModel({ warmupVoice: voiceId });
        },
      });

      const {
        renderVoiceEngineSetting,
        bindVoiceSettings,
        getActiveTtsProfileConfig,
        getPlaybackSpeed,
        getSectionEarlyAdvanceSeconds,
        getSectionPauseDelayMs,
        getSelectedHighlightSettings,
        getSelectedSkipCodeSnippets,
        populateVoices,
        renderHighlightSettings,
        renderLanguageStatus,
        renderIdleReleaseSetting,
        renderSectionPauseSetting,
        renderSkipCodeSettings,
        renderTtsBackendPreferenceSetting,
        renderTtsBackendStatus: renderTtsBackendStatusUi,
        renderTtsPerformanceGovernorDecision,
        renderTtsPerformanceProfileSetting,
        resetTtsPerformanceGovernor,
        resolveSelectedVoice,
        shouldForceWasmVoiceModel,
        updateVoiceSettingsSummary,
        warmSelectedVoice,
      } = voiceSettingsController;
      const renderTtsBackendStatus = (plan) => {
        backendPlan = plan || null;
        renderTtsBackendStatusUi(plan);
      };

      voiceRuntimeController = createReaderEngineVoiceRuntimeController({
        els,
        state: {
          get tts() { return tts; },
          set tts(value) { tts = value; },
          get readingState() { return readState.readingState; },
          get currentAudio() { return currentAudio; },
          get activeSectionPauseDelay() { return activeSectionPauseDelay; },
          set activeSectionPauseDelay(value) { activeSectionPauseDelay = value; },
          get idleReleaseEnabled() { return idleReleaseEnabled; },
          get ttsPerformanceGovernor() { return ttsPerformanceGovernor; },
          get modelSetupState() { return modelSetupState; },
          set modelSetupState(value) {
            modelSetupState = value;
            sessionState.modelSetupState = value;
          },
        },
        documentRef: document,
        ttsService,
        shouldForceWasmVoiceModel,
        resolveSelectedVoice,
        getNowMs,
        render: {
          setReadingState,
          renderGovernorDecision: renderTtsPerformanceGovernorDecision,
          renderBackendStatus: renderTtsBackendStatus,
          recordBackendPlan: recordTtsProbeBackendPlan,
          recordModelFallback: recordTtsProbeModelFallback,
          recordModelLoad: recordTtsProbeModelLoad,
          onError: suppressReaderEngineError,
        },
        logger: readerEngineLogger,
      });

      const pageHighlightController = createReaderEnginePageHighlightController({
        sendPageMessage, getSelectedHighlightSettings,
      });
      const {
        flashResumeSection,
        highlightChunk,
        highlightQueuedChunk,
        shouldSyncPageHighlights,
      } = pageHighlightController;
      const setPageHighlightPaused = (paused, tabId = readState.activeReadTabId) => pageHighlightController.setPageHighlightPaused(paused, tabId);
      const clearPageHighlight = (tabId = readState.activeReadTabId) => pageHighlightController.clearPageHighlight(tabId);

      readControlsController = createReaderEngineReadControlsController({
        state: {
          get activeReadPromise() { return activeReadPromise; },
          get activeReadTabId() { return readState.activeReadTabId; },
          get readingState() { return readState.readingState; },
          get currentChunk() { return readState.currentChunk; },
          get activeChunks() { return readState.activeChunks; },
          get activeChunkIterator() { return readState.activeChunkIterator; },
          get activeReadingCursor() { return activeReadingCursor; },
          get currentAudio() { return currentAudio; },
          get currentAudioWatchdog() { return currentAudioWatchdog; },
          get activeSectionPauseDelay() { return activeSectionPauseDelay; },
          set activeSectionPauseDelay(value) { activeSectionPauseDelay = value; },
          get pendingReadPauseGate() { return pendingReadPauseGate; },
          set pendingReadPauseGate(value) { pendingReadPauseGate = value; sessionState.pendingReadPauseGate = value; },
          get activePrimaryAction() { return activePrimaryAction; },
          set releaseReadSessionAfterCleanup(value) { releaseReadSessionAfterCleanup = value; },
        },
        readRunTracker,
        playbackSession,
        setReadingState,
        setPageHighlightPaused,
        clearPageHighlight,
        clearActiveSpeechPreloads,
        getSectionPauseDelayMs,
        recordSectionPause: recordTtsProbeSectionPause,
        onPrimaryRead({ tab = null, startMode = 'viewport', resumeConfirmed = false, recovery = false } = {}) {
          startReadPage({ startMode, resumeConfirmed, tab }).catch((error) => readerEngineLogger.error(recovery ? 'Recovery retry failed.' : 'Primary read action failed.', error));
        },
        onReadSelected({ tab = null } = {}) {
          startReadPage({ readSelection: true, tab }).catch((error) => readerEngineLogger.error('Selected-text read action failed.', error));
        },
        async onGrantAccess({ tab = null } = {}) {
          const target = tab || panelTargetTab || await loadPanelTargetTab();
          if (!await requestContentScriptAccess({ tab: target, permissions: chrome.permissions })) {
            throw Object.assign(new Error('PageNarrator could not get access to this site.'), { code: 'host_permission_required' });
          }
          await startReadPage({ ...(lastReadOptions || { startMode: 'viewport' }), tab: target });
        },
        chrome,
        documentRef: document,
        logger: readerEngineLogger,
        onError: suppressReaderEngineError,
      });
      speechPreloadController = createReaderEngineSpeechPreloadController({
        state: {
          get activeChunks() { return readState.activeChunks; }, get activeSpeechPreloadCleanup() { return activeSpeechPreloadCleanup; },
          set activeSpeechPreloadCleanup(value) { activeSpeechPreloadCleanup = value; }, get selectedLanguageCode() { return selectedLanguageCode; },
          get testForceKokoroFailureEnabled() { return testForceKokoroFailureEnabled; }, get testSilentTtsEnabled() { return testSilentTtsEnabled; },
          get tts() { return tts; }, get ttsPerformanceGovernor() { return ttsPerformanceGovernor; },
          getSelectedVoiceId: () => els.voice.value,
        },
        playbackSession,
        readRunTracker,
        getNowMs,
        getActiveTtsProfileConfig,
        resolveSelectedVoice,
        trackActiveVoiceSynthesisPromise,
        trackActiveVoiceSynthesisSegments,
        highlightQueuedChunk,
        suppressError: suppressReaderEngineError,
        renderGovernorDecision: renderTtsPerformanceGovernorDecision,
        recordFirstSynthesis: recordTtsProbeFirstSynthesis,
        recordSectionSynthesis: recordTtsSectionSynthesis,
        recordAudioDecodeLatency(event = {}) {
          const { sectionIndex, decodeLatencyMs, readyState, channel = 'preload_decode_latency', kind = 'audio_preload_decode_latency' } = /** @type {any} */ (event);
          flowRecorder.record({
            channel,
            kind,
            chunkIndex: sectionIndex,
            decodeLatencyMs,
            readyState,
          });
        },
        recordPipeline: event => flowRecorder.record(event),
      });
      const {
        ensureSpeechPreloadWindow,
        getProfileMinimumAhead,
        readPreloadedSpeech,
      } = speechPreloadController;

      const audioPlaybackManager = createAudioPlaybackManager({
        audioPool: playbackAudioPool,
        readRunTracker,
        getPlaybackSpeed,
        getSectionEarlyAdvanceSeconds,
        readAudioOutputLatencySeconds,
        getActiveReadTabId: () => readState.activeReadTabId,
        sendPageMessage,
        flowRecorder,
        isTtsHardwareProbeRecordingEnabled,
        recordTtsProbeTimingSources,
        recordTtsProbeSectionPlaybackStart,
        recordTtsProbeSectionPlaybackEnd,
        getNowMs,
        suppressError: suppressReaderEngineError,
        onAudioStateChange(state) {
          currentAudio = state.currentAudio;
          currentAudioWatchdog = state.currentAudioWatchdog;
          clearCurrentAudioEventListeners = state.clearCurrentAudioEventListeners;
        },
        setRescheduleCurrentSectionTiming(callback) {
          rescheduleCurrentSectionTiming = callback;
        },
      });

      const readLoopOrchestrator = createReadLoopOrchestrator({
        state: {
          get testSilentTtsEnabled() { return testSilentTtsEnabled; },
          get readingState() { return readState.readingState; },
          get releaseReadSessionAfterCleanup() { return releaseReadSessionAfterCleanup; },
          set releaseReadSessionAfterCleanup(value) { releaseReadSessionAfterCleanup = value; },
          get currentChunk() { return readState.currentChunk; },
          set currentChunk(value) { readState.currentChunk = value; },
          get totalChunks() { return readState.totalChunks; },
          set totalChunks(value) { readState.totalChunks = value; },
          get activeReadTabId() { return readState.activeReadTabId; },
          set activeReadTabId(value) { readState.activeReadTabId = value; },
          get activeArticleSource() { return activeArticleSource; },
          set activeArticleSource(value) { activeArticleSource = value; sessionState.activeArticleSource = value; },
          get activePdfPageCount() { return activePdfPageCount; },
          set activePdfPageCount(value) { activePdfPageCount = value; sessionState.activePdfPageCount = value; },
          get activePageContextKey() { return activePageContextKey; },
          set activePageContextKey(value) { activePageContextKey = value; sessionState.activePageContextKey = value; },
          get activeChunkIterator() { return readState.activeChunkIterator; },
          set activeChunkIterator(value) { readState.activeChunkIterator = value; },
          get activeChunks() { return readState.activeChunks; },
          set activeChunks(value) { readState.activeChunks = value; },
          get activeChunkWordCounts() { return activeChunkWordCounts; },
          set activeChunkWordCounts(value) { activeChunkWordCounts = value; sessionState.activeChunkWordCounts = value; },
          get totalReadableWordCount() { return totalReadableWordCount; },
          set totalReadableWordCount(value) { totalReadableWordCount = value; },
          get activeReadingCursor() { return activeReadingCursor; },
          set activeReadingCursor(value) { activeReadingCursor = value; sessionState.activeReadingCursor = value; },
          get ttsSectionReadyTransitionTracker() { return ttsSectionReadyTransitionTracker; },
          set ttsSectionReadyTransitionTracker(value) { ttsSectionReadyTransitionTracker = value; },
          get activeSpeechPreloadCleanup() { return activeSpeechPreloadCleanup; },
          set activeSpeechPreloadCleanup(value) { activeSpeechPreloadCleanup = value; },
          get selectedLanguageCode() { return selectedLanguageCode; },
          set selectedLanguageCode(value) { selectedLanguageCode = value; },
          set currentAudio(value) { currentAudio = value; },
          set activeSectionPauseDelay(value) { activeSectionPauseDelay = value; },
          set rescheduleCurrentSectionTiming(value) { rescheduleCurrentSectionTiming = value; },
          set currentAudioWatchdog(value) { currentAudioWatchdog = value; },
        },
        readRunTracker,
        readOrchestrator,
        getNowMs,
        setReadingState,
        refreshPanelTargetTab,
        warmActiveTabContentScriptAccess,
        prepareTtsBackendPlanForChunking,
        extractActiveTab,
        renderCodeSuggestion,
        getSelectedSkipCodeSnippets,
        getActiveTtsProfileConfig,
        clearPageHighlight,
        shouldSyncPageHighlights,
        flashResumeSection,
        suppressError: suppressReaderEngineError,
        loadSavedResumePosition,
        renderResumePrompt,
        setArticleSummary,
        setLanguageSelectValue: (value) => { els.language.value = value; },
        populateVoices,
        renderLanguageStatus,
        resolveSelectedVoice,
        ensureModel,
        prepareIncomingVoice: (voice, options) => voiceRuntimeController.prepareIncomingVoice(voice, options),
        activateIncomingVoice: model => voiceRuntimeController.activateIncomingVoice(model),
        createSpeechPreloadForVoice: (voice, chunk, options) => speechPreloadController.createSpeechPreloadForVoice(voice, chunk, options),
        subscribeVoiceSelection(listener) {
          voiceSelectionListeners.add(listener);
          return () => voiceSelectionListeners.delete(listener);
        },
        restoreVoiceSelection(voice, error) {
          void voiceSettingsController.restoreVoiceSelection(voice).catch(suppressReaderEngineError);
          voiceRuntimeController.failIncomingVoice(error);
        },
        getSelectedVoiceId: () => els.voice.value,
        getProfileMinimumAhead,
        ensureSpeechPreloadWindow,
        readPreloadedSpeech,
        playKokoroSpeech,
        highlightChunk,
        setCurrentSectionText: (text) => { els.body.textContent = text; },
        waitBetweenSections,
        waitForReadPause,
        compactActivePdfChunkHistory,
        queuePostPlaybackBookkeeping,
        saveResumeChunk,
        clearActiveSpeechPreloads,
        clearCurrentAudioEventListeners: () => clearCurrentAudioEventListeners(),
        resetAudioEventListeners: () => { clearCurrentAudioEventListeners = () => {}; },
        releasePlaybackAudioPool: () => playbackAudioPool.release(),
        clearReadSessionBuffers,
        releaseLoadedVoiceModel,
        flowRecorder,
        recordTtsProbeSectionTransition,
        recordPreTtsLatency: recordTtsProbePreTtsLatency,
      });

      const teardownController = createReaderEngineTeardownController({
        state: {
          get activeArticleSource() { return activeArticleSource; }, get activeChunkIterator() { return readState.activeChunkIterator; },
          get activeReadTabId() { return readState.activeReadTabId; }, get activeSectionPauseDelay() { return activeSectionPauseDelay; },
          set activeSectionPauseDelay(value) { activeSectionPauseDelay = value; }, get clearCurrentAudioEventListeners() { return clearCurrentAudioEventListeners; },
          set clearCurrentAudioEventListeners(value) { clearCurrentAudioEventListeners = value; }, get currentAudio() { return currentAudio; },
          set currentAudio(value) { currentAudio = value; }, get currentAudioWatchdog() { return currentAudioWatchdog; },
          set currentAudioWatchdog(value) { currentAudioWatchdog = value; }, get panelTargetTab() { return panelTargetTab; },
          set releaseReadSessionAfterCleanup(value) { releaseReadSessionAfterCleanup = value; },
        },
        playbackSession,
        playbackAudioPool,
        activeVoiceSynthesisTracker: voiceRuntimeController.activeVoiceSynthesisTracker,
        voiceModelReleaseController: voiceRuntimeController.voiceModelReleaseController,
        runCleanupAfterSettled,
        stopReading,
        flushPendingPlaybackSettings,
        clearActiveSpeechPreloads,
        clearReadSessionBuffers,
        isPageNarratorPdfViewerUrl,
        sendPdfViewerMessage,
        releaseLoadedVoiceModel,
        suppressError: suppressReaderEngineError,
      });
      const { handlePanelPageHide } = teardownController;

      const onboardingController = createReaderEngineOnboardingController({
        els,
        storage: readerEngineStorage.rawStorage,
        onError: suppressReaderEngineError,
        onPrimary: () => {
          if (onboardingController.getStep() === 'quick-win') {
            handleReadSelectedAction();
            return;
          }
          startReadPage({ startMode: 'top' }).catch(suppressReaderEngineError);
        },
      });

      const reviewPromptController = createReaderEngineReviewPromptController({
        els,
        storage: readerEngineStorage.rawStorage,
        onError: suppressReaderEngineError,
        getExtensionId: () => chrome.runtime.id,
        openReview: (url) => {
          void Promise.resolve(chrome.tabs.create({ url })).catch(suppressReaderEngineError);
        },
      });

      readingStateRenderer = createReaderEngineReadingStateRenderer({
        els,
        session,
        state: {
          get readingState() { return readState.readingState; },
          get currentChunk() { return readState.currentChunk; },
          set currentChunk(value) { readState.currentChunk = value; },
          get totalChunks() { return readState.totalChunks; },
          set totalChunks(value) { readState.totalChunks = value; },
          get activeChunks() { return readState.activeChunks; },
          get activeChunkWordCounts() { return activeChunkWordCounts; },
          get totalReadableWordCount() { return totalReadableWordCount; },
          get activeArticleSource() { return activeArticleSource; },
          get activePdfPageCount() { return activePdfPageCount; },
          get modelSetupState() { return modelSetupState; },
          get activeTranscript() { return activeTranscript; },
          get backendPlan() { return backendPlan; },
          set activePrimaryAction(value) { activePrimaryAction = value; },
        },
        chrome,
        icons: ICONS,
        renderQueue,
        renderPdfPageControls,
        renderReaderEngineErrorNotice,
        hideReaderEngineErrorNotice,
        onboardingController,
        reviewPromptController,
        onRendered(state) {
          voiceRuntimeController.scheduleForReadingState(state);
        },
        onError: suppressReaderEngineError,
      });
      function getNowMs() { return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now(); }
      function queuePostPlaybackBookkeeping(promise) {
        Promise.resolve(promise).catch((error) => {
          readerEngineLogger.warn('Post-playback bookkeeping failed.', error);
        });
      }
      async function refreshPanelTargetTab() {
        if (panelTargetTab?.id) return panelTargetTab;
        const state = await readerEngineStorage.get(READABLE_TAB_TARGET_KEY).catch(() => ({}));
        updatePanelTargetTabFromStorageValue(state[READABLE_TAB_TARGET_KEY]);
        return panelTargetTab;
      }
      async function loadPanelTargetTab() {
        return refreshPanelTargetTab();
      }
      async function playKokoroSpeech(speech, chunk, options = {}) {
        if (speech?.kind === 'segments') {
          await playProgressiveSpeechSegmentsHelper(speech, chunk, {
            ...options,
            audioPlaybackManager,
            createProgressiveSegmentChunk,
          });
          return;
        }
        await audioPlaybackManager.playAudio(speech.result.blob, speech.result.wordTimings, chunk, { ...options, preparedAudio: speech.result.preparedAudio });
      }
      function readPage(options = {}) {
        return readLoopOrchestrator.readPage(options);
      }
      async function startReadPage(options = {}) {
        if (activeReadPromise && readState.readingState === 'stopping') {
          await activeReadPromise.catch(suppressReaderEngineError);
        }
        if (!options.recovery) lastReadOptions = { ...options };
        const readPromise = readRunner.startPage({ ...options, run: readPage });
        activeReadPromise = readPromise;
        sessionState.activeReadPromise = readPromise;
        try {
          await readPromise;
        } finally {
          if (activeReadPromise === readPromise) {
            activeReadPromise = null;
            sessionState.activeReadPromise = null;
          }
        }
      }
      function handleQueueSearchInput() {
        queueSearchQuery = String(els.queueSearchInput?.value || '').trim();
        renderQueue(readState.activeChunks, readState.currentChunk);
      }
      function resumeSavedReading() {
        renderResumePrompt(null);
        startReadPage({ startMode: 'viewport', resumeConfirmed: true }).catch((error) => {
          readerEngineLogger.error('Resume read action failed.', error);
        });
      }
      function startOverFromResume() {
        renderResumePrompt(null);
        startReadPage({ startMode: 'top' }).catch((error) => {
          readerEngineLogger.error('Start-over read action failed.', error);
        });
      }
      async function acceptCodeCleanupSuggestion() {
        if (!els.skipCodeSnippets) return;
        els.skipCodeSnippets.checked = true;
        await saveReadingCleanupSetting(true, {
          storage: readerEngineStorage.rawStorage,
        }).catch(suppressReaderEngineError);
        renderCodeSuggestion({ visible: false });
      }
      function setPlaybackSpeed(speed) { readerEngineSettingsManager.setPlaybackSpeed(speed); }
      function setSectionPause(sectionPauseSeconds) { readerEngineSettingsManager.setSectionPause(sectionPauseSeconds); }
      const applyPlaybackSettingsFromStorage = () => applyStoredPlaybackSettings({
        els, getSelectedLanguageCode: () => selectedLanguageCode, setSelectedLanguageCode: (value) => { selectedLanguageCode = value; },
        readerEngineStorage, readerEngineSettingsManager, populateVoices, renderTtsBackendPreferenceSetting, renderTtsPerformanceProfileSetting, renderIdleReleaseSetting,
        renderHighlightSettings, renderSkipCodeSettings, resetTtsPerformanceGovernor,
        updateVoiceSettingsSummary, renderLanguageStatus, warmSelectedVoice, renderVoiceEngineSetting,
        onVoiceSelectionChanged: () => { for (const listener of voiceSelectionListeners) listener(); },
      });
      async function init() {
        globalThis.__pnReaderEngineInitStage = 'test-flags';
        const testFlags = await readExtensionTestFlags(chrome.storage.local, { logger: readerEngineLogger });
        testSilentTtsEnabled = testFlags.silentTts;
        testRecordFlowEnabled = testFlags.recordFlow;
        testForceKokoroFailureEnabled = testFlags.forceKokoroFailure;
        globalThis.__pnReaderEngineInitStage = 'tts-probe';
        await initTtsHardwareProbe();
        globalThis.__pnReaderEngineInitStage = 'settings';
        const settings = await readerEngineStorage.getPlaybackSettings().catch(() => null);
        idleReleaseEnabled = settings?.idleReleaseEnabled !== false;
        resetTtsPerformanceGovernor(settings);
        selectedLanguageCode = normalizeLanguageCode(settings?.language || 'en');
        renderVoiceEngineSetting(settings);
        els.speed.max = String(getMaxPlaybackSpeed());
        if (settings) els.speed.value = String(settings.speed);
        renderTtsBackendPreferenceSetting(settings?.ttsBackendPreference);
        renderTtsPerformanceProfileSetting(settings?.ttsPerformanceProfile);
        renderIdleReleaseSetting(idleReleaseEnabled);
        renderSectionPauseSetting(settings?.sectionPauseSeconds);
        renderHighlightSettings(settings?.highlight);
        renderSkipCodeSettings(settings?.skipCodeSnippets);
        globalThis.__pnReaderEngineInitStage = 'voices';
        await populateVoices();
        bindVoiceSettings();
        setReadingState('idle');
        recordTtsProbePreTtsLatency({ panelReadyMs: Math.max(0, getNowMs() - readerEngineOpenedAtMs) });
        setArticleSummary({});
        globalThis.__pnReaderEngineInitStage = 'target';
        await loadPanelTargetTab();
        void refreshActiveTabContext().catch(suppressReaderEngineError);
        globalThis.__pnReaderEngineInitStage = 'window';
        const readerEngineWindowId = Number((await chrome.windows?.getCurrent?.().catch(() => null))?.id);
        const isReaderEngineWindowEvent = (/** @type {any} */ windowId) => !Number.isInteger(readerEngineWindowId) || !Number.isInteger(Number(windowId)) || Number(windowId) === readerEngineWindowId;
        controller.bind?.({
          els,
          document,
          actions: {
            acceptCodeCleanupSuggestion,
            handleErrorRecoveryAction,
            handlePrimaryAction,
            handleQueueSearchInput,
            handleReadSelectedAction,
            handleVoiceModelVisibilityChange,
            jumpToEnteredChunk,
            jumpToEnteredPdfPage,
            jumpToFirstChunk,
            jumpToFirstPdfPage,
            jumpToLastLoadedChunk,
            onError: suppressReaderEngineError,
            resumeSavedReading,
            skipCurrentPdfPage,
            skipToNextChunk,
            skipToPreviousChunk,
            startOverFromResume,
            stopReading,
          },
        });

        void Promise.all([
          onboardingController.init(),
          reviewPromptController.init(),
        ]).then(() => {
          onboardingController.render({ readingState: readState.readingState });
        }).catch(suppressReaderEngineError);

        window.addEventListener('pagehide', handlePanelPageHide);
        chrome.runtime.onMessage.addListener((message, sender) => {
          if (!isTrustedBackgroundSender(sender, chrome.runtime)) return false;
          return readerEngineMessageRouter.handleRuntimeMessage(message);
        });
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName !== 'local') return;
          if (changes[READABLE_TAB_TARGET_KEY]) {
            updatePanelTargetTabFromStorageValue(changes[READABLE_TAB_TARGET_KEY].newValue);
            void refreshActiveTabContext().catch(suppressReaderEngineError);
          }
          if (changes[STORAGE_KEYS.PLAYBACK_SETTINGS]) {
            void applyPlaybackSettingsFromStorage().catch(suppressReaderEngineError);
          }
        });
        chrome.tabs.onActivated.addListener((activeInfo) => {
          if (isReaderEngineWindowEvent(activeInfo?.windowId)) {
            void refreshActiveTabContext({ id: activeInfo?.tabId, windowId: activeInfo?.windowId }).catch(suppressReaderEngineError);
          }
        });
        chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
          if (isReaderEngineWindowEvent(tab?.windowId) && (changeInfo.status === 'loading' || changeInfo.url || tab.active)) {
            void refreshActiveTabContext(tab?.active ? tab : null).catch(suppressReaderEngineError);
          }
        });
        chrome.tabs.onRemoved.addListener(handleReadTabRemoved);

        globalThis.__pnReaderEngineInitStage = 'initialized';
      }

      return init().catch((error) => {
        readerEngineLogger.error('PageNarrator readerEngine failed to initialize.', error);
        setReadingState('error', { message: t("PageNarrator failed to initialize.") });
      });

    },
  };
}
