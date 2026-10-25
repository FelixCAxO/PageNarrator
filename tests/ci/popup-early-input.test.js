import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createPopupApp } from '../../src/popup.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

// The popup is interactive as soon as it paints, while init() still awaits storage.
describe('popup input during initialization', () => {
  it('handles playback input before stored settings load', async () => {
    const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
    const document = dom.window.document;
    let releaseStorage;
    const storageGate = new Promise((resolve) => { releaseStorage = resolve; });
    const chrome = {
      runtime: { sendMessage: vi.fn(async () => ({ state: 'idle' })), onMessage: { addListener: vi.fn() } },
      storage: {
        local: { get: vi.fn(async () => { await storageGate; return {}; }), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
    };
    const app = createPopupApp({ document, chrome, window: dom.window });
    const initPromise = app.init();

    app.renderReaderState({ state: 'reading' });
    document.getElementById('popup-stop').click();
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readerEngineActionRequest', action: { type: 'stop' } }),
    ));

    releaseStorage();
    await initPromise;
    expect(document.getElementById('popup-custom-voices')).toBeNull();
    expect(document.getElementById('popup-voice').options).toHaveLength(10);
  });
});
