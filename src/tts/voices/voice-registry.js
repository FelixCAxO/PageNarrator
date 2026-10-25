// @ts-check
/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   engine: 'kokoro',
 *   lang: string,
 *   detectCode: string,
 *   gender: string,
 *   quality: string,
 *   kokoroVoiceId: string,
 *   kokoroModelId: string,
 *   kokoroModelUrl: string,
 *   kokoroVoiceUrl: string,
 *   kokoroVoiceDownloadUrl: string,
 *   status: 'on-demand',
 *   autoDownload: boolean,
 *   runtimeReady: boolean,
 *   commercialReady: boolean,
 *   license: string,
 *   licenseUrl: string,
 *   licenseNotes: string,
 *   voiceListUrl: string,
 * }} KokoroVoice
 * @typedef {KokoroVoice} BuiltInVoice
 */
const KOKORO_LICENSE_URL = 'https://huggingface.co/hexgrad/Kokoro-82M';
const KOKORO_VOICES_URL = 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md';
const KOKORO_ONNX_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_ONNX_URL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const VOICE_MODEL_IDLE_RELEASE_DELAY_MS = 60_000;
let defaultVoiceModelLoaderPromise = null;
let runtimeConfigurationPromise = null;

export const KOKORO_NON_CC_VOICE_IDS = Object.freeze([
  'af_heart',
  'af_aoede',
  'af_bella',
  'af_kore',
  'af_nicole',
  'af_sarah',
  'am_fenrir',
  'am_michael',
  'am_puck',
  'bf_emma',
]);

export const VOICES = Object.freeze([
  kokoroVoice({ id: 'af_heart', label: 'Heart - American female', lang: 'en-US', gender: 'female', quality: 'A' }),
  kokoroVoice({ id: 'af_aoede', label: 'Aoede - American female', lang: 'en-US', gender: 'female', quality: 'C+' }),
  kokoroVoice({ id: 'af_bella', label: 'Bella - American female', lang: 'en-US', gender: 'female', quality: 'A-' }),
  kokoroVoice({ id: 'af_kore', label: 'Kore - American female', lang: 'en-US', gender: 'female', quality: 'C+' }),
  kokoroVoice({ id: 'af_nicole', label: 'Nicole - American female', lang: 'en-US', gender: 'female', quality: 'B-' }),
  kokoroVoice({ id: 'af_sarah', label: 'Sarah - American female', lang: 'en-US', gender: 'female', quality: 'C+' }),
  kokoroVoice({ id: 'am_fenrir', label: 'Fenrir - American male', lang: 'en-US', gender: 'male', quality: 'C+' }),
  kokoroVoice({ id: 'am_michael', label: 'Michael - American male', lang: 'en-US', gender: 'male', quality: 'C+' }),
  kokoroVoice({ id: 'am_puck', label: 'Puck - American male', lang: 'en-US', gender: 'male', quality: 'C+' }),
  kokoroVoice({ id: 'bf_emma', label: 'Emma - British female', lang: 'en-GB', gender: 'female', quality: 'B-' }),
]);

/** @returns {KokoroVoice} */
function kokoroVoice({ id, label, lang, gender, quality, runtimeReady = true, licenseNotes = null }) {
  const detectCode = normalizeDetectCode(lang);
  return {
    id,
    label,
    engine: 'kokoro',
    lang,
    detectCode,
    gender,
    quality,
    kokoroVoiceId: id,
    kokoroModelId: KOKORO_ONNX_MODEL_ID,
    kokoroModelUrl: KOKORO_ONNX_URL,
    kokoroVoiceUrl: `${KOKORO_ONNX_URL}/resolve/${KOKORO_MODEL_REVISION}/voices/${id}.bin`,
    kokoroVoiceDownloadUrl: `${KOKORO_ONNX_URL}/resolve/${KOKORO_MODEL_REVISION}/voices/${id}.bin`,
    status: 'on-demand',
    autoDownload: false,
    runtimeReady,
    commercialReady: true,
    license: 'Apache-2.0',
    licenseUrl: KOKORO_LICENSE_URL,
    licenseNotes: licenseNotes || 'Apache-2.0 Kokoro model weights; no per-voice CC BY attribution is listed for this voice in VOICES.md. Keep the model-level notices for acknowledged CC BY training sources.',
    voiceListUrl: KOKORO_VOICES_URL,
  };
}

function normalizeDetectCode(lang) {
  const code = String(lang || '').toLowerCase().split('-')[0];
  return code || 'en';
}

const LEGACY_KOKORO_IDS = new Map([
  ['kokoro-af-heart', 'af_heart'],
  ['kokoro-bf-emma', 'bf_emma'],
]);

/** @param {{includeDownloadable?:boolean,includeRuntimeIncomplete?:boolean}} [options] */
export function getVoiceOptions({ includeRuntimeIncomplete = false } = {}) {
  return VOICES.filter((voice) => {
    if (!includeRuntimeIncomplete && voice.runtimeReady === false) return false;
    if (voice.runtimeReady !== false && voice.commercialReady === false) return false;
    return true;
  });
}

export function getVoiceById(id) {
  const normalized = normalizeStoredVoiceId(id);
  return VOICES.find((voice) => voice.id === normalized) || null;
}

export function getDefaultVoiceId() {
  return 'af_heart';
}

export function normalizeStoredVoiceId(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  const normalized = LEGACY_KOKORO_IDS.get(value) || value;
  return getVoiceOptions().some((voice) => voice.id === normalized) ? normalized : null;
}

/**
 * @param {string} detectedCode
 * @param {Set<string>|string[]|{ installedVoiceIds?: Iterable<string> }} [_options]
 */
export function getVoicesForDetectedLanguage(detectedCode, _options = new Set()) {
  // All approved built-in voices are prepared on demand. Keep the selector's
  // category interface without the retired separately installed voice engines.
  const voices = getVoiceOptions();
  return {
    detectedCode,
    installed: /** @type {KokoroVoice[]} */ ([]),
    bundled: voices.filter(voice => voice.detectCode === detectedCode),
    downloadable: /** @type {KokoroVoice[]} */ ([]),
    fallback: voices.filter(voice => voice.detectCode === 'en'),
  };
}

// Compatibility entry point used by the reader controller. Packaged worker code
// needs no third-party runtime globals or downloaded executable configuration.
export function configureOnnxRuntime() {
  runtimeConfigurationPromise ||= import('../kokoro/worker-client.js');
  return runtimeConfigurationPromise;
}

export async function createVoiceModelBackendPlan({
  memorySaver = false,
  navigator = globalThis.navigator,
  webGpuRuntimeAvailable = true,
} = {}) {
  const { selectVoiceModelBackendPlan } = await import('../runtime/backend-policy.js');
  return selectVoiceModelBackendPlan({
    navigator,
    memorySaver,
    webGpuRuntimeAvailable,
  });
}

/**
 * @param {string} modelId
 * @param {{
 *   warmupVoice?: string|null,
 *   cacheStorage?: CacheStorage,
 *   fetcher?: typeof fetch,
 *   signal?: AbortSignal|null,
 * }} [options]
 */
export async function prepareKokoroModelLoad(modelId, {
  warmupVoice = null,
  cacheStorage = globalThis.caches,
  fetcher = globalThis.fetch?.bind(globalThis),
  signal = null,
} = {}) {
  if (modelId !== KOKORO_ONNX_MODEL_ID) throw new Error('Unsupported Kokoro model.');
  const voice = getVoiceById(warmupVoice);
  if (voice?.engine === 'kokoro') await cacheKokoroVoiceStyle(voice, { cacheStorage, fetcher, signal });
}

export async function ensureVoiceModel(options = {}) {
  const loader = await getDefaultVoiceModelLoader();
  return loader(options);
}

ensureVoiceModel.releaseVoiceModel = releaseVoiceModel;

export async function releaseVoiceModel() {
  if (!defaultVoiceModelLoaderPromise) return false;
  const loader = await defaultVoiceModelLoaderPromise;
  return loader.releaseVoiceModel();
}

async function getDefaultVoiceModelLoader() {
  defaultVoiceModelLoaderPromise ||= Promise.all([
    import('../kokoro/worker-client.js'),
    import('../../lib/kokoro-multilingual.js'),
    import('../../lib/voice-model.js'),
  ]).then(([{ createKokoroWorkerBackend }, { createPageNarratorKokoroTts }, { createVoiceModelLoader }]) => createVoiceModelLoader({
    navigator: globalThis.navigator,
    prepareModelLoad: ({ modelId, warmupVoice, signal }) => prepareKokoroModelLoad(modelId, { warmupVoice, signal }),
    loadKokoro: async (modelId, options) => createPageNarratorKokoroTts(
      await createKokoroWorkerBackend(modelId, { ...options, phaseCorrection: true }),
      { runtime: globalThis.chrome?.runtime, device: options.device },
    ),
  }));
  return defaultVoiceModelLoaderPromise;
}

// Coalesce preparation only while it is in flight. Every later read verifies the
// pinned bytes again, including same-length corruption or within-session eviction.
const inFlightVoiceStyles = new WeakMap();

/**
 * @param {KokoroVoice|null} voice
 * @param {{ cacheStorage?: CacheStorage, fetcher?: typeof fetch, runtime?: any, signal?: AbortSignal|null }} [options]
 */
export async function cacheKokoroVoiceStyle(voice, {
  cacheStorage = globalThis.caches,
  fetcher = globalThis.fetch?.bind(globalThis),
  signal = null,
} = {}) {
  signal?.throwIfAborted();
  if (!voice?.kokoroVoiceId) return;
  if (!cacheStorage?.open || typeof fetcher !== 'function') throw new Error('Voice downloads need browser storage and a network connection on first use.');
  let pending = inFlightVoiceStyles.get(cacheStorage);
  if (!pending) { pending = new Map(); inFlightVoiceStyles.set(cacheStorage, pending); }
  if (pending.has(voice.id)) return pending.get(voice.id);
  const task = (async () => {
    try {
      const { createKokoroDataLoader } = await import('../kokoro/data-loader.js');
      const load = createKokoroDataLoader({ cacheStorage, fetcher, requireCache: true, signal });
      await load(`voices/${voice.kokoroVoiceId}.bin`);
    } catch (error) {
      signal?.throwIfAborted();
      const failure = new Error(`Could not prepare ${voice.label}. Check your connection and available browser storage, then try again.`, { cause: error });
      failure.code = 'voice_style_download_failed';
      throw failure;
    } finally { pending.delete(voice.id); }
  })();
  pending.set(voice.id, task);
  return task;
}

/** @param {{ onIdle?: Function|null }} [options] */
export function createInFlightActivityTracker({ onIdle = null } = {}) {
  let activeCount = 0;

  function notifyIdle() {
    if (typeof onIdle !== 'function') return;
    void Promise.resolve(onIdle()).catch(() => null);
  }

  function begin() {
    activeCount += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) notifyIdle();
    };
  }

  function isActive() {
    return activeCount > 0;
  }

  function trackPromise(promise) {
    const end = begin();
    return Promise.resolve(promise).finally(end);
  }

  function trackAsyncIterable(iterable) {
    const iterator = iterable?.[Symbol.asyncIterator]?.();
    if (!iterator) return iterable;

    const end = begin();
    return {
      async next(...args) {
        try {
          const result = await iterator.next(...args);
          if (result?.done) end();
          return result;
        } catch (error) {
          end();
          throw error;
        }
      },
      async return(value) {
        try {
          if (typeof iterator.return === 'function') return await iterator.return(value);
          return { done: true, value };
        } finally {
          end();
        }
      },
      async throw(error) {
        try {
          if (typeof iterator.throw === 'function') return await iterator.throw(error);
          throw error;
        } finally {
          end();
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  return {
    get activeCount() {
      return activeCount;
    },
    begin,
    isActive,
    trackAsyncIterable,
    trackPromise,
  };
}

/**
 * @param {{
 *   canRelease?: () => boolean,
 *   idleReleaseEnabled?: () => boolean,
 *   releaseVoiceModel?: () => Promise<unknown>|unknown,
 *   releaseDelayMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [options]
 */
export function createVoiceModelIdleReleaseController({
  canRelease = () => true,
  idleReleaseEnabled = () => true,
  releaseVoiceModel,
  releaseDelayMs = VOICE_MODEL_IDLE_RELEASE_DELAY_MS,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  let releaseTimer = null;

  function cancel() {
    if (releaseTimer === null) return;
    clearTimeoutFn?.(releaseTimer);
    releaseTimer = null;
  }

  function schedule() {
    cancel();
    if (!idleReleaseEnabled()) return;
    if (typeof setTimeoutFn !== 'function' || typeof releaseVoiceModel !== 'function') return;

    let timer = null;
    timer = setTimeoutFn(async () => {
      if (releaseTimer !== timer) return;
      releaseTimer = null;
      clearTimeoutFn?.(timer);
      if (!idleReleaseEnabled()) return;
      if (!canRelease()) {
        schedule();
        return;
      }
      await releaseVoiceModel();
    }, releaseDelayMs);
    releaseTimer = timer;
  }

  async function releaseNow() {
    cancel();
    if (typeof releaseVoiceModel !== 'function') return false;
    return releaseVoiceModel();
  }

  /** @param {{ hidden?: boolean }} [options] */
  function handleVisibilityChange({ hidden } = {}) {
    if (hidden) {
      schedule();
      return;
    }

    cancel();
  }

  return {
    cancel,
    handleVisibilityChange,
    releaseNow,
    schedule,
  };
}
