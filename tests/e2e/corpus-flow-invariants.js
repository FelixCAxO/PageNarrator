import { normalizeFlowToken } from '../../src/lib/flow-recorder.js';
import {
  isShareWidgetLabel,
  stripPrivateUseCharacters,
} from '../../src/lib/core/text-noise-filter.js';

const SHORT_CHUNK_TEXT_LENGTH = 80;
const SHARE_WIDGET_TEXT_PATTERN = /\b(share (?:by|on|to|via)|share this(?: article| story)?|tweet this(?: article| story)?|post to|copy link|email this(?: article| story)?)\b/i;
const PRIVATE_USE_CHARACTER_PATTERN = /[\uE000-\uF8FF]/u;
const LINGUISTIC_CONTENT_PATTERN = /[\p{L}\p{N}]/u;

export function normalizeToken(value) {
  return normalizeFlowToken(value);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

export function buildCorpusFlowReport({ readerEngineLog = [], pageLog = [] } = {}) {
  const chunkStarts = readerEngineLog
    .filter((entry) => entry.kind === 'chunk_play')
    .sort(compareChunkEvents);
  const chunkEnds = readerEngineLog
    .filter((entry) => entry.kind === 'chunk_end')
    .sort(compareChunkEvents);
  const synthesisFailures = readerEngineLog.filter((entry) => entry.kind === 'synthesis_failed');
  const decodeLatencyEvents = readerEngineLog.filter((entry) => (
    entry.kind === 'audio_decode_latency' || entry.channel === 'decode_latency'
  ));
  const preloadDecodeLatencyEvents = readerEngineLog.filter((entry) => (
    entry.kind === 'audio_preload_decode_latency' || entry.channel === 'preload_decode_latency'
  ));
  const wordEvents = pageLog.filter((entry) => entry.kind === 'word');
  const wordEventsWithComparableTokens = wordEvents
    .filter((entry) => entry.speechText && entry.domToken);
  const wordEventsMissingTokens = wordEvents.filter((entry) => !entry.speechText || !entry.domToken);
  const extractionEvents = readerEngineLog.filter((entry) => entry.kind === 'chunks_extracted');
  const extractionEvent = extractionEvents[extractionEvents.length - 1];
  const totalChunksExtracted = Math.max(0, Math.trunc(Number(extractionEvent?.totalChunks) || 0));
  const startChunk = Math.max(0, Math.min(
    totalChunksExtracted,
    Math.trunc(Number(extractionEvent?.startChunk) || 0),
  ));
  const chunksExtracted = Math.max(0, totalChunksExtracted - startChunk);
  const spokenIndices = [...new Set(chunkStarts
    .map((entry) => Number(entry.chunkIndex))
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
  const chunkEndIndices = new Set(chunkEnds
    .map((entry) => Number(entry.chunkIndex))
    .filter(Number.isInteger));
  const missingChunkIndices = [];
  const spokenIndexSet = new Set(spokenIndices);
  for (let index = startChunk; index < totalChunksExtracted; index += 1) {
    if (!spokenIndexSet.has(index)) missingChunkIndices.push(index);
  }
  const unendedChunkIndices = spokenIndices.filter((index) => !chunkEndIndices.has(index));
  const startCountByChunkIndex = new Map();
  for (const entry of chunkStarts) {
    const chunkIndex = Number(entry.chunkIndex);
    if (!Number.isInteger(chunkIndex)) continue;
    startCountByChunkIndex.set(chunkIndex, (startCountByChunkIndex.get(chunkIndex) || 0) + 1);
  }
  const replayedChunkIndices = [...startCountByChunkIndex.entries()]
    .filter(([, count]) => count > 1)
    .map(([chunkIndex]) => chunkIndex)
    .sort((a, b) => a - b);

  return {
    chunkStarts,
    chunkEnds,
    totalChunksExtracted,
    startChunk,
    chunksExtracted,
    chunksSpoken: spokenIndices.length,
    missingChunkIndices,
    unendedChunkIndices,
    replayedChunkIndices,
    synthesisFailures,
    decodeLatencyP95Ms: percentile(decodeLatencyEvents
      .map((entry) => Number(entry.decodeLatencyMs))
      .filter(Number.isFinite), 95),
    preloadDecodeLatencyP95Ms: percentile(preloadDecodeLatencyEvents
      .map((entry) => Number(entry.decodeLatencyMs))
      .filter(Number.isFinite), 95),
    wordEvents,
    wordEventsWithComparableTokens,
    wordEventsMissingTokens,
    p95HandoffGapMs: percentile(getChunkHandoffGapsMs(chunkStarts, chunkEnds), 95),
    maxConsecutiveShortChunks: getMaxConsecutiveShortChunks(chunkStarts),
    tokenMismatches: getTokenMismatches(wordEventsWithComparableTokens),
  };
}

export function buildCorpusContentReport({ readerEngineLog = [], gold = null } = {}) {
  const spokenChunks = readerEngineLog
    .filter((entry) => entry.kind === 'chunk_play')
    .sort(compareChunkEvents)
    .map((entry) => ({
      chunkIndex: Number(entry.chunkIndex),
      speechText: String(entry.speechText || ''),
    }));

  const forbiddenSpokenChunks = spokenChunks
    .map((entry) => {
      const speechText = entry.speechText.trim();
      if (!speechText) return null;
      if (isShareWidgetSpeech(speechText)) {
        return { ...entry, reason: 'share-widget-text' };
      }
      if (PRIVATE_USE_CHARACTER_PATTERN.test(speechText)) {
        return { ...entry, reason: 'private-use-glyph' };
      }
      if (!LINGUISTIC_CONTENT_PATTERN.test(stripPrivateUseCharacters(speechText))) {
        return { ...entry, reason: 'symbol-only-text' };
      }
      return null;
    })
    .filter(Boolean);

  const requiredText = Array.isArray(gold?.requiredText)
    ? gold.requiredText.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const spokenText = normalizeContentText(spokenChunks.map((entry) => entry.speechText).join(' '));
  const missingGoldText = requiredText
    .filter((text) => !spokenText.includes(normalizeContentText(text)));
  const goldTextCount = requiredText.length;
  const mainTextRecall = goldTextCount
    ? (goldTextCount - missingGoldText.length) / goldTextCount
    : 1;

  return {
    spokenChunks,
    forbiddenSpokenChunks,
    goldTextCount,
    missingGoldText,
    mainTextRecall,
  };
}

function getChunkHandoffGapsMs(chunkStarts, chunkEnds) {
  const endByChunkIndex = new Map(chunkEnds.map((entry) => [Number(entry.chunkIndex), entry]));
  const firstStartByChunkIndex = new Map();
  for (const start of chunkStarts) {
    const chunkIndex = Number(start.chunkIndex);
    if (!Number.isInteger(chunkIndex)) continue;
    if (!firstStartByChunkIndex.has(chunkIndex)) firstStartByChunkIndex.set(chunkIndex, start);
  }
  const gaps = [];
  for (const [chunkIndex, start] of firstStartByChunkIndex) {
    if (chunkIndex <= 0) continue;
    const previousEnd = endByChunkIndex.get(chunkIndex - 1);
    if (previousEnd) gaps.push(Math.max(0, (getEstimatedAudioStartSeconds(start) - Number(previousEnd.t)) * 1000));
  }
  return gaps.filter(Number.isFinite);
}

function getEstimatedAudioStartSeconds(entry) {
  const eventTime = Number(entry?.t);
  const mediaTime = Number(entry?.mediaTime);
  const playbackRate = Number(entry?.playbackRate);
  if (!Number.isFinite(eventTime)) return Number.NaN;
  if (!Number.isFinite(mediaTime) || mediaTime <= 0) return eventTime;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return eventTime - (mediaTime / rate);
}

function getMaxConsecutiveShortChunks(chunkStarts) {
  let currentRun = 0;
  let maxRun = 0;
  for (const entry of chunkStarts) {
    if (String(entry.speechText || '').trim().length < SHORT_CHUNK_TEXT_LENGTH) {
      currentRun += 1;
      maxRun = Math.max(maxRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return maxRun;
}

function getTokenMismatches(wordEvents) {
  return wordEvents
    .filter((entry) => normalizeToken(entry.speechText) !== normalizeToken(entry.domToken));
}

function compareChunkEvents(a, b) {
  const byIndex = Number(a.chunkIndex) - Number(b.chunkIndex);
  if (byIndex !== 0) return byIndex;
  return Number(a.t) - Number(b.t);
}

function normalizeContentText(value) {
  return stripPrivateUseCharacters(String(value || ''))
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isShareWidgetSpeech(value) {
  const text = stripTerminalPunctuation(stripPrivateUseCharacters(value));
  return isShareWidgetLabel(text) || SHARE_WIDGET_TEXT_PATTERN.test(text);
}

function stripTerminalPunctuation(value) {
  return String(value || '').trim().replace(/[.!?:;]+$/u, '');
}
