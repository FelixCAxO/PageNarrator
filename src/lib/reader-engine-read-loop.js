import { chunkText } from './speech-chunks.js';
import { getChunkSpeechText } from './reader-engine-chunks.js';
import { createReadingCursor } from './reading-cursor.js';
import { getChunkWordCounts, getTotalChunkWordCount } from './reader-engine-view.js';
import { findStartChunkIndex, findStartChunkIndexByText } from './reading-start.js';
import { applyReadingPreferences } from './reading-filters.js';
import { createCodeCleanupSuggestion } from './reading-suggestions.js';
import { detectPageLanguage } from './language-detection.js';
import { getDetectedLanguageSuggestion, getUnsupportedLanguageMessage, normalizeLanguageCode } from './language-voice-options.js';
import { createSpeechEngineHandoff } from './speech-engine-handoff.js';
import {
  clearSpeechPreloadState,
  cleanupReadRun,
  createPdfEmptyStreamDiagnostics,
  createSectionReadyTransitionTracker,
  getEmptyStreamMessage,
  waitForSpeechPreloadReady,
} from './reader-engine-read-lifecycle.js';
import { classifyArticleExtractionError } from './article-extraction-errors.js';
import { createLogger } from './logger.js';

const readLoopLogger = createLogger('reader-engine-read-loop');
const PAGE_START_POSITION_MAX_EXTRA_CHUNKS = 5000;
const PAGE_START_POSITION_BATCH_SIZE = 32;


/** @param {any} [deps] */
export function createReadLoopOrchestrator({
  state = {},
  readRunTracker,
  readOrchestrator = {
    getPlaybackTotal: (_idx = 0) => (state.activeChunks?.length || 0),
    getLoadedChunkText: () => '',
    fillChunkBuffer: async () => false,
    fillStartPositionBuffer: async () => null,
  },
  getNowMs = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()),
  setReadingState = () => {},
  refreshPanelTargetTab = async () => {},
  warmActiveTabContentScriptAccess = async () => {},
  prepareTtsBackendPlanForChunking = async () => {},
  extractActiveTab = async () => null,
  renderCodeSuggestion = () => {},
  getSelectedSkipCodeSnippets = () => false,
  getActiveTtsProfileConfig = () => ({ maxChunkLength: 320, targetMinLength: 180, preloadAhead: 1 }),
  clearPageHighlight = async () => {},
  shouldSyncPageHighlights = () => false,
  flashResumeSection = async () => {},
  suppressError = () => {},
  loadSavedResumePosition = async () => null,
  renderResumePrompt = () => {},
  setArticleSummary = () => {},
  setLanguageSelectValue = () => {},
  populateVoices = async () => {},
  renderLanguageStatus = async () => {},
  resolveSelectedVoice = () => null,
  ensureModel = async () => null,
  prepareIncomingVoice = null,
  activateIncomingVoice = () => Promise.resolve(),
  createSpeechPreloadForVoice = () => null,
  subscribeVoiceSelection = () => () => {},
  restoreVoiceSelection = () => {},
  getSelectedVoiceId = () => null,
  getProfileMinimumAhead = () => 0,
  ensureSpeechPreloadWindow = () => null,
  readPreloadedSpeech = async () => null,
  playKokoroSpeech = async () => {},
  highlightChunk = async () => ({ ok: false }),
  setCurrentSectionText = () => {},
  waitBetweenSections = async () => {},
  waitForReadPause = async () => {},
  compactActivePdfChunkHistory = () => {},
  queuePostPlaybackBookkeeping = () => {},
  saveResumeChunk = async () => {},
  clearActiveSpeechPreloads = () => {},
  clearCurrentAudioEventListeners = () => {},
  resetAudioEventListeners = () => {},
  releasePlaybackAudioPool = () => {},
  clearReadSessionBuffers = () => {},
  releaseLoadedVoiceModel = async () => false,
  flowRecorder = { record() {} },
  recordTtsProbeSectionTransition = () => {},
  recordPreTtsLatency = () => {},
} = {}) {
  function isChunkStreamArticle(article) {
    return typeof article?.chunkStream?.[Symbol.asyncIterator] === 'function';
  }

  function isPdfStreamArticle(article) {
    return article?.source === 'pdf' || Number(article?.startPosition?.pageNumber) > 0;
  }

  function isReadRunStopped(runId, signal) {
    return signal?.aborted || (runId != null && !readRunTracker.isCurrentRun(runId));
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function recordPreTtsLatencyPartial(partial) {
    recordPreTtsLatency(partial);
  }

  async function fillStreamingStartPositionBuffer(startPosition, options = {}) {
    await readOrchestrator.fillStartPositionBuffer(startPosition, options);
  }

  function supportsStreamingResume(article, isStreaming) {
    return Boolean(isStreaming);
  }

  async function closeUnusedChunkStream(article) {
    const iterator = article?.chunkStream?.[Symbol.asyncIterator]?.();
    if (!iterator?.return) return;
    try {
      await iterator.return();
    } catch (error) {
      suppressError(error);
    }
  }

  /**
   * @param {any} article
   * @param {any} [options]
   */
  async function loadResumeForArticle(article, {
    isStreaming = false,
    readSelection = false,
    startMode = 'viewport',
    runId = null,
    signal = null,
  } = {}) {
    if (readSelection || startMode === 'top' || startMode === 'restart') return null;
    if (!isStreaming) return loadSavedResumePosition(article.url, state.activeChunks);
    if (!supportsStreamingResume(article, isStreaming)) return null;
    const pdfStartPage = getDeepPdfStartPage(article);
    if (pdfStartPage) return loadPdfStartPageResumePosition(article, pdfStartPage, { runId, signal });
    return loadStreamingResumePosition(article, { runId, signal });
  }

  // A PDF read past page 1 starts on the page the reader scrolled or linked to.
  function getDeepPdfStartPage(article) {
    if (article?.source !== 'pdf') return 0;
    const pageNumber = Math.trunc(Number(article.startPosition?.pageNumber));
    return Number.isFinite(pageNumber) && pageNumber > 1 ? pageNumber : 0;
  }

  /**
   * Saved chunk indexes count from the page the saving read started on, so they are not
   * replayed in a stream that starts elsewhere. Only a saved position on the start page
   * itself resumes (mid-page), matched by its excerpt.
   * @param {any} article
   * @param {number} startPage
   * @param {any} [options]
   */
  async function loadPdfStartPageResumePosition(article, startPage, { runId = null, signal = null } = {}) {
    const saved = await loadSavedResumePosition(article.url, [], { allowUnverified: true });
    if (!saved?.excerpt || Math.trunc(Number(saved.pageNumber)) !== startPage) return null;

    const maxExtraChunks = 32;
    let checkedCount = 0;
    let loadedExtraChunks = 0;
    while (!isReadRunStopped(runId, signal)) {
      for (; checkedCount < state.activeChunks.length; checkedCount += 1) {
        const chunk = state.activeChunks[checkedCount];
        if (Math.trunc(Number(chunk?.pageNumber)) !== startPage) return null;
        if (findStartChunkIndexByText([chunk], saved.excerpt) === 0) {
          return checkedCount > 0 ? { ...saved, chunk: checkedCount } : null;
        }
      }
      if (loadedExtraChunks >= maxExtraChunks) return null;
      const previousLength = state.activeChunks.length;
      const loaded = await readOrchestrator.fillChunkBuffer(previousLength, { runId, signal });
      if (!loaded || state.activeChunks.length <= previousLength) return null;
      loadedExtraChunks += state.activeChunks.length - previousLength;
    }
    return null;
  }

  /**
   * @param {any} article
   * @param {any} [options]
   */
  async function loadStreamingResumePosition(article, { runId = null, signal = null } = {}) {
    const saved = await loadSavedResumePosition(article.url, [], { allowUnverified: true });
    if (!saved) return null;

    const savedChunk = Math.max(0, Math.trunc(Number(saved.chunk) || 0));
    if (savedChunk > 0) {
      await readOrchestrator.fillChunkBuffer(savedChunk, { runId, signal });
      if (isReadRunStopped(runId, signal)) return null;
    }

    let verified = await loadSavedResumePosition(article.url, state.activeChunks);
    if (verified) return verified;

    const maxExtraChunks = 32;
    let loadedExtraChunks = 0;
    while (loadedExtraChunks < maxExtraChunks && !isReadRunStopped(runId, signal)) {
      const previousLength = state.activeChunks.length;
      const loaded = await readOrchestrator.fillChunkBuffer(previousLength, { runId, signal });
      if (!loaded || state.activeChunks.length <= previousLength) break;
      loadedExtraChunks += state.activeChunks.length - previousLength;
      verified = await loadSavedResumePosition(article.url, state.activeChunks);
      if (verified) return verified;
    }

    if (saved.pageNumber || saved.anchorId) {
      return saved;
    }

    return null;
  }

  /** @param {any} [options] */
  async function readPage({ readSelection = false, startMode = 'viewport', resumeConfirmed = false, tab = null } = {}) {
    const readStartedAtMs = getNowMs();
    let firstAudibleRecorded = false;
    const recordFirstAudible = () => {
      if (firstAudibleRecorded) return;
      firstAudibleRecorded = true;
      recordPreTtsLatencyPartial({ firstAudibleMs: Math.max(0, getNowMs() - readStartedAtMs) });
    };
    const readRunId = readRunTracker.beginRun();
    const runSignal = readRunTracker.getRunSignal(readRunId);
    let runIterator = null;
    let runTabId = null;
    let stoppedRun = false;
    let engineHandoff = null;
    let unsubscribeVoiceSelection = () => {};
    const requestedSource = readSelection ? 'selection' : '';
    state.releaseReadSessionAfterCleanup = false;
    state.currentChunk = 0;
    state.totalChunks = 0;
    state.activeArticleSource = requestedSource;
    state.activeChunks = [];
    state.activeChunkWordCounts = [];
    state.totalReadableWordCount = 0;
    renderResumePrompt(null);
    setReadingState('preparing', { source: requestedSource });

    const stopIfRequested = () => {
      if (!isReadRunStopped(readRunId, runSignal)) return false;
      stoppedRun = true;
      if (readRunTracker.isCurrentRun(readRunId)) setReadingState('stopping');
      return true;
    };

    try {
      await refreshPanelTargetTab();
      if (stopIfRequested()) return;
      await warmActiveTabContentScriptAccess(tab);
      if (stopIfRequested()) return;
      // Extraction captures chunk sizes, so select the runtime before starting its stream.
      const ttsBackendPlan = await prepareTtsBackendPlanForChunking({ signal: runSignal });
      if (stopIfRequested()) return;
      const extractionStartedAtMs = getNowMs();
      let article = await extractActiveTab({ tab, readSelection, startMode, signal: runSignal });
      recordPreTtsLatencyPartial({ extractionMs: Math.max(0, getNowMs() - extractionStartedAtMs) });
      if (stopIfRequested()) {
        await closeUnusedChunkStream(article);
        return;
      }
      const skipCodeSnippets = getSelectedSkipCodeSnippets();
      renderCodeSuggestion(createCodeCleanupSuggestion({
        skipCodeSnippets,
        chunks: article?.chunks,
      }));
      article = applyReadingPreferences(article, {
        skipCodeSnippets,
      });
      state.totalReadableWordCount = skipCodeSnippets && Array.isArray(article?.chunks) && article.chunks.length
        ? getTotalChunkWordCount(article.chunks)
        : Math.max(0, Math.trunc(Number(article?.totalReadableWordCount) || 0));
      const isStreaming = isChunkStreamArticle(article);
      if (!article || article.error || (!article.text && !isStreaming)) {
        await closeUnusedChunkStream(article);
        const extractionError = classifyArticleExtractionError(article);
        setReadingState('error', { message: extractionError.message, errorCode: extractionError.code });
        return;
      }
      if (!isStreaming || hasSummaryPreview(article)) setArticleSummary(article);

      state.activeReadTabId = article.tabId;
      runTabId = article.tabId;
      state.activeArticleSource = article.source || '';
      state.activePdfPageCount = Math.max(0, Math.trunc(Number(article.pageCount) || 0));
      const syncPageHighlights = shouldSyncPageHighlights(article);
      const ttsProfile = getActiveTtsProfileConfig();
      if (!syncPageHighlights) await clearPageHighlight(article.tabId);
      if (stopIfRequested()) {
        await closeUnusedChunkStream(article);
        return;
      }
      state.activePageContextKey = getTabContextKey({ id: article.tabId, url: article.url });
      state.activeChunkIterator = isStreaming ? article.chunkStream[Symbol.asyncIterator]() : null;
      runIterator = state.activeChunkIterator;
      const chunkingStartedAtMs = getNowMs();
      const chunkOptions = {
        targetMinLen: ttsProfile.targetMinLength,
        // ponytail: keep shipped first-chunk defaults; compare alternatives in tests.
        initialMaxChunkLength: 120,
        initialTargetMinLength: 80,
      };
      state.activeChunks = isStreaming
        ? []
        : Array.isArray(article.chunks) && article.chunks.length
          ? chunkText(article.chunks, ttsProfile.maxChunkLength, chunkOptions)
          : chunkText(article.text, ttsProfile.maxChunkLength, chunkOptions);
      state.activeChunkWordCounts = getChunkWordCounts(state.activeChunks);
      recordPreTtsLatencyPartial({ chunkingMs: Math.max(0, getNowMs() - chunkingStartedAtMs) });
      if (isStreaming) {
        await readOrchestrator.fillChunkBuffer(ttsProfile.preloadAhead, { runId: readRunId, signal: runSignal });
        if (stopIfRequested()) return;
        if (!state.activeChunks.length) {
          const diagnostics = createPdfEmptyStreamDiagnostics(article, {
            tabId: state.activeReadTabId,
            hasIterator: Boolean(runIterator),
          });
          if (diagnostics) readLoopLogger.warn('PDF stream produced no readable chunks.', diagnostics);
          setReadingState('error', { message: getEmptyStreamMessage(article) });
          return;
        }
        // Page chunks come from the already-extracted DOM and an anchored start is guaranteed to
        // be in the stream, so scan to it (e.g. the latest chat answer) instead of giving up after
        // a few chunks and falling back to the top. Unanchored starts keep the short cap.
        const scansToAnchoredStart = !isPdfStreamArticle(article) && Boolean(article.startPosition?.anchorId);
        const startPositionMaxExtraChunks = scansToAnchoredStart
          ? PAGE_START_POSITION_MAX_EXTRA_CHUNKS
          : Math.max(0, Math.trunc(Number(getProfileMinimumAhead(ttsProfile)) || 0));
        await fillStreamingStartPositionBuffer(article.startPosition, {
          runId: readRunId,
          signal: runSignal,
          maxExtraChunks: startPositionMaxExtraChunks,
          batchSize: scansToAnchoredStart ? PAGE_START_POSITION_BATCH_SIZE : 1,
        });
        if (stopIfRequested()) return;
      }

      state.totalChunks = readOrchestrator.getPlaybackTotal(state.currentChunk);
      const savedResume = await loadResumeForArticle(article, {
        isStreaming,
        readSelection,
        startMode,
        runId: readRunId,
        signal: runSignal,
      });
      if (stopIfRequested()) return;
      if (savedResume && !resumeConfirmed) {
        const articleTextSample = article.text || readOrchestrator.getLoadedChunkText();
        setArticleSummary({ ...article, text: articleTextSample, chunks: state.activeChunks });
        renderResumePrompt(savedResume);
        setReadingState('idle');
        return;
      }
      renderResumePrompt(null);
      const resumeChunk = savedResume?.chunk || 0;
      const startChunk = resumeChunk > 0
        ? resumeChunk
        : findStartChunkIndex(article.startPosition ? state.activeChunks : [], article.startPosition, { fallbackIndex: 0 });
      state.activeReadingCursor = createReadingCursor(isStreaming ? Number.MAX_SAFE_INTEGER : state.activeChunks.length, { initialIndex: startChunk });
      state.currentChunk = state.activeReadingCursor.current();
      flowRecorder.record({
        kind: 'chunks_extracted',
        totalChunks: state.activeChunks.length,
        startChunk,
        streaming: isStreaming,
      });

      const articleTextSample = article.text || readOrchestrator.getLoadedChunkText();
      setArticleSummary({ ...article, text: articleTextSample, chunks: state.activeChunks });
      if (resumeChunk > 0 && syncPageHighlights) {
        await flashResumeSection(article.tabId, state.activeChunks[state.currentChunk]).catch(suppressError);
        if (stopIfRequested()) return;
      }
      const detectedLanguage = await detectPageLanguage(articleTextSample);
      if (stopIfRequested()) return;
      const suggestion = getDetectedLanguageSuggestion(detectedLanguage, resolveSelectedVoice()?.engine || 'kokoro');
      await renderLanguageStatus(detectedLanguage);
      if (suggestion && !suggestion.supported) {
        setReadingState('error', { message: getUnsupportedLanguageMessage(suggestion.code) });
        return;
      }
      if (suggestion?.supported) {
        state.selectedLanguageCode = normalizeLanguageCode(detectedLanguage.code);
        setLanguageSelectValue(state.selectedLanguageCode);
        await populateVoices();
        if (stopIfRequested()) return;
      }
      await renderLanguageStatus(detectedLanguage);

      let selectedVoice = resolveSelectedVoice();
      let currentVoiceId = selectedVoice?.id || null;
      if (!selectedVoice) {
        setReadingState('error', { message: getUnsupportedLanguageMessage(state.selectedLanguageCode) });
        return;
      }
      if (['kokoro', 'omnivoice'].includes(selectedVoice.engine) && !state.testSilentTtsEnabled) {
        try {
          await ensureModel({ signal: runSignal, warmupVoice: selectedVoice.id || getSelectedVoiceId(), backendPlan: ttsBackendPlan,
            warmupText: getActiveTtsProfileConfig().progressiveSegments ? null : getChunkSpeechText(state.activeChunks[state.currentChunk]),
          });
          if (stopIfRequested()) return;
        } catch (error) {
          throw error;
        }
      }

      const speechPreloads = new Map();
      const speechPreloadState = {};
      const queuedHighlightIndices = new Set();
      state.ttsSectionReadyTransitionTracker = createSectionReadyTransitionTracker({
        onTransition: recordTtsProbeSectionTransition,
      });
      state.activeSpeechPreloadCleanup = () => clearSpeechPreloadState({
        speechPreloads,
        queuedHighlightIndices,
        preloadState: speechPreloadState,
      });

      if (prepareIncomingVoice && !state.testSilentTtsEnabled) {
        engineHandoff = createSpeechEngineHandoff({
          prepareModel: prepareIncomingVoice,
          createPreload: createSpeechPreloadForVoice,
          readPreload: readPreloadedSpeech,
          getCurrentIndex: () => state.activeReadingCursor?.current() ?? state.currentChunk,
          getChunk: index => state.activeChunks[index],
          // Text belongs to the read: cancelling a voice must not discard a pulled chunk.
          prepareChunks: index => readOrchestrator.fillChunkBuffer(index, { runId: readRunId, signal: runSignal }),
          record: event => flowRecorder.record(event),
          onError(error, voice) {
            suppressError(error);
            if (voice) restoreVoiceSelection(selectedVoice, error);
          },
        });
        const requestSwitch = () => {
          const requested = resolveSelectedVoice();
          if (requested && requested.engine !== selectedVoice.engine) engineHandoff.request(requested);
          else void engineHandoff.cancel();
        };
        unsubscribeVoiceSelection = subscribeVoiceSelection(requestSwitch);
        runSignal?.addEventListener('abort', () => { void engineHandoff.dispose(); }, { once: true });
      }

      async function syncActiveVoice() {
        const latestVoice = resolveSelectedVoice() || selectedVoice;
        if (engineHandoff && latestVoice.engine !== selectedVoice.engine) {
          engineHandoff.request(latestVoice);
          const incoming = engineHandoff.take(state.activeReadingCursor.current());
          if (!incoming) return selectedVoice;
          clearSpeechPreloadState({ speechPreloads, queuedHighlightIndices, preloadState: speechPreloadState });
          selectedVoice = incoming.voice; currentVoiceId = selectedVoice.id;
          for (const [index, preload] of incoming.preloads) speechPreloads.set(index, preload);
          engineHandoff.retire(activateIncomingVoice(incoming.model));
          return selectedVoice;
        }
        if (engineHandoff) void engineHandoff.cancel();
        if (latestVoice && (latestVoice.id !== currentVoiceId || latestVoice.engine !== selectedVoice?.engine)) {
          selectedVoice = latestVoice;
          currentVoiceId = latestVoice.id;
          clearSpeechPreloadState({
            speechPreloads,
            queuedHighlightIndices,
            preloadState: speechPreloadState,
            preserveVoiceId: selectedVoice.id,
            preserveEngine: selectedVoice.engine,
          });
          if (['kokoro', 'omnivoice'].includes(selectedVoice.engine) && !state.testSilentTtsEnabled) {
            await ensureModel({ signal: runSignal, warmupVoice: selectedVoice.id || getSelectedVoiceId(), backendPlan: ttsBackendPlan });
          }
        }
        return selectedVoice;
      }

      while (state.activeReadingCursor.current() < (isStreaming ? Number.MAX_SAFE_INTEGER : state.activeChunks.length)) {
        if (stopIfRequested()) break;

        await syncActiveVoice();
        if (stopIfRequested()) break;

        const index = state.activeReadingCursor.current();
        await waitBetweenSections(index, state.activeChunks.length, { signal: runSignal });
        if (stopIfRequested()) break;
        const profileBeforeCurrentSpeech = getActiveTtsProfileConfig();
        const initialMinimumAhead = getProfileMinimumAhead(profileBeforeCurrentSpeech);
        await readOrchestrator.fillChunkBuffer(index + Math.max(initialMinimumAhead, profileBeforeCurrentSpeech.preloadAhead), {
          runId: readRunId,
          signal: runSignal,
        });
        if (stopIfRequested()) break;
        if (index >= state.activeChunks.length) break;

        setReadingState('reading', { currentChunk: index, totalChunks: readOrchestrator.getPlaybackTotal(index) });
        await waitForReadPause({ signal: runSignal });
        if (stopIfRequested()) break;
        await syncActiveVoice();
        if (stopIfRequested()) break;

        let speech = null;
        if (['kokoro', 'omnivoice'].includes(selectedVoice.engine)) {
          const currentPreload = ensureSpeechPreloadWindow({
            speechPreloads,
            queuedHighlightIndices,
            currentIndex: index,
            selectedVoice,
            syncPageHighlights,
            tabId: article.tabId,
            minimumAhead: initialMinimumAhead,
            preloadState: speechPreloadState,
            signal: runSignal,
            runId: readRunId,
          });
          try {
            const readyTimeoutMs = getSpeechPreloadTimeoutMs(profileBeforeCurrentSpeech);
            speech = await readPreloadedSpeech(currentPreload, {
              signal: runSignal,
              ...(readyTimeoutMs === null ? {} : { readyTimeoutMs }),
            });
            if (stopIfRequested()) break;
          } catch (error) {
            if (isAbortError(error) && stopIfRequested()) break;
            flowRecorder.record({
              kind: 'synthesis_failed',
              chunkIndex: index,
              speechText: getChunkSpeechText(state.activeChunks[index]),
            });
            throw error;
          }
        }

        if (stopIfRequested()) break;

        const profileBeforePlayback = getActiveTtsProfileConfig();
        const playbackMinimumAhead = getProfileMinimumAhead(profileBeforePlayback);
        await readOrchestrator.fillChunkBuffer(index + Math.max(playbackMinimumAhead, profileBeforePlayback.preloadAhead), {
          runId: readRunId,
          signal: runSignal,
        });
        if (stopIfRequested()) break;
        ensureSpeechPreloadWindow({
          speechPreloads,
          queuedHighlightIndices,
          currentIndex: index,
          selectedVoice,
          syncPageHighlights,
          tabId: article.tabId,
          minimumAhead: playbackMinimumAhead,
          preloadState: speechPreloadState,
          signal: runSignal,
          runId: readRunId,
        });
        let refreshedSpeechPreloadsForAudioStart = false;
        const refreshSpeechPreloadsForPlaybackStart = () => {
          recordFirstAudible();
          if (refreshedSpeechPreloadsForAudioStart) return;
          refreshedSpeechPreloadsForAudioStart = true;
          const activeVoice = engineHandoff ? selectedVoice : resolveSelectedVoice() || selectedVoice;
          const profileAtAudioStart = getActiveTtsProfileConfig();
          const audioStartMinimumAhead = getProfileMinimumAhead(profileAtAudioStart);
          ensureSpeechPreloadWindow({
            speechPreloads,
            queuedHighlightIndices,
            currentIndex: index,
            selectedVoice: activeVoice,
            syncPageHighlights,
            tabId: article.tabId,
            minimumAhead: audioStartMinimumAhead,
            preloadState: speechPreloadState,
            signal: runSignal,
            runId: readRunId,
          });
          if (!isStreaming) return;
          const audioStartAhead = Math.max(audioStartMinimumAhead, profileAtAudioStart.preloadAhead) + 1;
          void readOrchestrator.fillChunkBuffer(index + audioStartAhead, {
            runId: readRunId,
            signal: runSignal,
          }).then((loaded) => {
            if (!loaded || isReadRunStopped(readRunId, runSignal)) return;
            ensureSpeechPreloadWindow({
              speechPreloads,
              queuedHighlightIndices,
              currentIndex: index,
              selectedVoice: engineHandoff ? selectedVoice : resolveSelectedVoice() || activeVoice,
              syncPageHighlights,
              tabId: article.tabId,
              minimumAhead: audioStartAhead,
              preloadState: speechPreloadState,
              signal: runSignal,
              runId: readRunId,
            });
          }).catch(suppressError);
        };
        const waitForNextSpeechPreload = async () => {
          const activeVoice = engineHandoff ? selectedVoice : resolveSelectedVoice() || selectedVoice;
          if (!['kokoro', 'omnivoice'].includes(activeVoice?.engine)) return { ok: true };
          if (index + 1 >= state.activeChunks.length) return { ok: true };
          if (['kokoro', 'omnivoice'].includes(activeVoice.engine) && !state.testSilentTtsEnabled && activeVoice.id !== currentVoiceId) {
            await ensureModel({ signal: runSignal, warmupVoice: activeVoice.id || getSelectedVoiceId(), backendPlan: ttsBackendPlan }).catch(suppressError);
          }
          const profileAtHandoff = getActiveTtsProfileConfig();
          ensureSpeechPreloadWindow({
            speechPreloads,
            queuedHighlightIndices,
            currentIndex: index,
            selectedVoice: activeVoice,
            syncPageHighlights,
            tabId: article.tabId,
            minimumAhead: getProfileMinimumAhead(profileAtHandoff),
            preloadState: speechPreloadState,
            signal: runSignal,
            runId: readRunId,
          });
          const result = await waitForSpeechPreloadReady({
            speechPreloads,
            index: index + 1,
            signal: runSignal,
            firstSegmentReadyTimeoutMs: getSpeechPreloadTimeoutMs(profileAtHandoff) ?? undefined,
          });
          if (!result.ok && !runSignal?.aborted) {
            readLoopLogger.warn('Next speech preload was not ready at handoff.', result);
          }
          return result;
        };

        // A short opening heading cannot cover cold synthesis of the first paragraph.
        if (index === startChunk && ['page-title', 'heading'].includes(state.activeChunks[index]?.type)
          && getChunkSpeechText(state.activeChunks[index]).length < profileBeforePlayback.targetMinLength
          && speechPreloads.has(index + 1)) {
          await waitForNextSpeechPreload();
          if (stopIfRequested()) break;
        }

        setCurrentSectionText(getChunkSpeechText(state.activeChunks[index]));
        const highlightOk = syncPageHighlights ? (await highlightChunk(article.tabId, state.activeChunks[index]))?.ok : false;
        if (stopIfRequested()) break;
        await waitForReadPause({ signal: runSignal });
        if (stopIfRequested()) break;
        if (['kokoro', 'omnivoice'].includes(selectedVoice.engine)) {
          try {
            await playKokoroSpeech(speech, state.activeChunks[index], {
              canAdvanceEarly: index + 1 < state.activeChunks.length,
              syncWordHighlights: highlightOk,
              signal: runSignal,
              runId: readRunId,
              sectionIndex: index,
              onAudioStart: refreshSpeechPreloadsForPlaybackStart,
              onBeforeNormalEnd: waitForNextSpeechPreload,
            });
          } catch (audioErr) {
            if (isAbortError(audioErr) && stopIfRequested()) break;
            readLoopLogger.warn(`Audio playback error at chunk ${index}, self-healing audio pipeline:`, audioErr);
            clearCurrentAudioEventListeners();
            resetAudioEventListeners();
            releasePlaybackAudioPool();
            await playKokoroSpeech(speech, state.activeChunks[index], {
              canAdvanceEarly: index + 1 < state.activeChunks.length,
              syncWordHighlights: highlightOk,
              signal: runSignal,
              runId: readRunId,
              sectionIndex: index,
              onAudioStart: refreshSpeechPreloadsForPlaybackStart,
              onBeforeNormalEnd: waitForNextSpeechPreload,
            });
          }
        } else {
          throw new Error('Choose a built-in Kokoro voice to read.');
        }
        if (stopIfRequested()) break;
        const nextIndex = state.activeReadingCursor.completeCurrent();
        compactActivePdfChunkHistory(nextIndex);
        await syncActiveVoice();
        const profileAfterPlayback = getActiveTtsProfileConfig();
        const nextMinimumAhead = getProfileMinimumAhead(profileAfterPlayback);
        await readOrchestrator.fillChunkBuffer(nextIndex + Math.max(nextMinimumAhead, profileAfterPlayback.preloadAhead), {
          runId: readRunId,
          signal: runSignal,
        });
        if (stopIfRequested()) break;
        ensureSpeechPreloadWindow({
          speechPreloads,
          queuedHighlightIndices,
          currentIndex: nextIndex,
          selectedVoice,
          syncPageHighlights,
          tabId: article.tabId,
          minimumAhead: nextMinimumAhead,
          preloadState: speechPreloadState,
          signal: runSignal,
          runId: readRunId,
        });
        if (stopIfRequested()) break;
        await waitForReadPause({ signal: runSignal });
        if (stopIfRequested()) break;
        setReadingState('reading', { currentChunk: nextIndex, totalChunks: readOrchestrator.getPlaybackTotal(nextIndex) });
        if (!isStreaming || supportsStreamingResume(article, isStreaming)) {
          queuePostPlaybackBookkeeping(saveResumeChunk(article, nextIndex, state.activeChunks.length));
        }
        if (stopIfRequested()) break;

      }

      stoppedRun = stopIfRequested();
      if (!stoppedRun && isStreaming) {
        flowRecorder.record({
          kind: 'chunks_extracted',
          totalChunks: state.activeChunks.length,
          startChunk,
          streaming: true,
          final: true,
        });
      }
      if (readRunTracker.isCurrentRun(readRunId)) setReadingState(stoppedRun ? 'stopping' : 'finished');
    } catch (error) {
      if (stopIfRequested()) return;
      readLoopLogger.error('ReaderEngine read loop failed.', error);
      if (readRunTracker.isCurrentRun(readRunId)) {
        readRunTracker.abortCurrentRun?.();
        const readError = /** @type {any} */ (error);
        setReadingState('error', {
          message: readError?.message || 'Something went wrong.',
          errorCode: readError?.code,
        });
      }
    } finally {
      unsubscribeVoiceSelection();
      await engineHandoff?.dispose();
      const shouldReleaseBuffers = stoppedRun || state.releaseReadSessionAfterCleanup || state.readingState === 'finished';
      const shouldResetStateAfterCleanup = stoppedRun || state.releaseReadSessionAfterCleanup;
      let cleanedCurrentRun = false;
      await cleanupReadRun({
        runId: readRunId,
        iterator: runIterator,
        cleanup: () => clearPageHighlight(runTabId),
        isCurrentRun: readRunTracker.isCurrentRun,
        clearCurrentRunState() {
          clearActiveSpeechPreloads();
          clearCurrentAudioEventListeners();
          resetAudioEventListeners();
          releasePlaybackAudioPool();
          state.currentAudio = null;
          state.activeReadTabId = null;
          state.activeReadingCursor = null;
          state.activeSectionPauseDelay = null;
          state.rescheduleCurrentSectionTiming = () => {};
          state.activeChunkIterator = null;
          state.currentAudioWatchdog = null;
          state.ttsSectionReadyTransitionTracker = null;
          if (shouldReleaseBuffers) clearReadSessionBuffers();
          state.releaseReadSessionAfterCleanup = false;
          if (shouldResetStateAfterCleanup) setReadingState('idle', { currentChunk: 0, totalChunks: 0 });
          cleanedCurrentRun = true;
        },
      });
      if (cleanedCurrentRun) {
        await releaseLoadedVoiceModel();
      }
    }
  }

  return {
    readPage,
  };
}

function hasSummaryPreview(article = {}) {
  return Boolean(
    String(article?.text || '').trim()
    || (Array.isArray(article?.chunks) && article.chunks.length > 0)
  );
}

function getSpeechPreloadTimeoutMs(profile = {}) {
  const timeoutMs = Number(profile?.speechPreloadTimeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : null;
}

function getTabContextKey(tab) {
  if (!tab?.id) return '';
  return `${tab.id}:${tab.url || ''}`;
}
