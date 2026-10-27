import { createOmniVoiceRequest } from '../../lib/omnivoice-settings.js';
import { createLogger, createSuppressedErrorHandler } from '../../lib/logger.js';

import { createOmniVoiceWorker } from './worker-client.js';
import { assertOmniVoiceAudio } from './audio-quality.js';
import { OMNIVOICE_MODEL_BASE_URL } from './loader.js';
import { withAbortSignal } from '../../lib/abort-signal.js';
export { OMNIVOICE_MODEL_REVISION, OMNIVOICE_MODEL_BASE_URL } from './loader.js';

const logger = createLogger('omnivoice');
const suppressError = createSuppressedErrorHandler(logger, 'OmniVoice cleanup failed.');
/** @param {any} [deps] */
export function createOmniVoiceTts({ loadRuntime = createOmniVoiceWorker, onProgress = () => {} } = {}) {
  let engine = null;
  let initPromise = null;
  /** @type {Promise<any>} */
  let queue = Promise.resolve();
  let retired = false;
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
        await engine.init(OMNIVOICE_MODEL_BASE_URL);
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
    /** @param {string} text @param {{ voice: any, signal?: AbortSignal|null }} options */
    generate(text, { voice, signal = null }) {
      const params = createOmniVoiceRequest(text, voice);
      const job = queue.then(async () => {
        if (retired) throw new Error('OmniVoice has been disposed.');
        if (signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
        const abort = () => engine?.abortGeneration();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          let seed = params.seed;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await this.init({ signal });
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
              const result = await engine.synthesize({ ...params, seed });
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

