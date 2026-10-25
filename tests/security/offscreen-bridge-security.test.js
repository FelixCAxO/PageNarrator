import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

const id = 'hneopkjdnhmdbbgnefihfnaomcnajaob';
const origin = `chrome-extension://${id}`;
const worker = { id, url: `${origin}/service-worker-loader.js` };
let onMessage;
let nativeChrome;

beforeEach(async () => {
  vi.resetModules();
  nativeChrome = { runtime: {
    id,
    getURL: (path) => `${origin}/${path}`,
    sendMessage: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    onMessage: { addListener: (listener) => { onMessage = listener; } },
  } };
  vi.stubGlobal('chrome', nativeChrome);
  await import('../../src/lib/offscreen-chrome-bridge.js');
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('offscreen bridge sender gate', () => {
  it.each([
    ['missing metadata', {}],
    ['foreign extension', { ...worker, id: 'foreign' }],
    ['host page content script', { id, url: 'https://attacker.test/', frameId: 0 }],
    ['popup', { id, url: `${origin}/src/popup.html`, frameId: 0 }],
    ['reader engine', { id, url: `${origin}/src/reader-engine.html?engine=1` }],
    ['child frame', { ...worker, frameId: 2 }],
    ['opaque origin', { ...worker, origin: 'null' }],
    ['worker prefix spoof', { ...worker, url: `${worker.url}.attacker` }],
  ])('does not dispatch forged storage or tab events from %s', (_name, sender) => {
    const changed = vi.fn();
    const removed = vi.fn();
    nativeChrome.storage.onChanged.addListener(changed);
    nativeChrome.tabs.onRemoved.addListener(removed);

    for (const event of ['storage.onChanged', 'tabs.onRemoved']) {
      expect(onMessage({ type: MESSAGE_TYPES.READER_ENGINE_EVENT, event, args: [17] }, sender)).toBe(false);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(nativeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves trusted background event arguments and listener removal', () => {
    const changed = vi.fn();
    const removed = vi.fn();
    const changes = { voice: { newValue: 'af_heart' } };
    const removeInfo = { windowId: 2, isWindowClosing: false };
    nativeChrome.storage.onChanged.addListener(changed);
    nativeChrome.tabs.onRemoved.addListener(removed);

    onMessage({ type: MESSAGE_TYPES.READER_ENGINE_EVENT, event: 'storage.onChanged', args: [changes, 'local'] }, worker);
    onMessage({ type: MESSAGE_TYPES.READER_ENGINE_EVENT, event: 'tabs.onRemoved', args: [17, removeInfo] }, worker);
    expect(changed).toHaveBeenCalledExactlyOnceWith(changes, 'local');
    expect(removed).toHaveBeenCalledExactlyOnceWith(17, removeInfo);

    nativeChrome.tabs.onRemoved.removeListener(removed);
    expect(nativeChrome.tabs.onRemoved.hasListener(removed)).toBe(false);
    onMessage({ type: MESSAGE_TYPES.READER_ENGINE_EVENT, event: 'tabs.onRemoved', args: [18, removeInfo] }, worker);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('leaves engine readiness messages for the reader-engine listener', () => {
    const respond = vi.fn();
    const changed = vi.fn();
    nativeChrome.storage.onChanged.addListener(changed);
    expect(onMessage({ type: MESSAGE_TYPES.READER_ENGINE_PING, event: 'storage.onChanged' }, worker, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('retains native runtime identity while proxying trusted engine requests', async () => {
    nativeChrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true, value: { voice: 'af_heart' } });
    await expect(nativeChrome.storage.local.get('voice')).resolves.toEqual({ voice: 'af_heart' });
    expect(nativeChrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: MESSAGE_TYPES.READER_ENGINE_RPC, operation: 'storage.local.get', args: ['voice'],
    });
    expect(nativeChrome.runtime.id).toBe(id);
    expect(nativeChrome.runtime).not.toHaveProperty('getManifest');

    nativeChrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Denied', code: 'DENIED' });
    await expect(nativeChrome.tabs.get(17)).rejects.toMatchObject({ message: 'Denied', code: 'DENIED' });
  });
});
