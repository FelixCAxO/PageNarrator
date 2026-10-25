export function createReadOrchestrator({
  state,
  getChunkWordCount = defaultWordCount,
  getChunkSpeechText = defaultChunkText,
  findStartChunkIndexByText = null,
  compactCompletedPdfChunks = null,
  isStopped = () => false,
} = {}) {
  const readState = state || {};

  return {
    fillChunkBuffer(targetIndex, options = {}) {
      return fillStreamingChunkBuffer({
        state: readState,
        targetIndex,
        getChunkWordCount,
        isStopped: () => isStopped(options),
      });
    },
    async fillStartPositionBuffer(startPosition, options = {}) {
      const startText = typeof findStartChunkIndexByText === 'function' ? String(startPosition?.text || '') : '';
      const anchorId = String(startPosition?.anchorId || '');
      if ((!startText && !anchorId) || !readState.iterator) return null;
      const targetPage = Math.trunc(Number(startPosition.pageNumber));
      const maxExtraChunks = Math.max(0, Math.trunc(Number(options.maxExtraChunks) || 24));
      const batchSize = Math.max(1, Math.trunc(Number(options.batchSize) || 1));
      let loadedAfterStart = 0;
      let checkedCount = 0;
      let anchorFound = false;

      // Only newly loaded chunks are scanned, so long pages stay linear. Text hits on chunks
      // anchored to another element are ignored (a repeated "You said:" label is not the start).
      // An anchor hit keeps loading until that anchor's split speech chunks are complete.
      const hasLoadedStart = () => {
        const chunks = readState.chunks || [];
        const fresh = chunks.slice(checkedCount);
        checkedCount = chunks.length;
        const textCandidates = anchorId
          ? fresh.filter((chunk) => !chunk?.anchorId || chunk.anchorId === anchorId)
          : fresh;
        if (startText && findStartChunkIndexByText(textCandidates, startText) !== -1) return true;
        if (anchorId && fresh.some((chunk) => chunk?.anchorId === anchorId)) anchorFound = true;
        return anchorFound && chunks.at(-1)?.anchorId !== anchorId;
      };

      while (!hasLoadedStart()
        && !isStopped(options)
        && readState.iterator
        && loadedAfterStart < maxExtraChunks) {
        const previousLength = readState.chunks?.length || 0;
        const loaded = await this.fillChunkBuffer(previousLength + Math.min(batchSize, maxExtraChunks - loadedAfterStart) - 1, options);
        if (!loaded || isStopped(options)) return null;
        if ((readState.chunks?.length || 0) <= previousLength) return null;
        loadedAfterStart += (readState.chunks?.length || 0) - previousLength;

        const latestPage = Math.trunc(Number(readState.chunks?.at?.(-1)?.pageNumber));
        if (Number.isFinite(targetPage) && targetPage > 0 && Number.isFinite(latestPage) && latestPage !== targetPage) return null;
      }
      return null;
    },
    getPlaybackTotal(currentIndex = 0) {
      return getPlaybackTotal({
        isStreaming: Boolean(readState.isStreaming ?? readState.iterator),
        hasIterator: Boolean(readState.iterator),
        loadedCount: readState.chunks?.length || 0,
        currentIndex,
      });
    },
    getLoadedChunkText() {
      return getLoadedChunkText(readState.chunks, getChunkSpeechText);
    },
    reset() {
      readState.chunks = [];
      readState.wordCounts = [];
      readState.iterator = null;
    },
    compactPdfChunkHistory(currentIndex, options = {}) {
      if (typeof compactCompletedPdfChunks !== 'function') return readState.chunks;
      const compacted = compactCompletedPdfChunks(readState.chunks, {
        source: readState.articleSource,
        currentIndex,
        ...options,
      });
      readState.chunks = compacted;
      return compacted;
    },
  };
}

export async function fillStreamingChunkBuffer({
  state,
  targetIndex = 0,
  getChunkWordCount = defaultWordCount,
  isStopped = () => false,
} = {}) {
  if (!state || !state.iterator || !Array.isArray(state.chunks)) return false;
  const target = Math.max(0, Math.trunc(Number(targetIndex) || 0));
  state.wordCounts ||= [];

  while (state.chunks.length <= target) {
    if (isStopped()) return false;
    const iterator = state.iterator;
    const deficit = Math.max(1, target - state.chunks.length + 1);
    const result = await iterator.next(deficit);
    if (isStopped() || state.iterator !== iterator) return false;
    if (result?.done) return false;

    const values = Array.isArray(result.value) ? result.value : [result.value];
    for (const value of values) {
      state.chunks.push(value);
      state.wordCounts.push(Math.max(0, Math.trunc(Number(getChunkWordCount(value)) || 0)));
    }
  }

  return true;
}

export function getPlaybackTotal({
  isStreaming = false,
  hasIterator = false,
  loadedCount = 0,
  currentIndex = 0,
} = {}) {
  const loaded = Math.max(0, Math.trunc(Number(loadedCount) || 0));
  if (!isStreaming || !hasIterator) return loaded;
  const current = Math.max(0, Math.trunc(Number(currentIndex) || 0));
  return Math.max(loaded, current + 1);
}

export function resolveReadCleanupDisposition({
  stoppedRun = false,
  releaseReadSessionAfterCleanup = false,
  readingState = '',
} = {}) {
  const releaseBuffers = Boolean(stoppedRun || releaseReadSessionAfterCleanup || readingState === 'finished');
  const resetState = Boolean(stoppedRun || releaseReadSessionAfterCleanup);
  return { releaseBuffers, resetState };
}

export function resolveInitialReadPosition({
  savedChunkIndex = null,
  resumeConfirmed = false,
  isSelectionRead = false,
  isStreaming = false,
  shouldUseTopStart = false,
  fallbackIndex = 0,
} = {}) {
  const saved = Number(savedChunkIndex);
  const canResume = Number.isInteger(saved)
    && saved > 0
    && !isSelectionRead
    && !isStreaming
    && !shouldUseTopStart;

  if (!canResume) {
    return { action: 'startAtIndex', index: Math.max(0, Math.trunc(Number(fallbackIndex) || 0)) };
  }
  if (!resumeConfirmed) return { action: 'promptResume', index: saved };
  return { action: 'startAtIndex', index: saved };
}

function defaultWordCount(chunk) {
  return String(defaultChunkText(chunk))
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function defaultChunkText(chunk) {
  return String(chunk?.speech || chunk?.text || chunk?.preview || chunk || '');
}

function getLoadedChunkText(chunks = [], getChunkSpeechText = defaultChunkText) {
  return chunks.map((chunk) => getChunkSpeechText(chunk)).filter(Boolean).join(' ');
}
