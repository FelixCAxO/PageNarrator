import { createOmniVoiceRequest } from '../../lib/omnivoice-settings.js';
import { createLogger, createSuppressedErrorHandler } from '../../lib/logger.js';

import { createOmniVoiceWorker } from './worker-client.js';
import { assertOmniVoiceAudio } from './audio-quality.js';
import { OMNIVOICE_MODEL_BASE_URL } from './loader.js';
import { withAbortSignal } from '../../lib/abort-signal.js';
export { OMNIVOICE_MODEL_REVISION, OMNIVOICE_MODEL_BASE_URL } from './loader.js';

const logger = createLogger('omnivoice');
const suppressError = createSuppressedErrorHandler(logger, 'OmniVoice cleanup failed.');
/** @param {string} text @param {string} language */
function splitSectionText(text, language) {
  const middle = text.length / 2;
  for (const granularity of /** @type {const} */ (['sentence', 'word', 'grapheme'])) {
    const boundaries = Array.from(new Intl.Segmenter(language, { granularity }).segment(text), part => part.index)
      .filter(index => index >= middle / 2 && index <= middle * 1.5)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    for (const index of boundaries) {
      const parts = [text.slice(0, index).trim(), text.slice(index).trim()];
      if (parts.every(part => part && part.length < text.length)) return parts;
    }
  }
  return null;
}
/** @param {any} [deps] */
export function createOmniVoiceTts({ loadRuntime = createOmniVoiceWorker, onProgress = () => {} } = {}) {
  /** @type {Awaited<ReturnType<typeof createOmniVoiceWorker>>|null} */
  let engine = null;
  /** @type {Promise<object>|null} */
  let initPromise = null;
  /** @type {Promise<any>} */
  let queue = Promise.resolve();
  let retired = false;
  /** @type {Promise<void>|null} */
  let disposal = null;
  let initialized = false;
  async function resetRuntime() {
    const failed = engine;
    engine = null;
    initialized = false;
    failed?.terminate?.();
    await Promise.resolve().then(() => failed?.dispose()).catch(suppressError);
    initPromise = null;
  }
  return {
    capabilities: { id: 'omnivoice', local: true, streaming: false, wordTimings: false, requiresNetwork: false },
    /** @param {{signal?: AbortSignal|null}} [options] */
    init({ signal = null } = {}) {
      if (retired) return Promise.reject(new DOMException('OmniVoice was released.', 'AbortError'));
      initPromise ||= loadRuntime({ onProgress }).then(async runtime => {
        engine = runtime;
        if (retired) throw new DOMException('OmniVoice was released.', 'AbortError');
        await runtime.init(OMNIVOICE_MODEL_BASE_URL);
        if (retired) throw new DOMException('OmniVoice was released.', 'AbortError');
        initialized = true;
        return this;
      }).catch(async error => { await resetRuntime(); throw error; });
      if (!signal) return initPromise;
      const abort = () => { void this.dispose().catch(suppressError); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      return withAbortSignal(initPromise, signal).finally(() => signal?.removeEventListener('abort', abort));
    },
    /** @param {string} text @param {{ voice: any, signal?: AbortSignal|null, onSynthesisProgress?: any }} options */
    generate(text, { voice, signal = null, onSynthesisProgress = null }) {
      const params = createOmniVoiceRequest(text, voice);
      const job = queue.then(async () => {
        if (retired) throw new Error('OmniVoice has been disposed.');
        if (signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
        const abort = () => engine?.abortGeneration();
        signal?.addEventListener('abort', abort, { once: true });
        /** @param {Awaited<ReturnType<typeof createOmniVoiceWorker>>} runtime @param {any} request
         * @param {any} progress @returns {Promise<{pcm:Float32Array,sampleRate:number}>} */
        async function synthesizeSection(runtime, request, progress) {
          if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
          try {
            const result = await runtime.synthesize(request, ...(progress ? [{ onProgress: progress }] : []));
            if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
            return { pcm: result.pcm instanceof Float32Array ? result.pcm : Float32Array.from(result.pcm), sampleRate: result.sampleRate };
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'OmniVoiceSectionLengthError') throw error;
            const parts = splitSectionText(request.text, request.lang);
            if (!parts) throw error;
            const results = [];
            for (let index = 0; index < parts.length; index += 1) {
              const result = await synthesizeSection(runtime, { ...request, text: parts[index] }, index === parts.length - 1 ? progress : null);
              assertOmniVoiceAudio(result.pcm, result.sampleRate);
              results.push(result);
            }
            if (results.some(result => result.sampleRate !== results[0].sampleRate)) throw new Error('OmniVoice section sample rates differ.');
            const pcm = new Float32Array(results.reduce((length, result) => length + result.pcm.length, 0));
            let offset = 0;
            for (const [index, result] of results.entries()) {
              pcm.set(result.pcm, offset);
              // The final WAV encoder only sees the outer edges of this recovered section.
              const fade = Math.min(Math.round(result.sampleRate * 0.005), Math.floor(result.pcm.length / 2));
              for (let i = 0; i < fade; i += 1) {
                const gain = i / fade;
                if (index > 0) pcm[offset + i] *= gain;
                if (index < results.length - 1) pcm[offset + result.pcm.length - 1 - i] *= gain;
              }
              offset += result.pcm.length;
            }
            return { pcm, sampleRate: results[0].sampleRate };
          }
        }
        try {
          let seed = params.seed;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await this.init({ signal });
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
              const runtime = engine;
              if (!runtime) throw new Error('OmniVoice runtime was not initialized.');
              const result = await synthesizeSection(runtime, { ...params, seed }, onSynthesisProgress);
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
              const audio = result.pcm instanceof Float32Array ? result.pcm : Float32Array.from(result.pcm);
              assertOmniVoiceAudio(audio, result.sampleRate);
              return { audio, sampling_rate: result.sampleRate,
                ...(seed !== params.seed ? { voiceRecovery: { selectedSeed: params.seed, seed } } : {}) };
            } catch (error) {
              if (retired || signal?.aborted) throw error;
              await resetRuntime();
              if (attempt) throw error;
              // Retry sampling with the same fixed speakerId, never substitute another voice.
              const badAudio = error instanceof Error && error.name === 'OmniVoiceAudioQualityError';
              if (badAudio) seed = (seed + 1) >>> 0;
              logger.warn('OmniVoice failed; restarting with the same voice.', { error, selectedSeed: params.seed, seed, speakerId: params.speakerId });
              onProgress({ message: badAudio ? 'Audio check failed. Retrying with the same voice…' : 'Voice engine stopped. Restarting with the same voice…' });
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
            }
          }
        } catch (error) {
          if (signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
          throw error;
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      });
      queue = job.catch(suppressError);
      return job;
    },
    dispose() {
      if (!disposal) {
        retired = true;
        engine?.abortGeneration();
        if (!initialized) engine?.terminate?.();
        disposal = (async () => {
          await initPromise?.catch(suppressError);
          await queue;
          await engine?.dispose();
          engine = null;
        })();
      }
      return disposal;
    },
  };
}

