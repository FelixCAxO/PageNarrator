import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createPopupApp } from '../../src/popup.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

// Every settings input used to queue its own read-merge-write, so the newest value waited
// behind stale writes and could be lost when the popup closed. Saves now coalesce.
describe('popup settings saves', () => {
  it('coalesces rapid changes into at most two writes that end with the latest values', async () => {
    const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
    const document = dom.window.document;
    const data = {};
    const writes = [];
    const storage = {
      get: vi.fn(async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return typeof key === 'string' ? { [key]: structuredClone(data[key]) } : structuredClone(data);
      }),
      set: vi.fn(async (values) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push(structuredClone(values));
        Object.assign(data, structuredClone(values));
      }),
    };
    const chrome = {
      runtime: { sendMessage: vi.fn(async () => ({ state: 'idle' })), onMessage: { addListener: vi.fn() } },
      storage: { local: storage, onChanged: { addListener: vi.fn() } },
    };
    const app = createPopupApp({ document, chrome, window: dom.window });
    await app.init();
    writes.length = 0;

    const fire = (id, apply) => {
      const input = document.getElementById(id);
      apply(input);
      input.dispatchEvent(new dom.window.Event('input'));
    };
    fire('popup-speed', (input) => { input.value = '3'; });
    fire('popup-section-pause', (input) => { input.value = '1.5'; });
    fire('popup-performance-profile', (input) => { input.value = 'quality'; });
    fire('popup-backend-preference', (input) => { input.value = 'wasm'; });
    fire('popup-idle-release', (input) => { input.checked = false; });
    fire('popup-skip-code', (input) => { input.checked = true; });

    await vi.waitFor(() => expect(data.playbackSettings?.skipCodeSnippets).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const settingsWrites = writes.filter((values) => values.playbackSettings);
    expect(settingsWrites.length).toBeLessThanOrEqual(2);
    expect(data.playbackSettings).toMatchObject({
      speed: 3,
      sectionPauseSeconds: 1.5,
      ttsPerformanceProfile: 'quality',
      ttsBackendPreference: 'wasm',
      idleReleaseEnabled: false,
      skipCodeSnippets: true,
    });
  });
});
