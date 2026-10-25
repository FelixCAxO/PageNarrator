import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');
let dom;

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function bootPopup() {
  dom = new JSDOM(html, { url: 'chrome-extension://security-test/src/popup.html' });
  const listeners = [];
  const chrome = {
    runtime: {
      id: 'security-test',
      getURL: (path) => `chrome-extension://security-test/${path}`,
      sendMessage: vi.fn(async () => ({ state: 'idle' })),
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener() {} },
    },
  };
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('chrome', chrome);
  vi.resetModules();
  await import('../../src/popup.js');
  await vi.waitFor(() => expect(dom.window.document.getElementById('start-reading').disabled).toBe(false));
  chrome.runtime.sendMessage.mockClear();
  chrome.storage.local.set.mockClear();
  return { chrome, listeners, document: dom.window.document };
}

describe('actual popup entry boundary', () => {
  it('blocks scripted clicks, keyboard actions, input and form submission before effects', async () => {
    const { document, chrome } = await bootPopup();
    document.getElementById('start-reading').click();
    document.getElementById('popup-setup-start').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    document.getElementById('popup-queue-jump').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.getElementById('popup-speed').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(document.getElementById('popup-custom-form')).toBeNull();
  });

  it('does not request state when script opens a transcript or queue disclosure', async () => {
    const { document, chrome } = await bootPopup();
    document.getElementById('popup-transcript-card').open = true;
    document.getElementById('popup-queue-card').open = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('accepts reader state only from the own top-level engine page', async () => {
    const { document, listeners } = await bootPopup();
    const update = { type: MESSAGE_TYPES.READER_STATE_CHANGED, state: 'reading', title: 'Private engine title' };
    const trusted = { id: 'security-test', url: 'chrome-extension://security-test/src/reader-engine.html?engine=1', frameId: 0 };
    const rejected = [
      undefined,
      { ...trusted, id: 'other-extension' },
      { ...trusted, url: 'https://example.test/src/reader-engine.html' },
      { ...trusted, url: 'chrome-extension://security-test/src/pdf-viewer.html' },
      { ...trusted, frameId: 2 },
      { ...trusted, origin: 'null' },
    ];
    for (const sender of rejected) {
      listeners[0](update, sender);
      expect(document.getElementById('popup-status').textContent).toBe('Ready to read');
    }
    listeners[0](update, trusted);
    expect(document.getElementById('popup-status').textContent).toBe('Reading');
    expect(document.getElementById('popup-player-title').textContent).toBe('Private engine title');
  });
});
