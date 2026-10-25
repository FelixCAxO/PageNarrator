import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('toolbar-only extension UI', () => {
  it('registers the popup as the only player', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const background = read('src/background.js');
    expect(manifest.action.default_popup).toBe('src/popup.html');
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.options_page).toBeUndefined();
    expect(manifest.permissions).toContain('offscreen');
    expect(background).toContain('src/reader-engine.html?engine=1');
    expect(background).not.toContain('setup.html');
  });

  it('keeps setup and every reading control in the 350px popup', () => {
    const document = new JSDOM(read('src/popup.html'), { url: 'https://extension.test/' }).window.document;
    const css = read('src/popup.css');
    for (const id of [
      'popup-setup', 'start-reading', 'read-selected', 'popup-player', 'popup-previous', 'popup-toggle',
      'popup-stop', 'popup-next', 'popup-language', 'popup-voice', 'popup-speed', 'popup-section-pause',
      'popup-skip-code', 'popup-area-color', 'popup-word-color', 'popup-transcript-card',
      'popup-queue-card', 'popup-hardware-status',
    ]) expect(document.getElementById(id), id).toBeTruthy();
    expect(document.querySelectorAll('details[open]')).toHaveLength(0);
    expect(document.getElementById('popup-speed')?.getAttribute('max')).toBe('3.0');
    expect(css).toMatch(/width:\s*350px/);
  });

  it('prominently discloses reading-data handling before the user starts a read', () => {
    const document = new JSDOM(read('src/popup.html'), { url: 'https://extension.test/' }).window.document;
    const notice = document.getElementById('popup-privacy-notice');
    const start = document.getElementById('start-reading');

    expect(notice?.textContent).toMatch(/built-in Kokoro voices run locally/i);
    expect(notice?.textContent).toMatch(/Missing voice files download from Hugging Face/i);
    expect(notice?.textContent).toMatch(/Narrated text stays on this device/i);
    expect(notice?.textContent).toMatch(/Settings, page URLs, titles, reading position, and a short text excerpt stay local/i);
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('https://pagenarrator.com/privacy');
    expect(notice?.compareDocumentPosition(start) & 4).toBeTruthy();
  });

  it('uses a hidden offscreen engine and has no separate setup page', () => {
    const document = new JSDOM(read('src/reader-engine.html')).window.document;
    expect(document.body.hidden).toBe(true);
    expect(document.body.getAttribute('aria-hidden')).toBe('true');
    expect(existsSync(new URL('../../src/setup.html', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/setup.js', import.meta.url))).toBe(false);
  });

  it('keeps the PDF viewer limited to document controls', () => {
    const document = new JSDOM(read('src/pdf-viewer.html')).window.document;
    expect(document.getElementById('pdf-pages')).toBeTruthy();
    expect(document.getElementById('pdf-toolbar')?.getAttribute('role')).toBe('toolbar');
    for (const id of ['start-reading', 'popup-toggle', 'popup-stop', 'popup-settings']) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  it('routes setup, queue, transcript and playback through the engine contract', () => {
    const popup = read('src/popup.js');
    const router = read('src/lib/core/reader-engine-message-router.js');
    expect(popup).toContain('PREPARE_VOICE');
    expect(popup).toContain('SYNC_STATE');
    expect(popup).toContain('JUMP_TO_CHUNK');
    expect(popup).toContain('getSelectableVoicesForLanguage');
    expect(router).toContain('actions.prepareVoice');
    expect(router).toContain('actions.syncPlayerState');
    expect(router).toContain('actions.requestJump');
  });

  it('persists only a compact session snapshot', () => {
    const background = read('src/background.js');
    expect(background).toContain('queue: _queue, transcript: _transcript');
    expect(background).toContain('chrome.storage.session.set');
  });
});
