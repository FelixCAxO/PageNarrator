import { MESSAGE_TYPES } from './message-types.js';
import { isTrustedBackgroundSender } from './extension-message-security.js';

const nativeChrome = globalThis.chrome;
const eventListeners = new Map();

function bridgeEvent(name) {
  const listeners = new Set();
  eventListeners.set(name, listeners);
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
  };
}

async function call(operation, ...args) {
  const response = await nativeChrome.runtime.sendMessage({
    type: MESSAGE_TYPES.READER_ENGINE_RPC,
    operation,
    args,
  });
  if (response?.ok === false) throw Object.assign(new Error(response.error || 'Reader engine request failed.'), { code: response.code });
  return response?.value;
}

function installApi(name, value) {
  Object.defineProperty(nativeChrome, name, { configurable: true, value });
}

installApi('storage', {
  local: {
    get: (...args) => call('storage.local.get', ...args),
    set: (...args) => call('storage.local.set', ...args),
    remove: (...args) => call('storage.local.remove', ...args),
  },
  onChanged: bridgeEvent('storage.onChanged'),
});

installApi('tabs', {
  query: (...args) => call('tabs.query', ...args),
  get: (...args) => call('tabs.get', ...args),
  sendMessage: (...args) => call('tabs.sendMessage', ...args),
  create: (...args) => call('tabs.create', ...args),
  onActivated: bridgeEvent('tabs.onActivated'),
  onUpdated: bridgeEvent('tabs.onUpdated'),
  onRemoved: bridgeEvent('tabs.onRemoved'),
});

installApi('scripting', {
  executeScript: (...args) => call('scripting.executeScript', ...args),
});

installApi('permissions', {
  contains: (...args) => call('permissions.contains', ...args),
  request: (...args) => call('permissions.request', ...args),
});

installApi('windows', {
  getCurrent: (...args) => call('windows.getCurrent', ...args),
});

nativeChrome.runtime.onMessage.addListener((message, sender) => {
  if (!isTrustedBackgroundSender(sender, nativeChrome.runtime)) return false;
  if (message?.type !== MESSAGE_TYPES.READER_ENGINE_EVENT) return false;
  for (const listener of eventListeners.get(message.event) || []) listener(...(message.args || []));
  return false;
});
