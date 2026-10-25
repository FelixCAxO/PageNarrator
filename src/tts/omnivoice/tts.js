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
  let speakerKey = null;
  let speakerSeed = null;
  let initialized = false;
  return {
    capabilities: { id: 'omnivoice', local: true, streaming: false, wordTimings: false, requiresNetwork: false },
    /** @param {{signal?: AbortSignal|null}} [options] */
    init({ signal = null } = {}) {
      if (retired) return Promise.reject(new DOMException('OmniVoice was released.', 'AbortError'));
      initPromise ||= loadRuntime({ onProgress }).then(async runtime => {
        engine = runtime;
        if (retired) { runtime.terminate?.(); await runtime.dispose(); throw new DOMException('OmniVoice was released.', 'AbortError'); }
        await engine.init(OMNIVOICE_MODEL_BASE_URL);
        if (retired) throw new DOMException('OmniVoice was released.', 'AbortError');
        initialized = true;
        return this;
      });
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
        await this.init();
        if (signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
        const abort = () => engine?.abortGeneration();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const key = JSON.stringify([params.lang, params.instruct, params.seed]);
          let seed = speakerKey === key ? speakerSeed ?? params.seed : params.seed;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const numStep = speakerKey === key ? 12 : params.numStep;
              const result = await engine.synthesize({ ...params, seed, numStep });
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
              const audio = result.pcm instanceof Float32Array ? result.pcm : Float32Array.from(result.pcm);
              assertOmniVoiceAudio(audio, result.sampleRate);
              speakerKey = result.speaker?.anchorHash ? key : null;
              speakerSeed = speakerKey ? seed : null;
              return { audio, sampling_rate: result.sampleRate,
                ...(seed !== params.seed ? { voiceRecovery: { selectedSeed: params.seed, seed } } : {}) };
            } catch (error) {
              if (!(error instanceof Error) || error.name !== 'OmniVoiceAudioQualityError' || retired || signal?.aborted) throw error;
              speakerKey = null;
              speakerSeed = null;
              const failed = engine;
              engine = null;
              initialized = false;
              await Promise.resolve(failed.dispose()).catch(suppressError);
              initPromise = null;
              if (attempt) throw error;
              // Repeating the same seed in a fresh worker reproduces a deterministic bad speaker.
              seed = (seed + 1) >>> 0;
              logger.warn('Invalid OmniVoice audio; recreating the voice once.', { selectedSeed: params.seed, seed });
              onProgress({ message: 'Audio check failed. Recreating this voice…' });
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
              await this.init();
              if (retired || signal?.aborted) throw new DOMException('Reading stopped.', 'AbortError');
            }
          }
        } catch (error) {
          speakerKey = null;
          speakerSeed = null;
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

