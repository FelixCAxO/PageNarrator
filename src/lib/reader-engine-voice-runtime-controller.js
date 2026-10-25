import { shouldCleanupReadOnPanelHide as defaultShouldCleanupReadOnPanelHide } from './reader-engine-read-lifecycle.js';
import { getModelDownloadProgress, renderModelSetupElements } from './reader-engine-view.js';
import { withAbortSignal } from './abort-signal.js';
import {
  createInFlightActivityTracker as defaultCreateInFlightActivityTracker,
  createVoiceModelIdleReleaseController as defaultCreateVoiceModelIdleReleaseController,
} from './voice-registry.js';

const defaultLoadVoiceRegistry = () => import('./voice-registry.js');

/** @param {any} [deps] */
export function createReaderEngineVoiceRuntimeController({
  els = {},
  state = {},
  ttsService,
  documentRef = globalThis.document,
  voiceRegistry = null,
  loadVoiceRegistry = defaultLoadVoiceRegistry,
  createInFlightActivityTracker = defaultCreateInFlightActivityTracker,
  createVoiceModelIdleReleaseController = defaultCreateVoiceModelIdleReleaseController,
  shouldCleanupReadOnPanelHide = defaultShouldCleanupReadOnPanelHide,
  shouldForceWasmVoiceModel = () => false,
  resolveSelectedVoice = () => null,
  loadOmniVoice = () => import('../tts/omnivoice/tts.js'),
  getNowMs = () => Date.now(),
  render = {},
  logger = console,
} = {}) {
  const downloads = new Map();
  let loadedVoiceRegistry = voiceRegistry;
  /** @type {Promise<boolean>|null} */
  let releasingModel = null;
  const activeVoiceSynthesisTracker = createInFlightActivityTracker();
  const voiceModelReleaseController = createVoiceModelIdleReleaseController({
    canRelease: canReleaseLoadedVoiceModel,
    idleReleaseEnabled: () => state.idleReleaseEnabled !== false,
    releaseVoiceModel: releaseLoadedVoiceModel,
  });

  /** @param {any} [options] */
  async function ensureModel({ warmupVoice = null, warmupText = null, backendPlan = null, signal = null } = {}) {
    signal?.throwIfAborted();
    // The old sessions must finish disposal before allocating another model.
    await withAbortSignal(releasingModel, signal);
    const engine = resolveSelectedVoice()?.engine || 'kokoro';
    if (state.tts && (state.tts.capabilities?.id || 'kokoro') !== engine
      && ['reading', 'paused'].includes(state.readingState)) return state.tts;
    if (state.tts && (state.tts.capabilities?.id || 'kokoro') !== engine) await releaseLoadedVoiceModel({ force: true });
    if (state.tts) {
      // A reload after bad audio can fail; release it so the next read starts a fresh model.
      if (engine === 'omnivoice') await state.tts.init({ signal }).catch(async error => { await releaseLoadedVoiceModel({ force: true }); throw error; });
      const warmup = warmupVoice ? state.tts.warmup?.({ voice: warmupVoice, signal }) : null;
      if (warmup) await withAbortSignal(trackActiveVoiceSynthesisPromise(warmup), signal);
      return state.tts;
    }

    voiceModelReleaseController.cancel?.();
    if (engine === 'omnivoice') {
      beginModelSetup(true);
      const { createOmniVoiceTts } = await withAbortSignal(loadOmniVoice(), signal);
      if (state.tts?.capabilities?.id === 'omnivoice') {
        await state.tts.init({ signal });
        return state.tts;
      }
      const model = createOmniVoiceTts({ onProgress: progress => { if (!signal?.aborted) handleModelProgress(progress); } });
      state.tts = model;
      try {
        await model.init({ signal });
        signal?.throwIfAborted();
        const plan = { device: 'webgpu', dtype: 'fp16', reason: 'omnivoice' };
        render.renderBackendStatus?.(plan);
        render.recordBackendPlan?.(plan);
        completeModelSetup();
        return model;
      } catch (error) {
        if (state.tts === model) state.tts = null;
        await model.dispose().catch(error => logger.warn?.('OmniVoice cleanup failed.', error));
        if (signal?.aborted) renderSetupState({ phase: 'idle' });
        else failModelSetup(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    const registry = await withAbortSignal(getVoiceRegistry(), signal);
    await withAbortSignal(registry.configureOnnxRuntime(), signal);
    const runtimeDecision = await withAbortSignal(backendPlan
      ? ttsService.getRuntimeDiagnostics?.() || prepareRuntime()
      : prepareRuntime(), signal);
    const selectedBackendPlan = backendPlan || runtimeDecision.backendPlan;
    const modelLoadStartedAt = getNowMs();
    state.tts = await withAbortSignal(registry.ensureVoiceModel({
      memorySaver: false,
      warmupVoice,
      warmupText,
      signal,
      webGpuRuntimeAvailable: runtimeDecision.preferredBackend === 'webgpu',
      backendPlan: selectedBackendPlan,
      onStart(event) {
        if (signal?.aborted) return;
        render.renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordBackendPlan?.(event));
        render.renderBackendStatus?.(event);
        render.recordBackendPlan?.(event);
        beginModelSetup(event?.device === 'webgpu');
      },
      onProgress: progress => { if (!signal?.aborted) handleModelProgress(progress); },
      onFallback(error, fallbackPlan) {
        if (signal?.aborted) return;
        render.renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordBackendPlan?.(fallbackPlan));
        render.renderBackendStatus?.(fallbackPlan);
        render.recordModelFallback?.(error, fallbackPlan);
        logger.warn?.('WebGPU setup failed; retrying with WASM.', error);
        setModelProgress(8, 'GPU setup failed. Retrying with CPU/WebAssembly...');
      },
      onReady: () => { if (!signal?.aborted) completeModelSetup(); },
      onError(error) {
        if (signal?.aborted) return;
        if (error?.voiceLoadStep === 'prepare') {
          logger.warn?.('Best-effort voice preparation failed.', error);
          return;
        }
        failModelSetup(error?.message);
      },
    }), signal).catch(error => {
      if (signal?.aborted) renderSetupState({ phase: 'idle' });
      throw error;
    });
    const loadMs = getNowMs() - modelLoadStartedAt;
    render.renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordModelLoad?.({ loadMs }));
    render.recordModelLoad?.({ loadMs });
    return state.tts;
  }

  async function prepareTtsBackendPlanForChunking({ signal = null } = {}) {
    const selectedVoice = resolveSelectedVoice();
    if (selectedVoice?.engine !== 'kokoro') return undefined;
    const runtimeDecision = await withAbortSignal(prepareRuntime(), signal);
    const backendPlan = runtimeDecision.backendPlan;
    render.renderGovernorDecision?.(state.ttsPerformanceGovernor?.recordBackendPlan?.(backendPlan));
    render.renderBackendStatus?.(backendPlan);
    render.recordBackendPlan?.(backendPlan);
    return backendPlan;
  }

  /** @param {any} voice @param {{signal?: AbortSignal|null}} [options] */
  async function prepareIncomingVoice(voice, { signal = null } = {}) {
    const checkAbort = () => { if (signal?.aborted) throw new DOMException('Voice preparation stopped.', 'AbortError'); };
    checkAbort();
    if (voice.engine === 'omnivoice') {
      const { createOmniVoiceTts } = await loadOmniVoice();
      const model = createOmniVoiceTts({ onProgress: progress => { if (!signal?.aborted) handleModelProgress(progress); } });
      const abort = () => { void model.dispose().catch(error => logger.warn?.('Incoming voice cleanup failed.', error)); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { await model.init({ signal }); }
      catch (error) { await model.dispose(); throw error; }
      finally { signal?.removeEventListener('abort', abort); }
      checkAbort();
      return { tts: model, dispose: () => model.dispose() };
    }
    const registry = await getVoiceRegistry();
    await registry.configureOnnxRuntime();
    const decision = await prepareRuntime();
    checkAbort();
    const abort = () => { void registry.releaseVoiceModel().catch(error => logger.warn?.('Incoming voice cleanup failed.', error)); };
    signal?.addEventListener('abort', abort, { once: true });
    let model;
    try {
      model = await registry.ensureVoiceModel({ memorySaver: false, warmupVoice: voice.id,
        signal,
        webGpuRuntimeAvailable: decision.preferredBackend === 'webgpu', backendPlan: decision.backendPlan,
        onProgress: progress => { if (!signal?.aborted) handleModelProgress(progress); } });
    } finally { signal?.removeEventListener('abort', abort); }
    if (signal?.aborted) { await registry.releaseVoiceModel(); checkAbort(); }
    return { tts: model, dispose: () => registry.releaseVoiceModel() };
  }

  function activateIncomingVoice(incoming) {
    const previous = state.tts;
    state.tts = incoming.tts;
    completeModelSetup();
    return (previous?.capabilities?.id === 'omnivoice' ? previous.dispose()
      : previous ? getVoiceRegistry().then(registry => registry.releaseVoiceModel()) : Promise.resolve())
      .catch(error => logger.warn?.('Outgoing voice cleanup failed.', error));
  }

  async function releaseLoadedVoiceModel({ force = false } = {}) {
    if (releasingModel) return releasingModel;
    if (!force && !canReleaseLoadedVoiceModel()) return false;
    const loadedModel = state.tts;
    state.tts = null;
    releasingModel = (async () => {
      try {
        let released = false;
        if (loadedModel?.capabilities?.id === 'omnivoice') {
          await loadedModel.dispose();
          released = true;
        } else if (loadedModel) released = Boolean(await (await getVoiceRegistry()).releaseVoiceModel()) || released;
        return released;
      } catch (error) {
        // Disposal may already have freed some sessions; a failed release is not
        // evidence that the old model can safely synthesize again.
        logger.warn?.('Voice model release failed.', error);
        return false;
      }
    })().finally(() => { releasingModel = null; });
    return releasingModel;
  }

  function canReleaseLoadedVoiceModel() {
    return !shouldCleanupReadOnPanelHide({ state: state.readingState })
      && !state.currentAudio
      && !state.activeSectionPauseDelay
      && !activeVoiceSynthesisTracker.isActive();
  }

  function handleVoiceModelVisibilityChange() {
    voiceModelReleaseController.handleVisibilityChange?.({ hidden: documentRef.hidden });
  }

  function handleModelProgress(progress) {
    const status = progress?.status;
    const file = fileLabel(progress?.file || progress?.name);
    const download = getModelDownloadProgress(progress, downloads);
    if (download) {
      setModelProgress(download.progress, download.detail);
      return;
    }
    if (status === 'progress' && typeof progress.progress === 'number') {
      setModelProgress(Math.max(5, Math.min(98, Math.round(progress.progress * 0.9))), `Downloading ${file}...`);
      return;
    }
    if (status === 'file') setModelProgress(35, `Preparing ${file}...`);
    else if (status === 'ready') completeModelSetup();
    else if (progress?.message) setModelProgress(15, progress.message);
  }
  function trackActiveVoiceSynthesisPromise(promise) {
    return activeVoiceSynthesisTracker.trackPromise(promise);
  }
  function trackActiveVoiceSynthesisSegments(segments) {
    return activeVoiceSynthesisTracker.trackAsyncIterable(segments);
  }
  function scheduleForReadingState(readingState) {
    if (readingState === 'idle' || readingState === 'finished' || readingState === 'error') voiceModelReleaseController.schedule?.();
    else if (readingState === 'preparing' || readingState === 'reading') voiceModelReleaseController.cancel?.();
  }
  function prepareRuntime() {
    return ttsService.prepareRuntime({ memorySaver: false, webGpuRuntimeAvailable: !shouldForceWasmVoiceModel() });
  }
  async function getVoiceRegistry() {
    loadedVoiceRegistry ||= await loadVoiceRegistry();
    return loadedVoiceRegistry;
  }
  function beginModelSetup(useGpu) {
    downloads.clear();
    renderSetupState({
      phase: 'loading',
      progress: 3,
      detail: useGpu ? 'Checking GPU support...' : 'Checking browser cache...',
      eta: 'One-time setup',
    });
  }
  function completeModelSetup() { renderSetupState({ phase: 'ready' }); }
  function failModelSetup(message) {
    renderSetupState({ phase: 'error', detail: message || 'Model setup failed.', eta: 'Try again' });
  }
  function setModelProgress(progress, detail) {
    renderSetupState({ phase: 'loading', progress, detail, eta: 'One-time setup' });
  }
  function renderSetupState(setup) {
    state.modelSetupState = { ...setup };
    renderSetup(state.modelSetupState);
    render.setReadingState?.(state.readingState);
  }
  function renderSetup(setup) {
    render.renderSetup?.(setup);
    renderModelSetupElements(els, setup);
  }
  function fileLabel(file) {
    return file ? String(file).split('/').pop() || 'voice model' : 'voice model';
  }

  return {
    ensureModel,
    prepareIncomingVoice,
    activateIncomingVoice,
    failIncomingVoice: error => failModelSetup(error?.message || 'Could not prepare the requested voice.'),
    prepareTtsBackendPlanForChunking,
    releaseLoadedVoiceModel,
    canReleaseLoadedVoiceModel,
    handleVoiceModelVisibilityChange,
    trackActiveVoiceSynthesisPromise,
    trackActiveVoiceSynthesisSegments,
    handleModelProgress,
    voiceModelReleaseController,
    activeVoiceSynthesisTracker,
    scheduleForReadingState,
    getTts: () => state.tts,
  };
}
