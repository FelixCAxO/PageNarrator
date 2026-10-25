import { probeWebGpuBackend } from './gpu-calibration.js';
import { selectVoiceModelBackendPlan as selectVoiceModelBackend } from '../tts/runtime/backend-policy.js';
import { createLogger } from './logger.js';
import { KOKORO_MODEL_REVISION } from './voice-registry.js';
import { withAbortSignal } from './abort-signal.js';

const voiceModelLogger = createLogger('voice-model');

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const MODEL_REVISION = KOKORO_MODEL_REVISION;
// Cold GPU shader compilation can exceed the governor's 20-second slow-load threshold.
export const VOICE_MODEL_WARMUP_TIMEOUT_MS = 60_000;
const VOICE_MODEL_STEP_ERROR_CODES = Object.freeze({
  prepare: 'voice_model_prepare_failed',
  backendPlan: 'voice_model_backend_plan_failed',
  load: 'voice_model_load_failed',
  warmup: 'voice_model_warmup_failed',
});

export function createVoiceModelLoader({
  navigator,
  loadKokoro,
  modelId = MODEL_ID,
  webGpuRuntimeAvailable = true,
  probeWebGpu = probeWebGpuBackend,
  prepareModelLoad = null,
  warmupTimeoutMs = VOICE_MODEL_WARMUP_TIMEOUT_MS,
} = {}) {
  let cachedModel = null;
  let inFlightModel = null;
  let inFlightSignal = null;
  let inFlightRelease = null;
  let releaseAfterInFlightLoad = false;

  async function ensureVoiceModel({
    onStart,
    onProgress,
    onReady,
    onFallback,
    onError,
    memorySaver = false,
    warmupVoice = null,
    warmupText = null,
    webGpuRuntimeAvailable: loadWebGpuRuntimeAvailable = webGpuRuntimeAvailable,
    backendPlan = null,
    signal = null,
  } = {}) {
    signal?.throwIfAborted();
    if (inFlightModel && inFlightSignal?.aborted) await withAbortSignal(inFlightModel.catch(() => null), signal);
    if (inFlightRelease) await inFlightRelease;
    if (inFlightModel && releaseAfterInFlightLoad) {
      try {
        await inFlightModel;
      } catch (error) {
        if (error?.code !== 'voice_model_released') throw error;
      }
    }
    if (cachedModel) {
      return warmupReusableModel(cachedModel, { warmupVoice, onError });
    }
    if (inFlightModel) {
      const model = await inFlightModel;
      return warmupReusableModel(model, { warmupVoice, onError });
    }

    releaseAfterInFlightLoad = false;
    inFlightSignal = signal;
    inFlightModel = loadModel().then(async (model) => {
      if (releaseAfterInFlightLoad || signal?.aborted) {
        if (cachedModel === model) cachedModel = null;
        await disposeVoiceModel(model);
        signal?.throwIfAborted();
        throw createVoiceModelReleasedError();
      }
      return model;
    }).finally(() => {
      inFlightModel = null;
      inFlightSignal = null;
      releaseAfterInFlightLoad = false;
    });
    return inFlightModel;

    async function loadModel() {
      void startModelPreparation({
        prepareModelLoad,
        modelId,
        navigator,
        memorySaver,
        warmupVoice,
        webGpuRuntimeAvailable: loadWebGpuRuntimeAvailable,
        progress_callback: onProgress,
        onError,
        signal,
      });

      let initialPlan;
      try {
        initialPlan = await withVoiceModelLoadStep('backendPlan', () => withAbortSignal(getInitialBackendPlan({
          navigator,
          memorySaver,
          webGpuRuntimeAvailable: loadWebGpuRuntimeAvailable,
          probeWebGpu,
        }, backendPlan), signal));
      } catch (error) {
        onError?.(error);
        throw error;
      }
      onStart?.(initialPlan);

      try {
        cachedModel = await loadAndWarmDevice(initialPlan, { warmupVoice });
        if (!releaseAfterInFlightLoad) onReady?.();
        return cachedModel;
      } catch (error) {
        signal?.throwIfAborted();
        if (releaseAfterInFlightLoad) throw createVoiceModelReleasedError();
        if (initialPlan.device === 'webgpu' && !isVoiceStyleDownloadFailure(error)) {
          const fallbackPlan = {
            device: 'wasm',
            dtype: 'q8',
            reason: 'webgpu-load-fallback',
            cpuBudgetTarget: true,
          };
          onFallback?.(error, fallbackPlan);
          try {
            cachedModel = await loadAndWarmDevice(fallbackPlan, { warmupVoice });
            if (!releaseAfterInFlightLoad) onReady?.();
            return cachedModel;
          } catch (fallbackError) {
            onError?.(fallbackError);
            throw fallbackError;
          }
        }

        onError?.(error);
        throw error;
      }
    }

    async function loadDevice(plan) {
      return withVoiceModelLoadStep('load', () => loadKokoro(modelId, {
        dtype: plan.dtype,
        device: plan.device,
        progress_callback: onProgress,
        signal,
      }));
    }

    async function loadAndWarmDevice(plan, { warmupVoice: voice } = {}) {
      const model = await loadDevice(plan);
      try {
        if (plan.device === 'webgpu') {
          // A WebGPU warmup failure should fall back to WASM, so keep it fatal here.
          await withVoiceModelLoadStep('warmup', () => warmupLoadedModel(model, { voice, speechText: warmupText, timeoutMs: warmupTimeoutMs, signal }));
        } else {
          // WASM is the last resort. Keep slow operator warmup best-effort;
          // missing required voice data still prevents synthesis.
          await warmupLoadedModelBestEffort(model, { voice, timeoutMs: warmupTimeoutMs, signal });
        }
        return model;
      } catch (error) {
        await disposeVoiceModel(model);
        throw error;
      }
    }

    async function warmupReusableModel(model, { warmupVoice: voice } = {}) {
      // A reused model already loaded and synthesized before; never throw it away
      // over a warmup hiccup.
      await warmupLoadedModelBestEffort(model, { voice, timeoutMs: warmupTimeoutMs, signal });
      if (cachedModel !== model) throw createVoiceModelReleasedError();
      return model;
    }
  }

  ensureVoiceModel.releaseVoiceModel = async function releaseVoiceModel() {
    if (inFlightRelease) return inFlightRelease;
    if (inFlightModel) {
      releaseAfterInFlightLoad = true;
      return true;
    }
    if (!cachedModel) return false;

    const model = cachedModel;
    cachedModel = null;
    inFlightRelease = disposeVoiceModel(model).then(() => true).finally(() => {
      inFlightRelease = null;
    });
    return inFlightRelease;
  };

  return ensureVoiceModel;
}

function createVoiceModelReleasedError() {
  const error = new Error('Voice model was released before it became available.');
  error.code = 'voice_model_released';
  return error;
}

async function getInitialBackendPlan({
  navigator,
  memorySaver,
  webGpuRuntimeAvailable,
  probeWebGpu,
}, backendPlan) {
  const suppliedPlan = backendPlan ? await backendPlan : null;
  if (suppliedPlan?.device && suppliedPlan?.dtype) return suppliedPlan;

  return selectVoiceModelBackend({
    navigator,
    memorySaver,
    webGpuRuntimeAvailable,
    probeWebGpu,
  });
}

function startModelPreparation({
  prepareModelLoad,
  modelId,
  navigator,
  memorySaver,
  warmupVoice,
  webGpuRuntimeAvailable,
  progress_callback,
  onError,
  signal,
} = {}) {
  if (typeof prepareModelLoad !== 'function') return null;

  try {
    const preparation = Promise.resolve(prepareModelLoad({
      modelId,
      navigator,
      memorySaver,
      warmupVoice,
      webGpuRuntimeAvailable,
      progress_callback,
      signal,
    }));
    void preparation.catch((error) => onError?.(tagVoiceModelLoadError(error, 'prepare')));
    return preparation;
  } catch (error) {
    onError?.(tagVoiceModelLoadError(error, 'prepare'));
    return null;
  }
}

async function warmupLoadedModel(model, { voice = null, speechText = null, timeoutMs = VOICE_MODEL_WARMUP_TIMEOUT_MS, signal = null } = {}) {
  signal?.throwIfAborted();
  if (!voice || typeof model?.warmup !== 'function') return null;
  return withVoiceModelWarmupTimeout(withAbortSignal(model.warmup({ voice, ...(signal ? { signal } : {}), ...(speechText ? { speechText } : {}) }), signal), timeoutMs);
}

async function warmupLoadedModelBestEffort(model, { voice = null, timeoutMs = VOICE_MODEL_WARMUP_TIMEOUT_MS, signal = null } = {}) {
  try {
    await warmupLoadedModel(model, { voice, timeoutMs, signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    // Missing style data prevents synthesis; only optional inference warmup may
    // fail without turning a successful download into a setup failure.
    if (isVoiceStyleDownloadFailure(error)) throw tagVoiceModelLoadError(error, 'load');
    tagVoiceModelLoadError(error, 'warmup');
    voiceModelLogger.warn('Kokoro warmup did not finish; continuing with the loaded model.', error);
  }
}

function isVoiceStyleDownloadFailure(error) {
  // Preparation and warmup may observe the same rejection after its step was tagged.
  return error?.code === 'voice_style_download_failed' || error?.originalCode === 'voice_style_download_failed';
}

async function withVoiceModelLoadStep(step, task) {
  try {
    return await task();
  } catch (error) {
    throw tagVoiceModelLoadError(error, step);
  }
}

function tagVoiceModelLoadError(error, step) {
  if (error?.name === 'AbortError') return error;
  const target = error instanceof Error ? error : new Error(String(error || 'Voice model loading failed.'));
  const stepCode = VOICE_MODEL_STEP_ERROR_CODES[step] || 'voice_model_load_failed';
  if (target.code && target.code !== stepCode && !target.originalCode) target.originalCode = target.code;
  target.code = stepCode;
  target.voiceLoadStep = step;
  return target;
}

function withVoiceModelWarmupTimeout(promise, timeoutMs = VOICE_MODEL_WARMUP_TIMEOUT_MS) {
  const safeTimeoutMs = normalizePositiveTimeoutMs(timeoutMs);
  if (!safeTimeoutMs || typeof setTimeout !== 'function') return Promise.resolve(promise);

  let timeoutId = null;
  const source = Promise.resolve(promise);
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createVoiceModelWarmupTimeoutError(safeTimeoutMs));
    }, safeTimeoutMs);
  });

  return Promise.race([source, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function normalizePositiveTimeoutMs(timeoutMs) {
  const numeric = Number(timeoutMs);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function createVoiceModelWarmupTimeoutError(timeoutMs) {
  const error = new Error(`Voice model warmup did not finish within ${timeoutMs} ms.`);
  error.code = 'voice_model_warmup_timeout';
  error.timeoutMs = timeoutMs;
  return error;
}

async function disposeVoiceModel(model) {
  await callDisposer(model);

  const nestedModel = model?.model;
  const nestedModelDisposed = await callDisposer(nestedModel);
  if (!nestedModelDisposed) {
    await disposeSessions(nestedModel?.sessions);
  }
  await callDisposer(nestedModel?.worker);
  await callDisposer(model?.worker);

  await callDisposer(model?.tokenizer);
}

async function disposeSessions(sessions) {
  if (!sessions || typeof sessions !== 'object') return;

  for (const session of getSessionValues(sessions)) {
    if (await callDisposer(session)) continue;
    if (await callDisposer(session?.handler)) continue;
    await callDisposer(session?.session);
  }
}

function getSessionValues(sessions) {
  if (typeof sessions.values === 'function') return sessions.values();
  if (typeof sessions[Symbol.iterator] === 'function') return sessions;
  return Object.values(sessions);
}

async function callDisposer(target) {
  if (!target || typeof target !== 'object') return false;

  for (const methodName of ['dispose', 'destroy', 'release', 'free', 'terminate']) {
    const method = target[methodName];
    if (typeof method === 'function') {
      await method.call(target);
      return true;
    }
  }

  return false;
}
