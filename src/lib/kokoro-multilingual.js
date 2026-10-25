import { cacheKokoroVoiceStyle, getVoiceById } from './voice-registry.js';
import { splitSpeechSentences } from './speech-chunks.js';
import { createLogger, createSuppressedErrorHandler } from './logger.js';

export const MAX_WARMUP_CACHE = 5;
const suppressKokoroError = createSuppressedErrorHandler(createLogger('kokoro'), 'Best-effort Kokoro operation failed.');

export function createPageNarratorKokoroTts(baseTts, { runtime = globalThis.chrome?.runtime, device = 'webgpu' } = {}) {
  const warmups = new Map();
  const { runInference, retire } = createKokoroInferenceScheduler();
  let disposePromise = null;
  let warmupSpeech = null;
  const prepare = (voice, signal = null) => typeof baseTts?.prepareVoice === 'function'
    ? baseTts.prepareVoice(voice, ...(signal ? [{ signal }] : [])) : ensureKokoroVoiceStyle(voice, { runtime, signal });
  function takeWarmupSpeech(text, voice, speed) {
    const prepared = warmupSpeech;
    warmupSpeech = null;
    return prepared?.text === text && prepared.voice === voice && prepared.speed === speed ? prepared.audio : null;
  }

  return {
    capabilities: { id: 'kokoro', local: true, streaming: true, wordTimings: true, requiresNetwork: false },
    get model() { return baseTts?.model; },
    get tokenizer() { return baseTts?.tokenizer; },
    get modelInfo() { return baseTts?.modelInfo; },
    get voices() { return baseTts?.voices || {}; },
    list_voices: () => baseTts?.list_voices?.(),
    async init() { return this; },
    async synthesizeChunk({ text, voice, signal = null } = {}) {
      return this.generate(text, { voice: voice?.id || voice || 'af_heart', signal });
    },
    async generate(text, { voice = 'af_heart', speed = 1, signal = null } = {}) {
      if (disposePromise) throw createDisposedError();
      if (signal?.aborted) throw createAbortError();
      await prepare(voice, signal);
      if (signal?.aborted) throw createAbortError();
      const prepared = takeWarmupSpeech(text, voice, speed);
      if (prepared) return Object.assign(prepared, { fromWarmup: true });
      return runInference(() => baseTts.generate(text, { voice, speed, ...(signal ? { signal } : {}) }), signal);
    },
    async generate_from_ids(inputIds, options = {}) {
      if (disposePromise) throw createDisposedError();
      if (options.signal?.aborted) throw createAbortError();
      await prepare(options.voice, options.signal);
      return runInference(() => baseTts.generate_from_ids(inputIds, options), options.signal);
    },
    warmup(options = {}) {
      if (disposePromise) return Promise.reject(createDisposedError());
      const voice = String(options.voice || 'af_heart');
      const key = `${voice}|${Number(options.speed) || 1}`;
      if (!warmups.has(key)) {
        warmups.set(key, prepare(voice, options.signal)
          // WASM has no GPU shaders to compile; use the first real utterance instead.
          .then(() => device === 'wasm' ? { warmed: false, voice, reason: 'wasm-no-shader-compilation' }
            : warmupKokoroPipeline(baseTts, { ...options, voice, runInference }))
          .then(({ audio, ...result }) => {
            // Keep only the opening utterance, consumed once by its normal preload.
            if (audio && options.speechText && !disposePromise) warmupSpeech = { text: options.speechText, voice, speed: options.speed ?? 1, audio };
            return result;
          })
          .catch((error) => {
            warmups.delete(key);
            throw error;
          }));
        while (warmups.size > MAX_WARMUP_CACHE) warmups.delete(warmups.keys().next().value);
      }
      return warmups.get(key);
    },
    async *stream(text, { voice = 'af_heart', speed = 1, split_pattern = null, signal = null } = {}) {
      if (disposePromise) throw createDisposedError();
      if (signal?.aborted) throw createAbortError();
      await prepare(voice, signal);
      if (disposePromise) throw createDisposedError();
      const prepared = takeWarmupSpeech(text, voice, speed);
      if (prepared && !split_pattern) {
        if (signal?.aborted) throw createAbortError();
        yield { text, phonemes: prepared.phonemes, audio: prepared, fromWarmup: true };
        return;
      }
      if (typeof baseTts.stream === 'function') {
        const iterator = baseTts.stream(text, { voice, speed, split_pattern, ...(signal ? { signal } : {}) })?.[Symbol.asyncIterator]?.();
        if (!iterator) return;
        try {
          while (true) {
            const result = await runInference(() => iterator.next(), signal);
            if (result.done) return;
            yield result.value;
          }
        } finally {
          await iterator.return?.();
        }
      }
      for (const segment of splitSpeechSentences(text)) {
        yield { text: segment, audio: await this.generate(segment, { voice, speed, signal }) };
      }
    },
    dispose() {
      if (!disposePromise) {
        warmups.clear();
        warmupSpeech = null;
        // ponytail: retire queued work, then let an active native call settle before teardown.
        const drained = retire();
        baseTts?.abortGeneration?.();
        disposePromise = drained.then(() => typeof baseTts?.dispose === 'function' ? baseTts.dispose() : baseTts?.destroy?.());
      }
      return disposePromise;
    },
  };
}

function createKokoroInferenceScheduler() {
  let queue = Promise.resolve();
  let retired = false;
  function runInference(task, signal = null) {
    if (retired) return Promise.reject(createDisposedError());
    const job = queue.catch(suppressKokoroError).then(() => {
      if (retired) throw createDisposedError();
      if (signal?.aborted) throw createAbortError();
      return task();
    });
    queue = job.catch(suppressKokoroError);
    return job;
  }
  return { runInference, retire() { retired = true; return queue; } };
}

function createDisposedError() {
  return new Error('Kokoro model has been disposed.');
}

async function ensureKokoroVoiceStyle(voice, { runtime, signal = null } = {}) {
  const selectedVoice = typeof voice === 'string' ? getVoiceById(voice) : voice;
  if (selectedVoice?.engine === 'kokoro') await cacheKokoroVoiceStyle(selectedVoice, { runtime, signal });
}

export async function warmupKokoroPipeline(baseTts, {
  voice = 'af_heart',
  text = 'a',
  speechText = null,
  speed = 1,
  signal = null,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  runInference = (task) => task(),
} = {}) {
  if (typeof baseTts?.generateWarmup !== 'function' && (!baseTts?.tokenizer || typeof baseTts.generate_from_ids !== 'function')) {
    return { warmed: false, voice, reason: 'missing-generate-from-ids' };
  }
  const startedAtMs = Number(now());
  const audio = await runInference(() => typeof baseTts.generateWarmup === 'function'
    ? baseTts.generateWarmup({ text, speechText, voice, speed, ...(signal ? { signal } : {}) }) : speechText
    ? baseTts.generate(speechText, { voice, speed, ...(signal ? { signal } : {}) })
    : baseTts.generate_from_ids(baseTts.tokenizer(text, { truncation: true }).input_ids, { voice, speed, ...(signal ? { signal } : {}) }), signal);
  const sampleRate = Number(audio?.sampling_rate ?? audio?.sampleRate ?? audio?.samplingRate);
  const samples = audio?.audio ?? audio?.data ?? audio?.waveform ?? audio;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !samples?.length || !samples.every(Number.isFinite)) {
    throw new Error('Kokoro warmup produced empty or non-finite audio.');
  }
  return {
    warmed: true,
    voice,
    synthesisMs: Math.max(0, Number(now()) - startedAtMs),
    audioDurationSeconds: samples.length / sampleRate,
    ...(speechText ? { audio } : {}),
  };
}

function createAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Kokoro synthesis was aborted.', 'AbortError');
  const error = new Error('Kokoro synthesis was aborted.');
  error.name = 'AbortError';
  return error;
}
