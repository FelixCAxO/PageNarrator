// @ts-check
import { createPageHighlighter } from '../../lib/page-highlighter.js';
import { MESSAGE_TYPES } from '../../lib/message-types.js';
import { createFlowRecorder, getFlowLog } from '../../lib/flow-recorder.js';

let testRecordFlowEnabled = false;
const flowRecorder = createFlowRecorder({
  enabled: () => testRecordFlowEnabled,
  target: window,
});

const pageHighlighter = createPageHighlighter(document, {
  flowRecorder,
  strictWordPlan: () => testRecordFlowEnabled,
});

export async function handleHighlightMessage(msg) {
  // The content listener accepts these settings only from the reader engine or
  // its background relay; content scripts do not need extension storage access.
  if (typeof msg?.contentDiagnostics?.recordFlow === 'boolean') {
    testRecordFlowEnabled = msg.contentDiagnostics.recordFlow;
  }

  if (msg?.type === MESSAGE_TYPES.SET_HIGHLIGHT_SETTINGS) {
    return { ok: true, highlight: pageHighlighter.setHighlightSettings(msg.highlightSettings) };
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_CHUNK) {
    if (msg.highlightSettings) pageHighlighter.setHighlightSettings(msg.highlightSettings);
    return pageHighlighter.highlightChunkByAnchor(msg.anchorId, msg.text, {
      chunkText: msg.chunkText,
      domWordOffset: msg.domWordOffset,
    });
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_QUEUED) {
    if (msg.highlightSettings) pageHighlighter.setHighlightSettings(msg.highlightSettings);
    return pageHighlighter.highlightQueuedChunkByAnchor(msg.anchorId, msg.text, {
      chunkText: msg.chunkText,
      domWordOffset: msg.domWordOffset,
    });
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_WORD) {
    return pageHighlighter.highlightWord(msg.index, msg.trailLength, {
      chunkIndex: msg.chunkIndex,
      wordIndex: msg.wordIndex,
      mediaTime: msg.mediaTime,
      speechText: msg.speechText,
    });
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_WORD_PLAN) {
    return pageHighlighter.highlightWordPlan(msg.plan, {
      currentTime: msg.currentTime,
      playbackRate: msg.playbackRate,
      paused: msg.paused,
      sentAtEpochMs: msg.sentAtEpochMs,
      leadSeconds: msg.leadSeconds,
      fadeMs: msg.fadeMs,
      recordImmediately: testRecordFlowEnabled,
    });
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_PLAN_RESYNC) {
    return pageHighlighter.resyncWordPlan({
      currentTime: msg.currentTime,
      playbackRate: msg.playbackRate,
      paused: msg.paused,
      sentAtEpochMs: msg.sentAtEpochMs,
    });
  }

  if (msg?.type === MESSAGE_TYPES.GET_FLOW_LOG) {
    return { ok: true, log: getFlowLog(window) };
  }

  if (msg?.type === MESSAGE_TYPES.FLASH_RESUME_SECTION) {
    if (msg.highlightSettings) pageHighlighter.setHighlightSettings(msg.highlightSettings);
    return pageHighlighter.flashResumeSectionByAnchor(msg.anchorId, msg.text, {
      chunkText: msg.chunkText,
      domWordOffset: msg.domWordOffset,
      durationMs: msg.durationMs,
    });
  }

  if (msg?.type === MESSAGE_TYPES.HIGHLIGHT_SYNTHETIC_SPEECH) {
    return pageHighlighter.highlightSyntheticSpeech();
  }

  if (msg?.type === MESSAGE_TYPES.SET_HIGHLIGHT_PAUSED) {
    return pageHighlighter.setPaused(msg.paused);
  }

  if (msg?.type === MESSAGE_TYPES.CLEAR_HIGHLIGHT) {
    pageHighlighter.clearHighlights();
    return { ok: true };
  }

  return { ok: false };
}
