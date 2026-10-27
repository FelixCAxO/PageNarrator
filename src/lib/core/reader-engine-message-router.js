import { MESSAGE_TYPES, READER_ACTION_TYPES } from '../message-types.js';
import { PDF_VIEWER_MESSAGE_TIMEOUT_MS } from '../timing-config.js';
import {
  createRuntimeMessageHandler,
  fireAndForget,
} from '../runtime-message-handlers.js';

const PDF_VIEWER_READY_RETRY_OPTIONS = Object.freeze({ attempts: 30, delayMs: 100 });
const PDF_VIEWER_CHUNK_RETRY_OPTIONS = Object.freeze({ attempts: 3, delayMs: 80 });

/**
 * @param {{
 *   tabs?: { sendMessage?: Function },
 *   actions?: Record<string, Function>,
 *   getPlaybackSpeed?: () => number,
 *   delay?: (ms: number) => Promise<void>,
 * }} options
 */
export function createReaderEngineMessageRouter({
  tabs = null,
  actions = {},
  getPlaybackSpeed = () => 1,
  delay = defaultDelay,
} = {}) {
  const runtimeMessageHandler = createRuntimeMessageHandler({
    handlers: {
      [MESSAGE_TYPES.READER_ENGINE_ACTION]: fireAndForget((message) => handleFloatingReaderAction(message.action)),
    },
  });

  async function sendPageMessage(tabId, message, { attempts = 3, delayMs = 80, timeoutMs = 0 } = {}) {
    if (!tabId) return null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await withMessageTimeout(tabs.sendMessage(tabId, message), timeoutMs, message?.type);
      } catch {
        if (attempt === attempts - 1) return null;
        await delay(delayMs);
      }
    }
    return null;
  }

  function sendPdfViewerMessage(tabId, message, options = {}) {
    return sendPageMessage(tabId, message, {
      ...getPdfViewerRetryOptions(message),
      timeoutMs: PDF_VIEWER_MESSAGE_TIMEOUT_MS,
      ...options,
    });
  }

  function handleRuntimeMessage(message) {
    return runtimeMessageHandler(message, {}, () => {});
  }

  function handleFloatingReaderAction(actionValue) {
    const action = normalizeReaderAction(actionValue);
    if (!action) return;

    if (action.type === READER_ACTION_TYPES.TOGGLE_PLAYBACK) actions.handlePrimaryAction?.({ resumeConfirmed: true, tab: action.tab });
    if (action.type === READER_ACTION_TYPES.READ_SELECTED) actions.handleReadSelectedAction?.({ tab: action.tab });
    if (action.type === READER_ACTION_TYPES.READ_FROM_START) actions.handleReadFromStartAction?.({ tab: action.tab });
    if (action.type === READER_ACTION_TYPES.STOP) actions.stopReading?.();
    if (action.type === READER_ACTION_TYPES.NEXT) actions.skipToNextChunk?.();
    if (action.type === READER_ACTION_TYPES.PREVIOUS) actions.skipToPreviousChunk?.();
    if (action.type === READER_ACTION_TYPES.SET_SPEED) actions.setPlaybackSpeed?.(action.speed);
    if (action.type === READER_ACTION_TYPES.ADJUST_SPEED) {
      actions.setPlaybackSpeed?.(getPlaybackSpeed() + Number(action.delta || 0));
    }
    if (action.type === READER_ACTION_TYPES.SET_SECTION_PAUSE) {
      actions.setSectionPause?.(action.sectionPauseSeconds);
    }
    if (action.type === READER_ACTION_TYPES.JUMP_TO_CHUNK) actions.requestJump?.(action.index);
    if (action.type === READER_ACTION_TYPES.SYNC_STATE) actions.syncPlayerState?.(action);
    if (action.type === READER_ACTION_TYPES.PREPARE_VOICE) actions.prepareVoice?.();
  }

  return {
    sendPageMessage,
    sendPdfViewerMessage,
    handleRuntimeMessage,
    handleFloatingReaderAction,
  };
}

function getPdfViewerRetryOptions(message) {
  return message?.type === MESSAGE_TYPES.GET_PDF_CHUNK
    ? PDF_VIEWER_CHUNK_RETRY_OPTIONS
    : PDF_VIEWER_READY_RETRY_OPTIONS;
}

export function normalizeReaderAction(action) {
  if (!action) return null;
  if (typeof action === 'string') return { type: action };
  if (typeof action === 'object' && typeof action.type === 'string') return action;
  return null;
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withMessageTimeout(promise, timeoutMs, messageType = 'message') {
  const timeout = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  if (timeout <= 0) return Promise.resolve(promise);

  let timeoutId = null;
  const source = Promise.resolve(promise);
  void source.catch(() => null);
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Page message ${messageType} timed out after ${timeout} ms.`);
      error.code = 'page_message_timeout';
      reject(error);
    }, timeout);
  });

  return Promise.race([source, deadline]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}
