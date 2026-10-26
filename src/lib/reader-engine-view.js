import { t } from './i18n.js';
import { getPdfReadingProgress } from './pdf-reading-progress.js';
const WORDS_PER_MINUTE = 155;
// Also the reader engine's title before extraction; the popup treats it as "no title yet".
export const DEFAULT_TITLE = t("No page loaded");
const DEFAULT_PREVIEW = t("Text appears when reading starts.");
const DEFAULT_TRANSCRIPT = t("Transcript appears when text loads.");
const DEFAULT_TRANSCRIPT_WINDOW_LIMIT = 30;
const DEFAULT_QUEUE_WINDOW_SIZE = 10;
const MAX_QUEUE_SEARCH_CACHE_ENTRIES = 100;
const wordCountSummaryCache = new WeakMap();
const queueSearchCache = new WeakMap();

export function formatSetupDuration(seconds) {
  const safeSeconds = Math.max(1, Math.round(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (minutes < 60) return remainingSeconds ? t("$1m $2s", [minutes, remainingSeconds]) : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? t("$1h $2m", [hours, remainingMinutes]) : `${hours}h`;
}

export function getPanelView(reading = {}) {
  const state = reading.state || 'idle';
  const pdfProgress = reading.source === 'pdf' && !reading.totalReadableWordCount
    ? getPdfReadingProgress(reading) : null;
  const readingCopy = getReadingCopy(reading.source);
  const modelSetup = reading.modelSetup || {};
  const view = {
    subtitle: t("Read this page aloud"),
    statusText: t("Ready to read"),
    statusTone: 'ready',
    mode: 'idle',
    isError: false,
    primaryAction: { label: t("Read page"), disabled: false },
    secondaryActions: [],
    progressPercent: 0,
    progressLabel: t("0% complete"),
    remainingLabel: '',
  };

  if (state === 'idle' && modelSetup.phase === 'loading') {
    const progress = clampPercent(modelSetup.progress);
    const eta = normalizeEta(modelSetup.eta);
    return {
      ...view,
      statusText: t("Preparing voice - $1%$2", [progress, eta ? `, ${eta}` : '']),
      statusTone: 'preparing',
      primaryAction: { label: t("Preparing voice..."), disabled: true },
    };
  }

  if (state === 'preparing') {
    return {
      ...view,
      subtitle: readingCopy.preparingSubtitle,
      statusText: readingCopy.preparingStatus,
      statusTone: 'preparing',
      primaryAction: { label: t("Preparing voice..."), disabled: true },
    };
  }

  if (state === 'stopping') {
    return {
      ...view,
      subtitle: t("Stopping current read"),
      statusText: t("Stopping read..."),
      statusTone: 'preparing',
      primaryAction: { label: t('Stopping...'), disabled: true },
    };
  }

  if (state === 'reading') {
    const progressPercent = getReadProgress(reading.currentChunk, reading.totalChunks, reading.wordCounts, reading.totalReadableWordCount);
    return {
      ...view,
      subtitle: readingCopy.readingSubtitle,
      statusText: readingCopy.readingStatus,
      statusTone: 'reading',
      mode: 'reading',
      primaryAction: { label: t("Pause"), disabled: false },
      secondaryActions: [{ id: 'stop', label: t("Stop") }],
      progressPercent,
      progressLabel: t("$1% complete", [progressPercent]),
      remainingLabel: getRemainingLabel(reading.currentChunk, reading.totalChunks, reading.wordCounts, reading.totalReadableWordCount),
      ...pdfProgress,
    };
  }

  if (state === 'paused') {
    const progressPercent = getReadProgress(reading.currentChunk, reading.totalChunks, reading.wordCounts, reading.totalReadableWordCount);
    return {
      ...view,
      subtitle: readingCopy.pausedSubtitle,
      statusText: t("Paused"),
      statusTone: 'paused',
      mode: 'reading',
      primaryAction: { label: t("Resume"), disabled: false },
      secondaryActions: [{ id: 'stop', label: t("Stop") }],
      progressPercent,
      progressLabel: t("$1% complete", [progressPercent]),
      remainingLabel: getRemainingLabel(reading.currentChunk, reading.totalChunks, reading.wordCounts, reading.totalReadableWordCount),
      ...pdfProgress,
    };
  }

  if (state === 'finished') {
    return {
      ...view,
      statusText: t("Finished reading"),
      statusTone: 'ready',
      primaryAction: { label: t("Read again"), disabled: false },
      progressPercent: 100,
      progressLabel: t("100% complete"),
    };
  }

  if (state === 'error') {
    const primaryAction = getErrorPrimaryAction(reading.errorCode);
    return {
      ...view,
      statusText: reading.message || t("Something went wrong"),
      statusTone: 'error',
      isError: true,
      primaryAction,
    };
  }

  return view;
}

function getErrorPrimaryAction(errorCode) {
  if (errorCode === 'article_text_not_found' || errorCode === 'empty_selection') {
    return { label: t("Read selected"), disabled: false, action: 'read-selected' };
  }
  return { label: t("Try again"), disabled: false, action: 'try-again' };
}

function getReadingCopy(source) {
  if (source === 'selection') {
    return {
      readingSubtitle: t("Reading selected text"),
      readingStatus: t("Reading selected text..."),
      preparingSubtitle: t("Preparing selected text"),
      preparingStatus: t("Preparing selected text"),
      pausedSubtitle: t("Selected text paused"),
    };
  }

  return {
    readingSubtitle: t("Reading current page"),
    readingStatus: t("Reading page..."),
    preparingSubtitle: t("Preparing current page"),
    preparingStatus: t("Preparing voice"),
    pausedSubtitle: t("Reading paused"),
  };
}

export function getSetupView(setup = {}) {
  const phase = setup.phase || 'idle';
  if (phase === 'ready') {
    return {
      visible: false,
      compactText: t("Voice ready"),
    };
  }

  if (phase === 'error') {
    return {
      visible: true,
      isError: true,
      title: t("Voice setup failed"),
      progressPercent: clampPercent(setup.progress),
      detail: setup.detail || t("Model setup failed."),
      eta: setup.eta || t("Try again"),
    };
  }

  if (phase !== 'loading') {
    return { visible: false };
  }

  return {
    visible: true,
    title: t("Preparing voice"),
    progressPercent: clampPercent(setup.progress),
    detail: setup.detail || t("Preparing local voice; missing files download from Hugging Face."),
    eta: setup.eta || t("Estimating time..."),
  };
}

export function createArticleSummary(article = {}) {
  const title = normalizeSpace(article.title) || DEFAULT_TITLE;
  const text = getSummaryText(article);
  const wordCount = countWords(text);
  const modeLabel = getContentModeLabel(article.source);

  if (!text) {
    return {
      title,
      modeLabel,
      wordCount: 0,
      minutes: 0,
      metaText: t("Open an article, then read the page"),
      previewText: DEFAULT_PREVIEW,
    };
  }

  const minutes = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));

  return {
    title,
    modeLabel,
    wordCount,
    minutes,
    metaText: `${wordCount === 1 ? t('$1 word', [wordCount]) : t('$1 words', [wordCount])} · ~${minutes} ${t('min')}`,
    previewText: firstSentences(text),
  };
}

function getSummaryText(article = {}) {
  const text = normalizeSpace(article.text);
  if (text) return text;
  if (!Array.isArray(article.chunks)) return '';
  return normalizeSpace(article.chunks
    .map((chunk) => chunk?.speech ?? chunk?.text ?? '')
    .filter(Boolean)
    .join(' '));
}

export function createTranscriptWindow(text, { limit = DEFAULT_TRANSCRIPT_WINDOW_LIMIT } = {}) {
  const safeLimit = normalizePositiveInteger(limit, DEFAULT_TRANSCRIPT_WINDOW_LIMIT);
  const result = collectParagraphWindow(text, safeLimit);
  const paragraphs = result.totalCount ? result.paragraphs : [DEFAULT_TRANSCRIPT];
  const totalCount = result.totalCount || 1;
  const visibleCount = paragraphs.length;
  const isLimited = totalCount > visibleCount;

  return {
    paragraphs,
    totalCount,
    visibleCount,
    isLimited,
    countLabel: formatParagraphCount(totalCount, visibleCount, isLimited),
  };
}

export function createReadingQueueWindow(chunks = [], currentChunk = 0, { windowSize = DEFAULT_QUEUE_WINDOW_SIZE, query = '' } = {}) {
  const totalCount = Array.isArray(chunks) ? chunks.length : 0;
  if (!totalCount) {
    return {
      items: [],
      totalCount: 0,
      visibleCount: 0,
      startNumber: 0,
      endNumber: 0,
      isLimited: false,
      countLabel: t("0 sections"),
    };
  }

  const normalizedQuery = normalizeSpace(query).toLowerCase();
  if (normalizedQuery) {
    const safeCurrent = Number.isFinite(currentChunk) ? Math.max(0, Math.trunc(currentChunk)) : 0;
    const records = getQueueSearchRecords(chunks, normalizedQuery);
    const items = records.map((record) => createQueueItemFromSearchRecord(record, safeCurrent));
    const visibleCount = items.length;
    return {
      items,
      totalCount,
      visibleCount,
      startNumber: items[0]?.number || 0,
      endNumber: items.at(-1)?.number || 0,
      isLimited: false,
      countLabel: formatMatchCount(visibleCount, totalCount),
    };
  }

  const safeWindowSize = Math.min(totalCount, normalizePositiveInteger(windowSize, DEFAULT_QUEUE_WINDOW_SIZE));
  const safeCurrent = Number.isFinite(currentChunk) ? Math.max(0, Math.trunc(currentChunk)) : 0;
  const centerIndex = Math.min(safeCurrent, totalCount - 1);
  const maxStart = Math.max(0, totalCount - safeWindowSize);
  const preferredStart = centerIndex - Math.floor((safeWindowSize - 1) / 2);
  const startIndex = Math.max(0, Math.min(maxStart, preferredStart));
  const endIndex = Math.min(totalCount, startIndex + safeWindowSize);
  const items = chunks
    .slice(startIndex, endIndex)
    .map((chunk, index) => createQueueItem(chunk, startIndex + index, safeCurrent));
  const visibleCount = items.length;
  const isLimited = visibleCount < totalCount;

  return {
    items,
    totalCount,
    visibleCount,
    startNumber: startIndex + 1,
    endNumber: endIndex,
    isLimited,
    countLabel: formatSectionCount(totalCount, startIndex + 1, endIndex, isLimited),
  };
}

export function getChunkWordCounts(chunks = []) {
  return chunks.map((chunk) => {
    const compactWordCount = Number(typeof chunk === 'string' ? Number.NaN : chunk?.wordCount);
    if (Number.isFinite(compactWordCount) && compactWordCount >= 0) return Math.trunc(compactWordCount);
    return countWords(getChunkDisplayText(chunk));
  });
}

export function getTotalChunkWordCount(chunks = []) {
  return getChunkWordCounts(chunks).reduce((total, count) => total + count, 0);
}

export function createResumePrompt(saved = null) {
  if (!saved) return { visible: false };
  const chunk = Number(saved.chunk);
  const totalChunks = Number(saved.totalChunks);
  if (!Number.isFinite(chunk) || !Number.isFinite(totalChunks) || chunk <= 0 || chunk >= totalChunks) {
    return { visible: false };
  }

  const progressPercent = clampPercent(Number(saved.progressPercent));
  const title = normalizeSpace(saved.title);
  const sectionLabel = t("Section $1 of $2", [Math.trunc(chunk) + 1, Math.trunc(totalChunks)]);
  return {
    visible: true,
    title: t("Resume at $1%", [progressPercent]),
    detail: title ? `${title} · ${sectionLabel}` : sectionLabel,
    excerpt: normalizeSpace(saved.excerpt),
  };
}

export function getWeightedProgress(currentChunk, wordCounts = []) {
  const summary = getWordCountSummary(wordCounts);
  if (!summary?.length) return 0;
  const total = summary.total || 1;
  const current = Number.isFinite(currentChunk) ? Math.max(0, Math.trunc(currentChunk)) : 0;
  const done = summary.prefix[Math.min(current, summary.length)] || 0;
  return clampPercent((done / total) * 100);
}

export function getContentModeLabel(source) {
  if (source === 'selection') return t("Selected text");
  if (source === 'pdf') return t("PDF document");
  if (source === 'fallback') return t("Full page");
  return t("Article only");
}

function getReadProgress(currentChunk, totalChunks, wordCounts = null, totalReadableWordCount = 0) {
  const totalWords = Math.max(0, Math.trunc(Number(totalReadableWordCount) || 0));
  if (totalWords > 0) return clampPercent((getCompletedWordCount(currentChunk, wordCounts) / totalWords) * 100);
  if (hasUsableWordCounts(wordCounts, totalChunks)) return getWeightedProgress(currentChunk, wordCounts);
  if (!Number.isFinite(totalChunks) || totalChunks <= 0) return 0;
  const current = Number.isFinite(currentChunk) ? currentChunk : 0;
  return clampPercent((current / totalChunks) * 100);
}

function getRemainingLabel(currentChunk, totalChunks, wordCounts = null, totalReadableWordCount = 0) {
  const totalWords = Math.max(0, Math.trunc(Number(totalReadableWordCount) || 0));
  if (totalWords > 0) {
    const remainingWords = Math.max(0, totalWords - getCompletedWordCount(currentChunk, wordCounts));
    return remainingWords === 1 ? t('$1 word left', [remainingWords]) : t('$1 words left', [remainingWords]);
  }
  if (!Number.isFinite(totalChunks) || totalChunks <= 0) return '';
  const current = Number.isFinite(currentChunk) ? currentChunk : 0;
  if (hasUsableWordCounts(wordCounts, totalChunks)) {
    const summary = getWordCountSummary(wordCounts);
    const currentIndex = Math.min(Math.max(0, Math.trunc(current)), summary.length);
    const remainingWords = Math.max(0, summary.total - summary.prefix[currentIndex]);
    return remainingWords === 1 ? t('$1 word left', [remainingWords]) : t('$1 words left', [remainingWords]);
  }
  const remaining = Math.max(0, totalChunks - current);
  return remaining === 1 ? t('$1 chunk left', [remaining]) : t('$1 chunks left', [remaining]);
}

function getCompletedWordCount(currentChunk, wordCounts) {
  const summary = getWordCountSummary(wordCounts);
  if (!summary) return 0;
  const current = Number.isFinite(currentChunk) ? Math.max(0, Math.trunc(currentChunk)) : 0;
  return summary.prefix[Math.min(current, summary.length)] || 0;
}

function hasUsableWordCounts(wordCounts, totalChunks) {
  const summary = getWordCountSummary(wordCounts);
  return Boolean(summary)
    && summary.length === totalChunks
    && summary.hasPositive;
}

function getWordCountSummary(wordCounts) {
  if (!Array.isArray(wordCounts)) return null;
  const cached = wordCountSummaryCache.get(wordCounts);
  if (cached && cached.length === wordCounts.length) return cached;

  let total = 0;
  let hasPositive = false;
  let prefix = [0];
  let startIndex = 0;

  if (cached && cached.length < wordCounts.length && Array.isArray(cached.prefix) && cached.prefix.length === cached.length + 1) {
    total = cached.total;
    hasPositive = cached.hasPositive;
    prefix = cached.prefix.slice();
    startIndex = cached.length;
  }

  for (let index = startIndex; index < wordCounts.length; index += 1) {
    const safeCount = Math.max(0, Number(wordCounts[index]) || 0);
    if (safeCount > 0) hasPositive = true;
    total += safeCount;
    prefix.push(total);
  }

  const summary = {
    length: wordCounts.length,
    total,
    prefix,
    hasPositive,
  };
  wordCountSummaryCache.set(wordCounts, summary);
  return summary;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeEta(value) {
  const text = normalizeSpace(value);
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

function countWords(text) {
  return normalizeSpace(text).split(/\s+/).filter(Boolean).length;
}

function collectParagraphWindow(text, limit) {
  const value = String(text || '');
  const separator = /\n{2,}/g;
  const paragraphs = [];
  let totalCount = 0;
  let start = 0;

  for (const match of value.matchAll(separator)) {
    totalCount += collectParagraph(value.slice(start, match.index), paragraphs, limit);
    start = match.index + match[0].length;
  }
  totalCount += collectParagraph(value.slice(start), paragraphs, limit);

  return { paragraphs, totalCount };
}

function collectParagraph(raw, paragraphs, limit) {
  const paragraph = normalizeSpace(raw);
  if (!paragraph) return 0;
  if (paragraphs.length < limit) paragraphs.push(paragraph);
  return 1;
}

function createQueueItem(chunk, index, safeCurrent) {
  const pageNumber = typeof chunk === 'string' ? null : chunk?.pageNumber;
  const text = firstSentences(getChunkDisplayText(chunk));
  const item = {
    number: index + 1,
    text: Number.isFinite(pageNumber) ? t("Page $1 · $2", [pageNumber, text]) : text,
    state: index < safeCurrent ? 'done' : index === safeCurrent ? 'current' : 'upcoming',
  };
  if (Number.isFinite(pageNumber)) item.pageNumber = pageNumber;
  return item;
}

function createQueueItemFromSearchRecord(record, safeCurrent) {
  const item = {
    number: record.index + 1,
    text: record.text,
    state: record.index < safeCurrent ? 'done' : record.index === safeCurrent ? 'current' : 'upcoming',
  };
  if (Number.isFinite(record.pageNumber)) item.pageNumber = record.pageNumber;
  return item;
}

function getQueueSearchRecords(chunks, query) {
  let queryCache = queueSearchCache.get(chunks);
  if (!queryCache || queryCache._chunksLength !== chunks.length) {
    queryCache = new Map();
    queryCache._chunksLength = chunks.length;
    queueSearchCache.set(chunks, queryCache);
  }
  if (queryCache.has(query)) {
    const cached = queryCache.get(query);
    queryCache.delete(query);
    queryCache.set(query, cached);
    return cached;
  }

  const records = [];
  chunks.forEach((chunk, index) => {
    const pageNumber = typeof chunk === 'string' ? null : chunk?.pageNumber;
    const text = firstSentences(getChunkDisplayText(chunk));
    const displayText = Number.isFinite(pageNumber) ? t("Page $1 · $2", [pageNumber, text]) : text;
    const record = { index, text: displayText, pageNumber };
    if (queueSearchRecordMatches(record, query)) records.push(record);
  });

  queryCache.set(query, records);
  evictOldQueueSearchRecords(queryCache);
  return records;
}

function evictOldQueueSearchRecords(queryCache) {
  while (queryCache.size > MAX_QUEUE_SEARCH_CACHE_ENTRIES) {
    const oldestKey = queryCache.keys().next().value;
    queryCache.delete(oldestKey);
  }
}

function getChunkDisplayText(chunk) {
  return typeof chunk === 'string' ? chunk : chunk?.speech || chunk?.text || chunk?.preview || '';
}

function queueSearchRecordMatches(record, query) {
  const text = normalizeSpace(record.text).toLowerCase();
  if (text.includes(query)) return true;
  if (Number.isFinite(record.pageNumber)) {
    const page = String(Math.trunc(record.pageNumber));
    return query === page || query === t("page $1", [page]);
  }
  return false;
}

function formatParagraphCount(totalCount, visibleCount, isLimited) {
  const count = totalCount === 1 ? t('$1 paragraph', [totalCount]) : t('$1 paragraphs', [totalCount]);
  return isLimited
    ? t('$1 · first $2 shown', [count, visibleCount])
    : count;
}

function formatSectionCount(totalCount, startNumber, endNumber, isLimited) {
  const count = totalCount === 1 ? t('$1 section', [totalCount]) : t('$1 sections', [totalCount]);
  return isLimited
    ? t('$1 · $2-$3 shown', [count, startNumber, endNumber])
    : count;
}

function formatMatchCount(matchCount, totalCount) {
  const matches = matchCount === 1 ? t('$1 match', [matchCount]) : t('$1 matches', [matchCount]);
  const sections = totalCount === 1 ? t('$1 section', [totalCount]) : t('$1 sections', [totalCount]);
  return t('$1 of $2', [matches, sections]);
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

function firstSentences(text) {
  const value = normalizeSpace(text);
  if (value.length <= 220) return value;

  const sentenceMatch = value.slice(0, 260).match(/^(.+?[.!?])\s/);
  if (sentenceMatch?.[1]?.length >= 80) return sentenceMatch[1];
  return `${value.slice(0, 217).trim()}...`;
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {any} els @param {any} setup */
export function renderModelSetupElements(els, setup) {
  const view = getSetupView(setup);
  if (!els.setup) return;
  els.setup.hidden = !view.visible;
  if (els.voiceReady) els.voiceReady.hidden = !view.compactText;
  if (view.compactText && els.voiceReady) els.voiceReady.textContent = t("$1 - cached for next time", [view.compactText]);
  if (!view.visible) return;
  els.setup.classList?.toggle?.('is-error', Boolean(view.isError));
  if (els.setupTitle) els.setupTitle.textContent = view.title;
  if (els.setupBar) els.setupBar.style.width = `${view.progressPercent}%`;
  if (els.setupLabel) els.setupLabel.textContent = `${Math.round(view.progressPercent)}%`;
  els.setupProgress?.setAttribute?.('aria-valuenow', String(Math.round(view.progressPercent)));
  if (els.setupDetail) els.setupDetail.textContent = view.detail;
  if (els.setupEta) els.setupEta.textContent = view.eta;
}

/** @param {any} event @param {Map<string, any>} downloads */
export function getModelDownloadProgress(event, downloads) {
  if (!['download', 'progress', 'done'].includes(event?.status) || !Number.isFinite(event?.loaded)
    || !Number.isFinite(event?.total) || event.total <= 0) return null;
  downloads.set(event.file || event.name || t("voice model"), { loaded: event.loaded, total: event.total, verified: event.status === 'done' });
  const files = [...downloads.values()];
  const loaded = files.reduce((sum, file) => sum + file.loaded, 0), total = files.reduce((sum, file) => sum + file.total, 0);
  const file = String(event.file || event.name || t("voice model")).split('/').pop();
  const amount = (loaded, total) => t("$1 / $2 MB", [(loaded / 1_000_000).toFixed(1), (total / 1_000_000).toFixed(1)]);
  return { progress: 5 + Math.round(85 * loaded / total), detail: event.status === 'done'
    ? files.every(file => file.verified) ? t("Verified $1. Preparing voice…", [file]) : t("Downloading voice files: $1", [amount(loaded, total)])
    : t("Downloading $1: $2", [file, amount(event.loaded, event.total)]) };
}
