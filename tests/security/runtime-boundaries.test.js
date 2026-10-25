import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const extensionId = 'security-test';
const extensionUrl = (path) => `chrome-extension://${extensionId}/${path}`;
const popupSender = { id: extensionId, url: extensionUrl('src/popup.html'), frameId: 0 };
const engineSender = { id: extensionId, url: extensionUrl('src/reader-engine.html?engine=1') };
let listener;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    runtime: {
      id: extensionId, getURL: extensionUrl,
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: (handler) => { listener = handler; } },
      getContexts: vi.fn().mockResolvedValue([{}]),
      sendMessage: vi.fn().mockResolvedValue({ ready: true }),
    },
    storage: {
      local: { setAccessLevel: vi.fn().mockResolvedValue(), get: vi.fn().mockResolvedValue({ secret: 'private' }), set: vi.fn(), remove: vi.fn() },
      session: { get: vi.fn().mockResolvedValue({ readerEngineState: { title: 'private article' } }), set: vi.fn() },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {}, offscreen: { createDocument: vi.fn() },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  await import('../../src/background.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  chrome.storage.local.get.mockClear();
  chrome.storage.local.remove.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('background privilege boundary', () => {
  it.each([
    ['missing identity', {}],
    ['foreign extension', { ...popupSender, id: 'another-extension' }],
    ['content script', { id: extensionId, url: 'https://hostile.example/', frameId: 0 }],
    ['child frame', { ...popupSender, frameId: 7 }],
    ['unexpected extension page', { ...popupSender, url: extensionUrl('src/pdf-viewer.html') }],
    ['path prefix spoof', { ...popupSender, url: extensionUrl('src/popup.html.attacker') }],
    ['opaque origin', { ...popupSender, origin: 'null' }],
  ])('does not start, steer, disclose state, or accept spoofed state from %s', async (_label, sender) => {
    const reply = vi.fn();
    for (const message of [
      { type: 'readerEngineActionRequest', action: 'stop' },
      { type: 'readerEngineGetState' },
      { type: 'readerStateChanged', title: 'spoofed' },
    ]) expect(listener(message, sender, reply)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reply).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.storage.session.get).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('rejects RPC engine-path prefix spoofing without reading secrets', async () => {
    const reply = vi.fn();
    expect(listener({ type: 'readerEngineRpc', operation: 'storage.local.get', args: [null] }, {
      ...engineSender, url: extensionUrl('src/reader-engine.html.attacker'),
    }, reply)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(['syncState', 'stop'])('preserves the reading target when popup %s supplies no source tab', async (type) => {
    const reply = vi.fn();
    const sender = { ...popupSender, tab: { id: 99, url: popupSender.url } };
    expect(listener({ type: 'readerEngineActionRequest', action: { type } }, sender, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'readerEngineAction', action: { type } });
  });

  it('keeps popup state reads and engine RPC working without a global command route', async () => {
    const reply = vi.fn();
    expect(listener({ type: 'readerEngineGetState' }, popupSender, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ title: 'private article' }));
    const rpcReply = vi.fn();
    expect(listener({ type: 'readerEngineRpc', operation: 'storage.local.get', args: ['settings'] }, engineSender, rpcReply)).toBe(true);
    await vi.waitFor(() => expect(rpcReply).toHaveBeenCalledWith({ ok: true, value: { secret: 'private' } }));
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(chrome.commands.onCommand.addListener).not.toHaveBeenCalled();
  });
});
