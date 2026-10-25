export function getChunkSpeechText(chunk) {
  if (typeof chunk === 'string') return chunk;
  return chunk?.speech || chunk?.text || chunk?.preview || '';
}

export function getChunkAnchorText(chunk) {
  if (typeof chunk === 'string') return chunk;
  return chunk?.anchorText ?? chunk?.text ?? chunk?.speech ?? chunk?.preview ?? null;
}

export function getChunkHighlightText(chunk) {
  if (typeof chunk === 'string') return chunk;
  return chunk?.chunkText ?? chunk?.speech ?? chunk?.text ?? chunk?.anchorText ?? chunk?.preview ?? null;
}

export function getChunkDomWordOffset(chunk) {
  if (typeof chunk === 'string') return 0;
  const offset = Number.isFinite(Number(chunk?.globalDomWordStartIndex))
    ? Number(chunk.globalDomWordStartIndex)
    : Number(chunk?.domWordOffset);
  return Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
}

export function getChunkSpeechPrefixWords(chunk) {
  if (typeof chunk === 'string') return 0;
  const value = Number(chunk?.speechPrefixWords);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function createProgressiveSegmentChunk(chunk, segment) {
  const speechWordOffset = Math.max(0, Math.trunc(Number(segment?.speechWordOffset) || 0));
  const speechPrefixWords = getChunkSpeechPrefixWords(chunk);
  const domWordOffset = getChunkDomWordOffset(chunk) + Math.max(0, speechWordOffset - speechPrefixWords);
  const remainingPrefixWords = Math.max(0, speechPrefixWords - speechWordOffset);

  return {
    ...(typeof chunk === 'string' ? {} : chunk),
    speech: segment?.text || getChunkSpeechText(chunk),
    text: segment?.text || getChunkSpeechText(chunk),
    anchorText: getChunkAnchorText(chunk),
    anchorId: typeof chunk === 'string' ? null : chunk?.anchorId ?? null,
    domWordOffset,
    globalDomWordStartIndex: domWordOffset,
    speechPrefixWords: remainingPrefixWords,
    ...(Array.isArray(chunk?.speechWordMap) ? { speechWordMap: chunk.speechWordMap.slice(speechWordOffset) } : {}),
  };
}
