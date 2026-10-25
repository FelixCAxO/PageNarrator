import { cleanupAudioElement, createManagedAudioUrl } from './reader-engine-read-lifecycle.js';
import { BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS } from './timing-config.js';

/**
 * @param {any} speech
 * @param {any} chunk
 * @param {any} [options]
 */
export async function playProgressiveSpeechSegments(speech, chunk, {
  audioPlaybackManager,
  createProgressiveSegmentChunk,
  prepareSegmentAudio = defaultPrepareSegmentAudio,
  readRunTracker = { isCurrentRun: () => true },
  signal = null,
  runId = null,
  onBeforeNormalEnd = null,
  ...playAudioOptions
} = {}) {
  const iterator = speech?.segments?.[Symbol.asyncIterator]?.();
  if (!iterator || typeof audioPlaybackManager?.playAudio !== 'function' || typeof createProgressiveSegmentChunk !== 'function') return;

  const isStopped = () => signal?.aborted || (runId != null && !readRunTracker.isCurrentRun(runId));
  let nextResultPromise = iterator.next();

  while (true) {
    const currentResult = await nextResultPromise;
    if (currentResult?.done) break;

    const currentSegment = currentResult?.value;
    if (!currentSegment || isStopped()) break;

    const upcomingResultPromise = iterator.next();
    const upcomingStatePromise = upcomingResultPromise.catch(() => null);
    const upcomingPreparedAudioPromise = upcomingStatePromise
      .then(async (result) => {
        if (isStopped() || result?.done || !result?.value) return null;
        return prepareSegmentAudio(result.value, {
          readRunTracker,
          runId,
          signal,
        });
      })
      .catch(() => null);

    await audioPlaybackManager.playAudio(
      currentSegment.blob,
      currentSegment.wordTimings,
      createProgressiveSegmentChunk(chunk, currentSegment),
      {
        ...playAudioOptions,
        signal,
        runId,
        readRunTracker,
        canAdvanceEarly: false,
        onBeforeNormalEnd: async (event) => {
          const upcoming = await upcomingStatePromise;
          if (upcoming?.done && typeof onBeforeNormalEnd === 'function') {
            return onBeforeNormalEnd(event);
          }
          const preparedAudio = await upcomingPreparedAudioPromise;
          if (!preparedAudio || isStopped()) return null;
          return { preparedAudio };
        },
      },
    );

    if (isStopped()) break;
    nextResultPromise = upcomingResultPromise;
  }

  if (isStopped()) await iterator.return?.();
}

/**
 * @param {any} segment
 * @param {any} [options]
 */
async function defaultPrepareSegmentAudio(segment, {
  createAudio = typeof globalThis.Audio === 'function' ? (url) => new globalThis.Audio(url) : null,
  urlApi = globalThis.URL,
  getNowMs = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()),
  decodeReadyTimeoutMs = BROWSER_SPEECH_BOUNDARY_TIMEOUT_MS,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!segment?.blob || typeof createAudio !== 'function' || !urlApi?.createObjectURL) return null;

  const startedAtMs = getNowMs();
  const managedUrl = createManagedAudioUrl(segment.blob, { urlApi });
  const audio = createAudio(managedUrl.url);
  audio.preload = 'auto';

  return new Promise((resolve) => {
    let settled = false;
    let cleaned = false;
    let timeoutHandle = null;

    const cleanupPreparedAudio = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupAudioElement(audio);
      managedUrl.revoke();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        audio,
        managedUrl,
        cleanup: cleanupPreparedAudio,
        decodeLatencyMs: Math.max(0, getNowMs() - startedAtMs),
      });
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      cleanupPreparedAudio();
      resolve(null);
    };

    const cleanupListeners = () => {
      audio?.removeEventListener?.('canplay', finish);
      audio?.removeEventListener?.('loadeddata', finish);
      audio?.removeEventListener?.('error', fail);
      if (timeoutHandle !== null && typeof clearTimer === 'function') {
        clearTimer(timeoutHandle);
        timeoutHandle = null;
      }
    };

    if (Number(audio?.readyState) >= 3) {
      finish();
      return;
    }

    audio?.addEventListener?.('canplay', finish, { once: true });
    audio?.addEventListener?.('loadeddata', finish, { once: true });
    audio?.addEventListener?.('error', fail, { once: true });
    const timeoutMs = Math.max(0, Math.trunc(Number(decodeReadyTimeoutMs) || 0));
    if (timeoutMs > 0 && typeof setTimer === 'function') timeoutHandle = setTimer(fail, timeoutMs);
    audio?.load?.();
  });
}
