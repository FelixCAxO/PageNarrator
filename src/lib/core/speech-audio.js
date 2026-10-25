// @ts-check
import { tokenizeSpokenWords } from '../speech-tokenization.js';
import { STREAM_SYNTHESIS_TIMEOUT_MS } from '../timing-config.js';
import { createLogger, createSuppressedErrorHandler } from '../logger.js';
import { initializeNativeKernels, processPcm } from '../native-kernels.js';
import {
  ESTIMATED_TIMING_CONFIDENCE,
  LANGUAGE_TIMING_PATTERNS,
  LANGUAGES_WITH_SILENT_FINAL_E,
  PHONEME_BOUNDARY_TOKENS,
  PHONEME_LENGTH_TOKENS,
  PHONEME_STRESS_TOKENS,
  PHONEME_TIMING_CONFIDENCE,
  SPEECH_WINDOW_MIN_TRIM_SECONDS,
  SPEECH_WINDOW_PADDING_SECONDS,
  SPEECH_WINDOW_THRESHOLD_FLOOR,
  SPEECH_WINDOW_THRESHOLD_RATIO,
} from './speech-alignment.js';

const DEFAULT_STREAM_TIMEOUT_MS = STREAM_SYNTHESIS_TIMEOUT_MS;
const PROGRESSIVE_STREAM_SPLIT_PATTERN = /(?<=[.!?,;:])\s+|\n+/u;
const GENERATED_SPEECH_TIMEOUT_PER_CHAR_MS = 125;
const GENERATED_SPEECH_TIMEOUT_MAX_MS = 60_000;
const speechAudioLogger = createLogger('speech-audio');
const suppressSpeechAudioError = createSuppressedErrorHandler(speechAudioLogger, 'Best-effort speech audio operation failed.');

/**
 * @param {any} tts
 * @param {string} text
 * @param {any} [options]
 */
export async function synthesizeSpeechChunk(tts, text, {
  voice,
  languageCode,
  streamTimeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  generatedSpeechTimeoutMs = null,
  signal = null,
  testSilentTts = false,
  useStream = true,
} = {}) {
  throwIfAborted(signal);
  if (testSilentTts) return synthesizeSilentTestSpeech(text);

  if (useStream && typeof tts?.stream === 'function') {
    const streamed = await synthesizeSpeechChunkFromStream(tts, text, {
      voice,
      languageCode,
      streamTimeoutMs,
      signal,
    });
    if (streamed) return streamed;
  }

  return synthesizeSpeechChunkFromGenerate(tts, text, { voice, languageCode, generatedSpeechTimeoutMs, signal });
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {any} [options]
 */
export async function* synthesizeSpeechSegments(tts, text, {
  voice,
  languageCode,
  streamTimeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  generatedSpeechTimeoutMs = null,
  signal = null,
  testSilentTts = false,
} = {}) {
  throwIfAborted(signal);
  if (testSilentTts) {
    yield {
      ...synthesizeSilentTestSpeech(text),
      text,
      speechWordOffset: 0,
    };
    return;
  }

  void initializeNativeKernels();
  const iterator = tts?.stream?.(text, {
    ...createGenerateOptions(voice, signal),
    split_pattern: PROGRESSIVE_STREAM_SPLIT_PATTERN,
  })?.[Symbol.asyncIterator]?.();
  if (!iterator) {
    yield await synthesizeGeneratedSpeechSegment(tts, text, { voice, languageCode, generatedSpeechTimeoutMs, signal });
    return;
  }

  let yieldedSegments = 0;
  let speechWordOffset = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const result = await withTimeout(iterator.next(), streamTimeoutMs, { signal });
      if (result?.done) break;
      const segment = createSpeechSegment(result?.value, speechWordOffset, { languageCode });
      if (!segment) continue;
      yieldedSegments += 1;
      speechWordOffset += tokenizeSpokenWords(segment.text).length;
      yield segment;
    }
  } catch (error) {
    cancelIterator(iterator);
    if (isAbortError(error)) return;
  }

  cancelIterator(iterator);

  // ponytail: regenerate only unread words; a stalled/short stream must not silently finish the chunk.
  const remainingText = yieldedSegments === 0 ? text : text.slice(tokenizeSpokenWords(text)[speechWordOffset]?.start ?? text.length);
  if (remainingText.trim()) {
    yield { ...await synthesizeGeneratedSpeechSegment(tts, remainingText, { voice, languageCode, generatedSpeechTimeoutMs, signal }), speechWordOffset };
  }
}

/**
 * @param {any} segments
 * @param {any} [options]
 */
export function primeSpeechSegments(segments, { onSegmentReady = null } = {}) {
  const iterator = segments?.[Symbol.asyncIterator]?.();
  if (!iterator) return segments;

  let returned = false;
  let segmentIndex = 0;
  /** @type {Promise<any>|null} */
  let pendingNext = primeNext();

  function primeNext() {
    const index = segmentIndex;
    segmentIndex += 1;
    const promise = Promise.resolve(iterator.next()).then(
      (result) => {
        notifyPrimedSegment({ segmentIndex: index, result });
        return result;
      },
      (error) => {
        notifyPrimedSegment({ segmentIndex: index, error });
        throw error;
      },
    );
    promise.catch(suppressSpeechAudioError);
    return promise;
  }

  function notifyPrimedSegment(event) {
    if (returned || typeof onSegmentReady !== 'function') return;
    try {
      Promise.resolve(onSegmentReady(event)).catch((error) => {
        speechAudioLogger.warn('Speech segment readiness callback failed.', error);
      });
    } catch (error) {
      speechAudioLogger.warn('Speech segment readiness callback failed.', error);
    }
  }

  return {
    next() {
      if (returned) return Promise.resolve({ done: true, value: undefined });
      const next = pendingNext || primeNext();
      pendingNext = null;
      return next;
    },
    async return(value) {
      returned = true;
      pendingNext = null;
      if (typeof iterator.return === 'function') return iterator.return(value);
      return { done: true, value };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {Record<string, any>} options
 */
async function synthesizeSpeechChunkFromStream(tts, text, {
  voice,
  languageCode,
  streamTimeoutMs,
  signal = null,
} = {}) {
  const segments = [];
  const iterator = tts.stream(text, createGenerateOptions(voice, signal))?.[Symbol.asyncIterator]?.();
  if (!iterator) return null;
  void initializeNativeKernels();

  try {
    while (true) {
      throwIfAborted(signal);
      const result = await withTimeout(iterator.next(), streamTimeoutMs, { signal });
      if (result?.done) break;
      const segment = result?.value;
      if (!segment?.audio?.audio?.length || !segment.audio.sampling_rate) continue;
      segments.push({
        text: segment.text || '',
        audio: segment.audio.audio,
        samplingRate: segment.audio.sampling_rate,
        timingSource: segment,
      });
    }
  } catch (error) {
    cancelIterator(iterator);
    if (isAbortError(error)) throw error;
    return null;
  }

  cancelIterator(iterator);
  throwIfAborted(signal);

  if (!segments.length) return null;

  const speech = combineSpeechSegments(segments, { languageCode });
  return { ...speech, ...(segments.every((segment) => segment.timingSource?.fromWarmup) ? { fromWarmup: true } : {}) };
}

/** @param {any[]} segments @param {any} options */
function combineSpeechSegments(segments, { languageCode } = {}) {
  const sampleRate = segments[0].samplingRate;
  let offset = 0;
  const wordTimings = [];
  const encodedChunks = [];

  for (const segment of segments) {
    const durationSeconds = segment.audio.length / (segment.samplingRate || sampleRate);
    const native = processPcm(segment.audio, SPEECH_WINDOW_THRESHOLD_FLOOR, SPEECH_WINDOW_THRESHOLD_RATIO);
    encodedChunks.push(native?.pcm16);
    const segmentSpeechWindow = getPcmSpeechWindow(segment.audio, segment.samplingRate || sampleRate, native);
    const segmentTimings = createAlignedWordTimings(segment.text, durationSeconds, segment.timingSource, {
      languageCode,
      speechWindow: segmentSpeechWindow,
    });
    for (const timing of segmentTimings) {
      wordTimings.push({
        text: timing.text,
        start: timing.start + offset,
        end: timing.end + offset,
        confidence: timing.confidence ?? null,
        source: timing.source || 'estimated',
      });
    }
    offset += durationSeconds;
  }

  return {
    blob: pcmChunksToWavBlob(segments.map((segment) => segment.audio), sampleRate, true, encodedChunks),
    wordTimings,
    durationSeconds: offset,
  };
}

/**
 * @param {any} segment
 * @param {number} speechWordOffset
 * @param {Record<string, any>} options
 */
function createSpeechSegment(segment, speechWordOffset, { languageCode } = {}) {
  if (!segment?.audio?.audio?.length || !segment.audio.sampling_rate) return null;
  const durationSeconds = segment.audio.audio.length / segment.audio.sampling_rate;
  const prepared = preparePcmAudio(segment.audio.audio, segment.audio.sampling_rate);
  return {
    text: segment.text || '',
    blob: prepared.blob,
    wordTimings: createAlignedWordTimings(segment.text || '', durationSeconds, segment, {
      languageCode,
      speechWindow: prepared.speechWindow,
    }),
    durationSeconds,
    speechWordOffset,
  };
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {Record<string, any>} options
 */
async function synthesizeGeneratedSpeechSegment(tts, text, { voice, languageCode, generatedSpeechTimeoutMs = null, signal = null } = {}) {
  const generated = await synthesizeSpeechChunkFromGenerate(tts, text, { voice, languageCode, generatedSpeechTimeoutMs, signal });
  return {
    ...generated,
    text,
    speechWordOffset: 0,
  };
}

/**
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @param {Record<string, any>} options
 */
function withTimeout(promise, timeoutMs, {
  signal = null,
  message = 'Kokoro stream did not finish promptly.',
  code = null,
} = {}) {
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_STREAM_TIMEOUT_MS;
  const source = Promise.resolve(promise);
  source.catch(suppressSpeechAudioError);
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      if (code) error.code = code;
      reject(error);
    }, safeTimeout);
  });
  const pending = Promise.race([source, timeout]);

  return withAbortSignal(pending, signal).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function cancelIterator(iterator) {
  try {
    Promise.resolve(iterator.return?.()).catch((error) => {
      speechAudioLogger.warn('Could not return speech stream iterator.', error);
    });
  } catch (error) {
    speechAudioLogger.warn('Could not return speech stream iterator.', error);
  }
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {Record<string, any>} options
 */
async function synthesizeSpeechChunkFromGenerate(tts, text, { voice, languageCode, generatedSpeechTimeoutMs = null, signal = null } = {}) {
  throwIfAborted(signal);
  let audio = null;
  try {
    audio = await generateSpeechAudio(tts, text, createGenerateOptions(voice, signal), { signal, timeoutMs: generatedSpeechTimeoutMs });
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (isAbortError(error) || isGeneratedSpeechTimeoutError(error)
      || (error instanceof Error && error.name === 'OmniVoiceAudioQualityError')) throw error;
    return synthesizeSpeechChunkFromGenerateRetry(tts, text, {
      voice,
      languageCode,
      generatedSpeechTimeoutMs,
      signal,
      originalError: error,
    });
  }
  throwIfAborted(signal);
  const durationSeconds = audio.audio.length / audio.sampling_rate;

  if (isSuspiciouslyShort(text, durationSeconds)) {
    speechAudioLogger.warn('Generated speech was shorter than expected; retrying as smaller chunks.');
    const [leftText, rightText] = splitSpeechText(text);
    if (leftText && rightText) {
      const [left, right] = await Promise.all([
        generateSpeechAudio(tts, leftText, createGenerateOptions(voice, signal), { signal, timeoutMs: generatedSpeechTimeoutMs }),
        generateSpeechAudio(tts, rightText, createGenerateOptions(voice, signal), { signal, timeoutMs: generatedSpeechTimeoutMs }),
      ]);
      throwIfAborted(signal);
      return combineSpeechSegments([
        { text: leftText, audio: left.audio, samplingRate: left.sampling_rate, timingSource: left },
        { text: rightText, audio: right.audio, samplingRate: right.sampling_rate, timingSource: right },
      ], { languageCode });
    }
  }

  const prepared = preparePcmAudio(audio.audio, audio.sampling_rate);
  return {
    ...(audio.fromWarmup ? { fromWarmup: true } : {}),
    blob: prepared.blob,
    wordTimings: createAlignedWordTimings(text, durationSeconds, audio, {
      languageCode,
      speechWindow: prepared.speechWindow,
    }),
    durationSeconds,
  };
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {any} [options]
 */
async function synthesizeSpeechChunkFromGenerateRetry(tts, text, {
  voice,
  languageCode,
  generatedSpeechTimeoutMs = null,
  signal = null,
  originalError = null,
} = {}) {
  const [leftText, rightText] = splitSpeechText(text);
  if (!leftText || !rightText) throw originalError || new Error('Generated speech failed.');

  try {
    const [left, right] = await Promise.all([
      generateSpeechAudio(tts, leftText, createGenerateOptions(voice, signal), { signal, timeoutMs: generatedSpeechTimeoutMs }),
      generateSpeechAudio(tts, rightText, createGenerateOptions(voice, signal), { signal, timeoutMs: generatedSpeechTimeoutMs }),
    ]);
    throwIfAborted(signal);
    return combineSpeechSegments([
      { text: leftText, audio: left.audio, samplingRate: left.sampling_rate, timingSource: left },
      { text: rightText, audio: right.audio, samplingRate: right.sampling_rate, timingSource: right },
    ], { languageCode });
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (isAbortError(error) || isGeneratedSpeechTimeoutError(error)) throw error;
    throw originalError || new Error('Generated speech failed.');
  }
}

export function synthesizeSilentTestSpeech(text, { sampleRate = 24000 } = {}) {
  const words = tokenizeSpokenWords(text);
  const durationSeconds = Math.max(0.06, (words.length || 1) * 0.06);
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const pcm = new Float32Array(samples);
  const wordDuration = words.length ? durationSeconds / words.length : durationSeconds;
  const wordTimings = words.map((word, index) => ({
    text: word.text,
    start: index * wordDuration,
    end: index === words.length - 1 ? durationSeconds : (index + 1) * wordDuration,
    confidence: 1,
    source: 'silent-test',
  }));

  return {
    blob: pcmToWavBlob(pcm, sampleRate),
    wordTimings,
    durationSeconds,
  };
}

export function getGeneratedSpeechTimeoutMs(text) {
  const normalizedLength = Math.max(1, String(text || '').replace(/\s+/g, ' ').trim().length);
  const proportional = Math.ceil(normalizedLength * GENERATED_SPEECH_TIMEOUT_PER_CHAR_MS);
  return Math.max(DEFAULT_STREAM_TIMEOUT_MS, Math.min(GENERATED_SPEECH_TIMEOUT_MAX_MS, proportional));
}

/**
 * @param {any} tts
 * @param {string} text
 * @param {Record<string, any>} options
 * @param {Record<string, any>} abortOptions
 */
async function generateSpeechAudio(tts, text, options, { signal = null, timeoutMs = null } = {}) {
  throwIfAborted(signal);
  if (!tts || typeof tts.generate !== 'function') {
    throw new Error('Generated speech is unavailable for this voice.');
  }
  const deadlineMs = getGeneratedSpeechDeadlineMs(text, timeoutMs);
  void initializeNativeKernels();
  const source = Promise.resolve(tts.generate(text, options));
  source.catch(suppressSpeechAudioError);
  let timeoutId = null;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (signal?.aborted) return;
      reject(createGeneratedSpeechTimeoutError(deadlineMs));
    }, deadlineMs);
  });

  try {
    const audio = await Promise.race([source, deadline]);
    throwIfAborted(signal);
    return audio;
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function getGeneratedSpeechDeadlineMs(text, timeoutMs = null) {
  const explicit = Number(timeoutMs);
  return Number.isFinite(explicit) && explicit > 0
    ? Math.trunc(explicit)
    : getGeneratedSpeechTimeoutMs(text);
}

function createGenerateOptions(voice, signal) {
  const options = { voice };
  if (signal) options.signal = signal;
  return options;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw createAbortError();
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function isGeneratedSpeechTimeoutError(error) {
  return error?.code === 'generated_speech_timeout';
}

function createAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Speech synthesis was aborted.', 'AbortError');
  const error = new Error('Speech synthesis was aborted.');
  error.name = 'AbortError';
  return error;
}

function createGeneratedSpeechTimeoutError(timeoutMs) {
  const error = /** @type {any} */ (new Error('Generated speech did not finish promptly.'));
  error.code = 'generated_speech_timeout';
  error.timeoutMs = timeoutMs;
  return error;
}

function withAbortSignal(promise, signal) {
  throwIfAborted(signal);
  const source = Promise.resolve(promise);
  source.catch(suppressSpeechAudioError);
  if (!signal || typeof signal.addEventListener !== 'function') return source;

  return new Promise((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    source.then(resolve, reject).finally(() => {
      signal.removeEventListener?.('abort', abort);
    });
  });
}

const SENTENCE_PAUSE_SECONDS = 0.45;
const COMMA_PAUSE_SECONDS = 0.12;
const MIN_SPEECH_DURATION_RATIO = 0.35;
const MIN_EXPECTED_SECONDS_PER_CHAR = 0.04;

/**
 * @param {Record<string, any>} options
 */
export function estimateWordTimings(text, durationSeconds, options = {}) {
  const words = tokenizeSpokenWords(text);
  if (!words.length || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const weights = words.map((word) => getWordTimingWeight(word.text, options.languageCode));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const { pauses, speechDuration } = getTimingPausePlan(words, text, durationSeconds);
  let cursor = 0;

  const timings = words.map((_word, index) => {
    const wordDuration = (weights[index] / totalWeight) * speechDuration;
    const timing = {
      text: words[index].text,
      start: cursor,
      end: cursor + wordDuration,
      confidence: ESTIMATED_TIMING_CONFIDENCE,
      source: 'estimated',
    };
    cursor += wordDuration + pauses[index];
    return timing;
  });

  timings[timings.length - 1].end = Math.min(durationSeconds, timings[timings.length - 1].end);
  return timings;
}

/**
 * @param {string} text
 * @param {number} durationSeconds
 * @param {any} [timingSource]
 * @param {any} [options]
 */
export function createAlignedWordTimings(text, durationSeconds, timingSource = null, options = {}) {
  const words = tokenizeSpokenWords(text);
  if (!words.length || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const provided = normalizeProvidedWordTimings(getProvidedWordTimings(timingSource), {
    durationSeconds,
    expectedWords: words,
  });
  if (provided) return provided;

  const audio = timingSource?.audio?.audio ? timingSource.audio : timingSource;
  const speechWindow = normalizeSpeechWindow(options.speechWindow === undefined
    ? getPcmSpeechWindow(audio?.audio, audio?.sampling_rate) : options.speechWindow, durationSeconds);
  const alignmentDurationSeconds = speechWindow.durationSeconds;
  const phonemeEstimated = estimateWordTimingsFromPhonemes(timingSource, {
    durationSeconds: alignmentDurationSeconds,
    expectedWords: words,
    text,
  });
  const timings = phonemeEstimated || estimateWordTimings(text, alignmentDurationSeconds, options);
  return applySpeechWindow(timings, speechWindow, durationSeconds);
}

/** @param {any} pcm @param {any} sampleRate @param {{first: number, last: number}|null} [native] */
function getPcmSpeechWindow(pcm, sampleRate, native = null) {
  const rate = Number(sampleRate);
  if (!pcm?.length || !Number.isFinite(rate) || rate <= 0) return null;

  native ??= processPcm(pcm, SPEECH_WINDOW_THRESHOLD_FLOOR, SPEECH_WINDOW_THRESHOLD_RATIO, false);
  let first = native?.first ?? -1;
  let last = native?.last ?? -1;
  if (!native) {
    let peak = 0;
    for (let index = 0; index < pcm.length; index += 1) {
      const amplitude = Math.abs(Number(pcm[index]));
      if (Number.isFinite(amplitude) && amplitude > peak) peak = amplitude;
    }
    if (peak <= 0) return null;
    const threshold = Math.max(SPEECH_WINDOW_THRESHOLD_FLOOR, peak * SPEECH_WINDOW_THRESHOLD_RATIO);
    for (let index = 0; index < pcm.length; index += 1) {
      const amplitude = Math.abs(Number(pcm[index]));
      if (!Number.isFinite(amplitude) || amplitude <= threshold) continue;
      if (first < 0) first = index;
      last = index;
    }
  }

  if (first < 0 || last < first) return null;

  const durationSeconds = pcm.length / rate;
  const start = Math.max(0, (first / rate) - SPEECH_WINDOW_PADDING_SECONDS);
  const end = Math.min(durationSeconds, ((last + 1) / rate) + SPEECH_WINDOW_PADDING_SECONDS);
  if ((start + (durationSeconds - end)) < SPEECH_WINDOW_MIN_TRIM_SECONDS) return null;
  return { start, end, durationSeconds: end - start };
}

function normalizeSpeechWindow(speechWindow, durationSeconds) {
  const fullWindow = {
    start: 0,
    end: durationSeconds,
    durationSeconds,
  };
  if (!speechWindow) return fullWindow;

  const start = Math.max(0, Math.min(durationSeconds, Number(speechWindow.start)));
  const end = Math.max(0, Math.min(durationSeconds, Number(speechWindow.end)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fullWindow;
  if ((start + (durationSeconds - end)) < SPEECH_WINDOW_MIN_TRIM_SECONDS) return fullWindow;

  return {
    start,
    end,
    durationSeconds: end - start,
  };
}

function applySpeechWindow(timings, speechWindow, durationSeconds) {
  if (!Array.isArray(timings) || !timings.length) return timings;
  if (speechWindow.start <= 0 && speechWindow.end >= durationSeconds) return timings;

  return timings.map((timing) => ({
    ...timing,
    start: Math.max(0, Math.min(durationSeconds, timing.start + speechWindow.start)),
    end: Math.max(0, Math.min(durationSeconds, timing.end + speechWindow.start)),
  }));
}

function getProvidedWordTimings(source) {
  const candidates = [
    source?.wordTimings,
    source?.word_timestamps,
    source?.words,
    source?.timestamps,
    source?.alignment?.words,
    source?.audio?.wordTimings,
    source?.audio?.word_timestamps,
    source?.audio?.words,
    source?.audio?.alignment?.words,
  ];

  return candidates.find((candidate) => Array.isArray(candidate) && candidate.length) || null;
}

function normalizeProvidedWordTimings(timings, { durationSeconds, expectedWords }) {
  if (!Array.isArray(timings) || !timings.length) return null;

  const provided = timings.map((timing) => {
    const start = normalizeTimingSeconds(getFirstFiniteNumber(
      timing?.start,
      timing?.startTime,
      timing?.start_time,
      timing?.startSeconds,
      timing?.start_seconds,
      timing?.time,
    ), durationSeconds);
    const end = normalizeTimingSeconds(getFirstFiniteNumber(
      timing?.end,
      timing?.endTime,
      timing?.end_time,
      timing?.endSeconds,
      timing?.end_seconds,
    ), durationSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

    const confidence = Number(timing?.confidence);
    return {
      text: String(timing?.text ?? timing?.word ?? ''),
      start: Math.max(0, start),
      end: Math.min(durationSeconds, end),
      confidence: Number.isFinite(confidence) ? confidence : null,
      source: 'aligned',
    };
  });

  if (provided.some((timing) => !timing || timing.end <= timing.start)) return null;

  const normalized = reconcileProvidedWordTimings(provided, expectedWords);
  if (!normalized) return null;
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].start < normalized[index - 1].start) return null;
  }
  return normalized;
}

function reconcileProvidedWordTimings(provided, expectedWords) {
  if (provided.length === expectedWords.length && provided.every((timing, index) => (
    canAlignProvidedToken(timing.text, expectedWords[index].text)
  ))) {
    return provided.map((timing, index) => ({
      ...timing,
      text: expectedWords[index].text,
    }));
  }

  if (provided.some((timing) => !String(timing.text || '').trim())) return null;

  const reconciled = [];
  let providedIndex = 0;

  for (const expectedWord of expectedWords) {
    const expectedText = String(expectedWord?.text || '');
    const expectedKey = normalizeTimingTokenText(expectedText);
    if (!expectedKey) continue;

    while (providedIndex < provided.length && !normalizeTimingTokenText(provided[providedIndex].text)) {
      providedIndex += 1;
    }

    const entries = [];
    let combinedKey = '';
    while (providedIndex < provided.length && combinedKey.length < expectedKey.length) {
      const timing = provided[providedIndex];
      const timingKey = normalizeTimingTokenText(timing.text);
      providedIndex += 1;
      if (!timingKey) continue;
      combinedKey += timingKey;
      entries.push(timing);
    }

    if (combinedKey !== expectedKey || !entries.length) return null;

    reconciled.push(createCombinedProvidedTiming(
      expectedText,
      entries,
    ));
  }

  while (providedIndex < provided.length && !normalizeTimingTokenText(provided[providedIndex].text)) {
    providedIndex += 1;
  }

  return providedIndex === provided.length && reconciled.length === expectedWords.length
    ? reconciled
    : null;
}

function canAlignProvidedToken(providedText, expectedText) {
  const providedKey = normalizeTimingTokenText(providedText);
  const expectedKey = normalizeTimingTokenText(expectedText);
  if (!providedKey) return true;
  if (!expectedKey) return false;
  return providedKey === expectedKey;
}

function createCombinedProvidedTiming(text, entries) {
  return {
    text,
    start: entries[0].start,
    end: entries[entries.length - 1].end,
    confidence: combineTimingConfidence(entries),
    source: 'aligned',
  };
}

function combineTimingConfidence(entries) {
  const values = entries.map((entry) => Number(entry?.confidence)).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeTimingTokenText(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function estimateWordTimingsFromPhonemes(source, { durationSeconds, expectedWords, text }) {
  const groups = normalizePhonemeWordGroups(getPhonemeWordGroups(source), expectedWords);
  if (!groups || groups.length !== expectedWords.length) return null;

  const weights = groups.map((group) => getTimingWeightForSpokenUnits(group.units));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const { pauses, speechDuration } = getTimingPausePlan(expectedWords, text, durationSeconds);
  let cursor = 0;

  const timings = expectedWords.map((word, index) => {
    const wordDuration = (weights[index] / totalWeight) * speechDuration;
    const timing = {
      text: word.text,
      start: cursor,
      end: cursor + wordDuration,
      confidence: PHONEME_TIMING_CONFIDENCE,
      source: 'phoneme-estimated',
    };
    cursor += wordDuration + pauses[index];
    return timing;
  });

  timings[timings.length - 1].end = Math.min(durationSeconds, timings[timings.length - 1].end);
  return timings;
}

function normalizePhonemeWordGroups(groups, expectedWords) {
  if (!Array.isArray(groups) || !groups.length) return null;
  if (groups.length === expectedWords.length) return groups;
  if (groups.length < expectedWords.length) return null;

  const totalUnits = groups.reduce((sum, group) => sum + Math.max(0, Number(group?.units) || 0), 0);
  if (totalUnits <= 0) return null;

  const wordWeights = expectedWords.map((word) => Math.max(1, String(word?.text || '').replace(/[^\p{L}\p{N}]/gu, '').length));
  const totalWordWeight = wordWeights.reduce((sum, weight) => sum + weight, 0) || expectedWords.length;
  const normalized = [];
  let groupIndex = 0;
  let consumedUnits = 0;
  let targetUnits = 0;

  for (let wordIndex = 0; wordIndex < expectedWords.length; wordIndex += 1) {
    targetUnits += (wordWeights[wordIndex] / totalWordWeight) * totalUnits;
    const isLastWord = wordIndex === expectedWords.length - 1;
    let units = 0;

    while (groupIndex < groups.length && (isLastWord || consumedUnits + units < targetUnits || units <= 0)) {
      units += Math.max(0, Number(groups[groupIndex]?.units) || 0);
      groupIndex += 1;
      if (!isLastWord && groupIndex >= groups.length - (expectedWords.length - wordIndex - 1)) break;
    }

    normalized.push({ units: units || 1 });
    consumedUnits += units;
  }

  return normalized;
}

function getPhonemeWordGroups(source) {
  const phonemes = getPhonemes(source);
  if (!Array.isArray(phonemes) || !phonemes.length) return null;

  const groups = [];
  let units = 0;

  const finishWord = () => {
    if (units <= 0) return;
    groups.push({ units });
    units = 0;
  };

  for (const rawPhoneme of phonemes) {
    const phoneme = String(rawPhoneme ?? '');
    if (!phoneme) continue;
    if (isPhonemeBoundary(phoneme)) continue;
    if (isPhonemeWordSeparator(phoneme) || isPhonemePunctuation(phoneme)) {
      finishWord();
      continue;
    }

    units += getPhonemeUnitWeight(phoneme);
  }

  finishWord();
  return groups.length ? groups : null;
}

function getPhonemes(source) {
  const candidates = [
    source?.phonemeData?.phonemes,
    source?.phonemes,
    source?.audio?.phonemeData?.phonemes,
    source?.audio?.phonemes,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
    if (typeof candidate === 'string' && candidate.length) return Array.from(candidate);
  }
  return null;
}

function isPhonemeBoundary(phoneme) {
  return PHONEME_BOUNDARY_TOKENS.has(phoneme);
}

function isPhonemeWordSeparator(phoneme) {
  return !String(phoneme).trim();
}

function isPhonemePunctuation(phoneme) {
  return /^[.,;:!]+$/u.test(phoneme);
}

function getPhonemeUnitWeight(phoneme) {
  if (PHONEME_STRESS_TOKENS.has(phoneme)) return 0;
  if (PHONEME_LENGTH_TOKENS.has(phoneme)) return 0.35;
  return 1;
}

function getFirstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return Number.NaN;
}

function normalizeTimingSeconds(value, durationSeconds) {
  if (!Number.isFinite(value)) return Number.NaN;
  if (durationSeconds > 0 && value > durationSeconds * 2 && value / 1000 <= durationSeconds * 1.2) {
    return value / 1000;
  }
  return value;
}

function getPauseAfterWord(word) {
  const value = String(word || '').trim();
  if (/[.!?]["')\]\u00bb\u201d]*$/u.test(value)) return SENTENCE_PAUSE_SECONDS;
  if (/[,;:]["')\]\u00bb\u201d]*$/u.test(value)) return COMMA_PAUSE_SECONDS;
  return 0;
}

function getTimingPauses(words, text, durationSeconds) {
  if (durationSeconds < 1) return words.map(() => 0);
  return words.map((word, index) => (
    index === words.length - 1 ? 0 : getPauseAfterToken(word, words[index + 1], text)
  ));
}

function getTimingPausePlan(words, text, durationSeconds) {
  const pauses = getTimingPauses(words, text, durationSeconds);
  const pauseBudget = pauses.reduce((sum, pause) => sum + pause, 0);
  if (pauseBudget <= 0) {
    return {
      pauses,
      speechDuration: durationSeconds,
    };
  }

  const maxPauseBudget = Math.max(0, durationSeconds * (1 - MIN_SPEECH_DURATION_RATIO));
  if (pauseBudget <= maxPauseBudget) {
    return {
      pauses,
      speechDuration: durationSeconds - pauseBudget,
    };
  }

  const scale = maxPauseBudget / pauseBudget;
  const scaledPauses = pauses.map((pause) => pause * scale);
  const scaledPauseBudget = scaledPauses.reduce((sum, pause) => sum + pause, 0);
  return {
    pauses: scaledPauses,
    speechDuration: Math.max(0, durationSeconds - scaledPauseBudget),
  };
}

function getPauseAfterToken(word, nextWord, text) {
  const tokenPause = getPauseAfterWord(word?.text);
  if (tokenPause > 0) return tokenPause;

  const between = getTextBetweenTokens(word, nextWord, text).trim();
  if (!between) return 0;
  return getPauseAfterWord(`${word?.text || ''}${between}`);
}

function getTextBetweenTokens(word, nextWord, text) {
  const source = String(text || '');
  if (!source || !Number.isFinite(word?.end) || !Number.isFinite(nextWord?.start)) return '';
  if (nextWord.start <= word.end) return '';
  return source.slice(word.end, nextWord.start);
}

function getWordTimingWeight(word, languageCode) {
  const value = String(word || '');
  const folded = foldLatinForTiming(value);
  const letters = folded.replace(/[^A-Za-z]/g, '');
  if (/^[A-Z]{2,4}$/.test(letters)) return getTimingWeightForSpokenUnits(letters.length);

  const digitMatches = value.match(/\d/g)?.length || 0;
  if (digitMatches > 0) {
    const decimalPointMatches = value.match(/\d\.\d/g)?.length || 0;
    return getTimingWeightForSpokenUnits(digitMatches + decimalPointMatches);
  }

  const language = normalizeTimingLanguageCode(languageCode);
  if (language !== 'en') {
    const spokenUnits = getLanguageSpokenUnits(folded, language, {
      protectedFinalE: hasProtectedFinalE(value, language),
    });
    if (spokenUnits > 0) return getTimingWeightForSpokenUnits(spokenUnits);
  }

  const cleaned = folded.toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return 1;
  const groups = cleaned.match(/[aeiouy]+/g)?.length || 1;
  const syllables = Math.min(8, cleaned.endsWith('e') && groups > 1 ? groups - 1 : groups);
  return getTimingWeightForSpokenUnits(syllables);
}

function normalizeTimingLanguageCode(languageCode) {
  const code = String(languageCode || '').toLowerCase().split(/[-_]/)[0];
  return code || 'en';
}

function getLanguageSpokenUnits(value, languageCode, { protectedFinalE = false } = {}) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return 0;

  const pattern = LANGUAGE_TIMING_PATTERNS[languageCode] || /[aeiouy]+/g;
  const groups = cleaned.match(pattern)?.length || 1;
  const spokenGroups = LANGUAGES_WITH_SILENT_FINAL_E.has(languageCode) && !protectedFinalE && cleaned.endsWith('e') && groups > 1
    ? groups - 1
    : groups;
  return Math.min(8, Math.max(1, spokenGroups));
}

function hasProtectedFinalE(value, languageCode) {
  if (languageCode !== 'fr') return false;
  const letters = String(value || '').normalize('NFC').replace(/[^\p{L}]+$/gu, '');
  return /[éèêë](?:e?s?)?$/iu.test(letters);
}

function foldLatinForTiming(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00df/g, 'ss')
    .replace(/\u1e9e/g, 'SS')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00c6/g, 'AE')
    .replace(/\u0153/g, 'oe')
    .replace(/\u0152/g, 'OE')
    .replace(/\u00f8/g, 'o')
    .replace(/\u00d8/g, 'O');
}

function getTimingWeightForSpokenUnits(units) {
  return 0.65 + Math.max(1, units) * 0.55;
}

function isSuspiciouslyShort(text, durationSeconds) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 60) return false;
  return durationSeconds < normalized.length * MIN_EXPECTED_SECONDS_PER_CHAR;
}

function splitSpeechText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const midpoint = Math.floor(normalized.length / 2);
  const beforeSentence = normalized.slice(0, midpoint + 1).search(/[.!?]\s+[^.!?]*$/);
  const afterSentence = normalized.slice(midpoint).search(/[.!?]\s+/);
  const before = normalized.slice(0, midpoint).lastIndexOf(' ');
  const after = normalized.slice(midpoint).search(/\s+/);
  const splitAt = beforeSentence >= 0
    ? beforeSentence + (normalized.slice(beforeSentence).match(/[.!?]\s+/)?.[0]?.length || 1) - 1
    : afterSentence >= 0
      ? midpoint + afterSentence + 1
      : after >= 0
        ? midpoint + after + 1
        : before;

  if (splitAt <= 0 || splitAt >= normalized.length) return [normalized, ''];
  return [
    normalized.slice(0, splitAt).trim(),
    normalized.slice(splitAt).trim(),
  ];
}

export function pcmToWavBlob(pcm, sampleRate) {
  return pcmChunksToWavBlob([pcm], sampleRate);
}

function preparePcmAudio(pcm, sampleRate) {
  const native = processPcm(pcm, SPEECH_WINDOW_THRESHOLD_FLOOR, SPEECH_WINDOW_THRESHOLD_RATIO);
  return {
    blob: pcmChunksToWavBlob([pcm], sampleRate, false, [native?.pcm16]),
    speechWindow: getPcmSpeechWindow(pcm, sampleRate, native),
  };
}

function pcmChunksToWavBlob(chunks, sampleRate, roundToFloat32 = false, encodedChunks = []) {
  const dataLen = chunks.reduce((sum, pcm) => sum + pcm.length * 2, 0);
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);

  let offset = 44;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const pcm = chunks[chunkIndex];
    const pcm16 = encodedChunks[chunkIndex]
      ?? processPcm(pcm, SPEECH_WINDOW_THRESHOLD_FLOOR, SPEECH_WINDOW_THRESHOLD_RATIO)?.pcm16;
    if (pcm16) {
      new Uint8Array(buf, offset, pcm16.byteLength).set(pcm16);
      offset += pcm16.byteLength;
      continue;
    }
    for (let i = 0; i < pcm.length; i += 1) {
      // Preserve the Float32 rounding previously applied by concatenation, including plain arrays.
      const value = roundToFloat32 ? Math.fround(pcm[i]) : pcm[i];
      const sample = Math.max(-1, Math.min(1, value));
      v.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buf], { type: 'audio/wav' });
}
