import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

describe('background script', () => {
  let originalChrome;
  let mockOnMessageAddListener;
  let mockOnInstalledAddListener;
  let mockOnCommandAddListener;
  let mockTabsCreate;
  let mockBackgroundLoggerWarn;

  beforeEach(() => {
    originalChrome = globalThis.chrome;
    
    mockOnMessageAddListener = vi.fn();
    mockOnInstalledAddListener = vi.fn();
    mockOnCommandAddListener = vi.fn();
    mockTabsCreate = vi.fn().mockResolvedValue({ id: 101 });
    mockBackgroundLoggerWarn = vi.fn();

    globalThis.chrome = {
      runtime: {
        id: 'test',
        getManifest: () => ({ background: { service_worker: 'src/background.js' } }),
        getURL: (path) => `chrome-extension://test/${path}`,
        getContexts: vi.fn().mockResolvedValue([]),
        onMessage: { addListener: mockOnMessageAddListener },
        onInstalled: { addListener: mockOnInstalledAddListener },
        sendMessage: vi.fn().mockResolvedValue()
      },
      commands: {
        onCommand: { addListener: mockOnCommandAddListener }
      },
      storage: {
        local: { setAccessLevel: vi.fn().mockResolvedValue(), get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(), remove: vi.fn().mockResolvedValue() },
        session: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      offscreen: { createDocument: vi.fn().mockResolvedValue() },
      windows: { getCurrent: vi.fn().mockResolvedValue({ id: 1 }) },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        create: mockTabsCreate
      }
    };
    

    vi.doMock('../../src/lib/logger.js', async () => {
      const actual = await vi.importActual('../../src/lib/logger.js');
      return {
        ...actual,
        createLogger: (scope, options) => {
          const logger = actual.createLogger(scope, options);
          if (scope !== 'background') return logger;
          return {
            ...logger,
            warn: mockBackgroundLoggerWarn,
            error: vi.fn(),
          };
        },
      };
    });

    vi.resetModules();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/lib/logger.js');
    vi.doUnmock('../../src/lib/reader-engine-host.js');
    vi.resetModules();
  });

  it('marks first-run voice preparation pending without opening a tab', async () => {
    await import('../../src/background.js');

    const installCallback = mockOnInstalledAddListener.mock.calls[0][0];
    installCallback({ reason: 'update' });
    expect(mockTabsCreate).not.toHaveBeenCalled();
    // Store updates keep existing users out of first-run voice setup.
    expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalled();

    installCallback({ reason: 'install' });
    expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith({ 'voiceSetupPending.v1': true });
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it('routes one toolbar player action with its readable tab snapshot', async () => {
    const mockStorageSet = vi.fn().mockResolvedValue();
    const mockSendReaderEngineAction = vi.fn().mockResolvedValue();
    vi.doMock('../../src/lib/reader-engine-host.js', async () => {
      const actual = await vi.importActual('../../src/lib/reader-engine-host.js');
      return { ...actual, sendReaderEngineAction: mockSendReaderEngineAction };
    });
    globalThis.chrome.storage.local.set = mockStorageSet;
    await import('../../src/background.js');

    const messageCallback = mockOnMessageAddListener.mock.calls[0][0];
    const sendResponse = vi.fn();

    expect(messageCallback({
      type: 'readerEngineActionRequest',
      action: { type: 'togglePlayback' },
      tab: { id: 55, title: 'Article', url: 'https://example.com/article' },
    }, { id: 'test', url: 'chrome-extension://test/src/popup.html' }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(mockStorageSet).toHaveBeenCalled());
    expect(mockStorageSet).toHaveBeenCalledWith({
      readableTabTarget: {
        tabId: 55,
        tabSnapshot: { id: 55, title: 'Article', url: 'https://example.com/article' },
        createdAt: expect.any(Number),
      },
    });
    expect(mockSendReaderEngineAction).toHaveBeenCalledTimes(1);
    expect(mockSendReaderEngineAction).toHaveBeenCalledWith(expect.objectContaining({
      action: {
        type: 'togglePlayback',
        tab: { id: 55, title: 'Article', url: 'https://example.com/article' },
      },
    }));
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });

  it('has no global command route outside the extension UI', async () => {
    await import('../../src/background.js');
    expect(manifest.commands).toBeUndefined();
    expect(mockOnCommandAddListener).not.toHaveBeenCalled();
    expect(globalThis.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(globalThis.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(globalThis.chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it.each(['cache', 'permissions', 'storage'])('keeps player requests working if retired voice %s cleanup fails', async (step) => {
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    chrome.permissions = { remove: vi.fn().mockResolvedValue(true) };
    chrome.storage.local.get.mockResolvedValue({ 'byoVoiceConfigs.v1': [{ sourceUri: 'https://voice.example.test/tts' }] });
    const cleanupOperation = { cache: caches.delete, permissions: chrome.permissions.remove, storage: chrome.storage.local.remove }[step];
    cleanupOperation.mockRejectedValueOnce(new Error('Cleanup temporarily unavailable'));
    chrome.runtime.getContexts.mockResolvedValue([{}]);
    chrome.runtime.sendMessage.mockResolvedValue({ ready: true });
    chrome.storage.session.get.mockResolvedValue({ readerEngineState: { state: 'paused' } });
    await import('../../src/background.js');

    const messageCallback = mockOnMessageAddListener.mock.calls[0][0];
    const sender = { id: 'test', url: 'chrome-extension://test/src/popup.html' };
    const stateReply = vi.fn();
    messageCallback({ type: 'readerEngineGetState' }, sender, stateReply);
    await vi.waitFor(() => expect(stateReply).toHaveBeenCalledWith({ state: 'paused' }));
    const stopReply = vi.fn();
    messageCallback({ type: 'readerEngineActionRequest', action: { type: 'stop' } }, sender, stopReply);
    await vi.waitFor(() => expect(stopReply).toHaveBeenCalledWith({ ok: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'readerEngineAction', action: { type: 'stop' } });
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(cleanupOperation).toHaveBeenCalledTimes(1);
    if (step !== 'storage') expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('blocks player requests if trusted storage access cannot be enforced', async () => {
    chrome.storage.local.setAccessLevel.mockRejectedValueOnce(new Error('Storage restriction failed'));
    await import('../../src/background.js');
    const sendResponse = vi.fn();
    mockOnMessageAddListener.mock.calls[0][0]({ type: 'readerEngineGetState' }, {
      id: 'test', url: 'chrome-extension://test/src/popup.html',
    }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'Storage restriction failed' }));
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
  });
});
