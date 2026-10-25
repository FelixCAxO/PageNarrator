import { createMemoryStorage } from './storage-mocks.js';

export function createChromeEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    dispatch(...args) {
      return [...listeners].map((listener) => listener(...args));
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

export function createChromeStorageArea(initial = {}) {
  const storage = createMemoryStorage(initial);
  return {
    ...storage,
    values: storage.data,
  };
}

export function createChromeMock({ storage = {} } = {}) {
  const runtimeOnMessage = createChromeEvent();
  const storageOnChanged = createChromeEvent();
  const tabsOnActivated = createChromeEvent();
  const tabsOnUpdated = createChromeEvent();
  const tabsOnRemoved = createChromeEvent();
  const commandsOnCommand = createChromeEvent();
  const alarmsOnAlarm = createChromeEvent();

  return {
    runtime: {
      id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      sendMessage: async () => ({}),
      onMessage: runtimeOnMessage,
      onInstalled: createChromeEvent(),
    },
    storage: {
      local: createChromeStorageArea(storage),
      onChanged: storageOnChanged,
    },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id }),
      create: async (tab) => tab,
      update: async (id, tab) => ({ id, ...tab }),
      sendMessage: async () => ({}),
      onActivated: tabsOnActivated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
    },
    scripting: {
      executeScript: async () => [],
    },
    permissions: {
      request: async () => true,
    },
    windows: {
      create: async (windowOptions) => windowOptions,
    },
    alarms: {
      create: () => {},
      onAlarm: alarmsOnAlarm,
    },
    commands: {
      onCommand: commandsOnCommand,
    },
  };
}
