import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createPopupApp } from '../../src/popup.js';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

// Clean install race: the popup can open before runtime.onInstalled writes the
// voice-setup flag. The setup card must still appear once the flag lands.
describe('popup voice setup flag', () => {
  it('shows the setup card when the install flag is written after the popup opened', async () => {
    const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
    const storageListeners = [];
    const chrome = {
      runtime: {
        sendMessage: vi.fn(async () => ({ state: 'idle' })),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn((listener) => storageListeners.push(listener)) },
      },
    };
    const app = createPopupApp({ document: dom.window.document, chrome, window: dom.window });
    await app.init();
    const setup = dom.window.document.getElementById('popup-setup');
    expect(setup.hidden).toBe(true);

    for (const listener of storageListeners) {
      listener({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: { newValue: true } }, 'local');
    }
    expect(setup.hidden).toBe(false);

    for (const listener of storageListeners) {
      listener({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: { newValue: false } }, 'local');
    }
    expect(setup.hidden).toBe(true);
  });

  it('keeps a setup flag change that lands while the popup is still initializing', async () => {
    const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
    const storageListeners = [];
    let releaseRead;
    const chrome = {
      runtime: {
        sendMessage: vi.fn(async () => ({ state: 'idle' })),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          // The initial read resolves with the pre-install value only after the flag changed.
          get: vi.fn((key) => (key === STORAGE_KEYS.VOICE_SETUP_PENDING
            ? new Promise((resolve) => { releaseRead = () => resolve({}); })
            : Promise.resolve({}))),
          set: vi.fn(async () => {}),
        },
        onChanged: { addListener: vi.fn((listener) => storageListeners.push(listener)) },
      },
    };
    const app = createPopupApp({ document: dom.window.document, chrome, window: dom.window });
    const initPromise = app.init();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    for (const listener of storageListeners) {
      listener({ [STORAGE_KEYS.VOICE_SETUP_PENDING]: { newValue: true } }, 'local');
    }
    releaseRead();
    await initPromise;

    expect(dom.window.document.getElementById('popup-setup').hidden).toBe(false);
  });
});
