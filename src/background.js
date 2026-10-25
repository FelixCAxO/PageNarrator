// @ts-check
import { MESSAGE_TYPES } from './lib/message-types.js';
import { STORAGE_KEYS } from './lib/storage-keys.js';
import { createLogger, createSuppressedErrorHandler } from './lib/logger.js';
import { isTrustedExtensionPage } from './lib/extension-message-security.js';
import { saveReadableTabTarget } from './lib/readable-tab-target.js';
import { removeRetiredVoiceData } from './platform/storage/settings-store.js';
import {
  READER_ENGINE_STATE_KEY,
  sendReaderEngineAction,
} from './lib/reader-engine-host.js';
import {
  asyncResponse,
  createRuntimeMessageHandler,
} from './lib/runtime-message-handlers.js';

const backgroundLogger = createLogger('background');
const suppressBackgroundError = createSuppressedErrorHandler(backgroundLogger, 'Best-effort background operation failed.');
const readerEngineUrl = chrome.runtime.getURL('src/reader-engine.html?engine=1');
const storageAccessReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  // ponytail: retry failed retirement cleanup on worker restart without blocking playback.
  .then(() => removeRetiredVoiceData().catch((error) => {
    backgroundLogger.warn('Retired voice cleanup failed; will retry on background restart.', error);
  }));
void storageAccessReady.catch((error) => backgroundLogger.error('Could not restrict extension storage access.', error));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.storage.local.set({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: true }).catch(suppressBackgroundError);
});

const handleBackgroundMessage = createRuntimeMessageHandler({
  handlers: {
    [MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST]: asyncResponse(handleReaderEngineActionRequest),
    [MESSAGE_TYPES.READER_ENGINE_GET_STATE]: asyncResponse(handleReaderEngineGetState),
    [MESSAGE_TYPES.READER_ENGINE_RPC]: asyncResponse(handleReaderEngineRpc),
  },
  onUnhandled(message) {
    if (message?.type === MESSAGE_TYPES.READER_STATE_CHANGED) {
      const { queue: _queue, transcript: _transcript, ...compactState } = message;
      void chrome.storage.session.set({ [READER_ENGINE_STATE_KEY]: compactState }).catch(suppressBackgroundError);
    }
  },
  onError(error) {
    backgroundLogger.error('PageNarrator background operation failed.', error);
  },
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const page = message?.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST || message?.type === MESSAGE_TYPES.READER_ENGINE_GET_STATE
    ? 'src/popup.html'
    : message?.type === MESSAGE_TYPES.READER_ENGINE_RPC || message?.type === MESSAGE_TYPES.READER_STATE_CHANGED
      ? 'src/reader-engine.html'
      : null;
  if (!page || !isTrustedExtensionPage(sender, chrome.runtime, page)) return false;
  return handleBackgroundMessage(message, sender, sendResponse);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  broadcastReaderEngineEvent('storage.onChanged', changes, areaName);
});
chrome.tabs.onActivated?.addListener((activeInfo) => broadcastReaderEngineEvent('tabs.onActivated', activeInfo));
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => broadcastReaderEngineEvent('tabs.onUpdated', tabId, changeInfo, tab));
chrome.tabs.onRemoved?.addListener((tabId, removeInfo) => broadcastReaderEngineEvent('tabs.onRemoved', tabId, removeInfo));

async function handleReaderEngineActionRequest(message) {
  await storageAccessReady;
  const tab = message?.tab || null;
  if (tab?.id) {
    await saveReadableTabTarget({ storage: chrome.storage.local, tabId: tab.id, tab });
  }
  await sendReaderEngineAction({
    runtime: chrome.runtime,
    offscreen: chrome.offscreen,
    engineUrl: readerEngineUrl,
    action: tab?.id
      ? { ...(typeof message?.action === 'object' ? message.action : { type: message?.action }), tab }
      : message?.action,
  });
  return { ok: true };
}

async function handleReaderEngineGetState() {
  await storageAccessReady;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) return { state: 'idle' };
  const ready = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.READER_ENGINE_PING }).catch(() => null);
  if (ready?.ready !== true) return { state: 'idle' };
  const stored = await chrome.storage.session.get(READER_ENGINE_STATE_KEY);
  return stored?.[READER_ENGINE_STATE_KEY] || { state: 'idle' };
}

async function handleReaderEngineRpc(message, sender) {
  if (!isTrustedExtensionPage(sender, chrome.runtime, 'src/reader-engine.html')) {
    throw new Error('Reader engine request was not trusted.');
  }
  await storageAccessReady;
  const args = Array.isArray(message?.args) ? message.args : [];
  const operations = {
    'storage.local.get': () => chrome.storage.local.get(...args),
    'storage.local.set': () => chrome.storage.local.set(...args),
    'storage.local.remove': () => chrome.storage.local.remove(...args),
    'tabs.query': () => chrome.tabs.query(...args),
    'tabs.get': () => chrome.tabs.get(...args),
    'tabs.sendMessage': () => chrome.tabs.sendMessage(...args),
    'tabs.create': () => chrome.tabs.create(...args),
    'scripting.executeScript': () => chrome.scripting.executeScript(...args),
    'permissions.contains': () => chrome.permissions.contains(...args),
    'permissions.request': () => chrome.permissions.request(...args),
    'windows.getCurrent': () => chrome.windows.getCurrent(...args),
  };
  const operation = Object.hasOwn(operations, message?.operation) ? operations[message.operation] : null;
  if (!operation) throw new Error('Unknown reader engine request.');
  return { ok: true, value: await operation() };
}

function broadcastReaderEngineEvent(event, ...args) {
  void chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.READER_ENGINE_EVENT,
    event,
    args,
  }).catch(suppressBackgroundError);
}
