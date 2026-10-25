import {
  getChunkAnchorText,
  getChunkDomWordOffset,
  getChunkHighlightText,
} from './reader-engine-chunks.js';
import { MESSAGE_TYPES } from './message-types.js';

/** @param {any} [deps] */
export function createReaderEnginePageHighlightController({
  sendPageMessage,
  getSelectedHighlightSettings = () => null,
} = {}) {
  const getHighlightSettings = () => getSelectedHighlightSettings();

  async function highlightChunk(tabId, chunk) {
    return sendPageMessage(tabId, createChunkHighlightMessage(MESSAGE_TYPES.HIGHLIGHT_CHUNK, chunk, {
      highlightSettings: getHighlightSettings(),
    }));
  }

  async function highlightQueuedChunk(tabId, chunk) {
    if (!chunk) return;
    await sendPageMessage(tabId, createChunkHighlightMessage(MESSAGE_TYPES.HIGHLIGHT_QUEUED, chunk, {
      highlightSettings: getHighlightSettings(),
    }));
  }

  async function flashResumeSection(tabId, chunk) {
    if (!chunk) return;
    await sendPageMessage(tabId, createChunkHighlightMessage(MESSAGE_TYPES.FLASH_RESUME_SECTION, chunk, {
      durationMs: 1500,
      highlightSettings: getHighlightSettings(),
    }));
  }

  async function setPageHighlightPaused(paused, tabId) {
    await sendPageMessage(tabId, { type: MESSAGE_TYPES.SET_HIGHLIGHT_PAUSED, paused });
  }

  async function clearPageHighlight(tabId) {
    await sendPageMessage(tabId, { type: MESSAGE_TYPES.CLEAR_HIGHLIGHT });
  }

  function shouldSyncPageHighlights(article) {
    return Boolean(article);
  }

  return {
    clearPageHighlight,
    flashResumeSection,
    highlightChunk,
    highlightQueuedChunk,
    setPageHighlightPaused,
    shouldSyncPageHighlights,
  };
}

function createChunkHighlightMessage(type, chunk, extra = {}) {
  return {
    type,
    text: getChunkAnchorText(chunk),
    chunkText: getChunkHighlightText(chunk),
    domWordOffset: getChunkDomWordOffset(chunk),
    anchorId: typeof chunk === 'string' ? null : chunk?.anchorId ?? null,
    ...(chunk?.pdfNarration ? { pdfNarration: chunk.pdfNarration } : {}),
    ...(chunk?.type === 'pdf-selection' ? { pdfSelection: true } : {}),
    ...extra,
  };
}
