import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createPopupApp } from '../../src/popup.js';
import { MESSAGE_TYPES, READER_ACTION_TYPES } from '../../src/lib/message-types.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

// Payloads below mirror what the reader engine actually broadcasts:
// reader-engine-voice-runtime-controller.js sends modelSetup as { phase, progress, detail, eta },
// and reader-engine-view.js leaves remainingLabel empty and the title as "No page loaded"
// until the page is extracted.
async function createHarness() {
  const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
  const listeners = [];
  const sent = [];
  const storage = { voiceSetupPending: true, customVoiceConfigs: [] };
  const chrome = {
    runtime: {
      id: 'pagenarrator',
      getURL: (path) => `chrome-extension://pagenarrator/${path}`,
      sendMessage: vi.fn(async (message) => {
        sent.push(message);
        return message?.type === MESSAGE_TYPES.READER_ENGINE_GET_STATE ? { state: 'idle' } : { ok: true };
      }),
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
    tabs: {
      getCurrent: vi.fn(async () => null),
      query: vi.fn(async () => [{ id: 7, url: 'https://example.test/article', title: 'Article' }]),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: {
      local: {
        get: vi.fn(async (key) => (typeof key === 'string' ? { [key]: storage[key] } : { ...storage })),
        set: vi.fn(async (data) => Object.assign(storage, data)),
      },
      onChanged: { addListener: () => {} },
    },
  };
  const app = createPopupApp({ document: dom.window.document, chrome, window: dom.window });
  await app.init();
  const $ = (id) => dom.window.document.getElementById(id);
  return {
    $,
    sent,
    broadcast: (update) => listeners.forEach((listener) => listener(
      { type: MESSAGE_TYPES.READER_STATE_CHANGED, ...update },
      { id: 'pagenarrator', url: 'chrome-extension://pagenarrator/src/reader-engine.html?engine=1', frameId: 0 },
    )),
  };
}

describe('popup voice setup progress uses the engine payload', () => {
  it('shows the engine progress value instead of a frozen 0%', async () => {
    const { $, broadcast } = await createHarness();
    broadcast({ state: 'idle', setupPending: true, modelSetup: { phase: 'loading', progress: 90, detail: 'Downloading config.json...', eta: '1s left' } });

    expect($('popup-setup').hidden).toBe(false);
    expect($('popup-setup-progress').value).toBe(90);
    expect($('popup-setup-detail').textContent).toBe('Downloading config.json...');
    // A disabled "Prepare voice" button during loading is a dead control; progress says enough.
    expect($('popup-setup-start').hidden).toBe(true);
    expect($('popup-setup-skip').hidden).toBe(true);
  });

  it('shows the engine failure detail and offers Retry', async () => {
    const { $, broadcast } = await createHarness();
    broadcast({ state: 'idle', setupPending: true, modelSetup: { phase: 'error', detail: 'GPU device was lost.', eta: 'Try again' } });

    expect($('popup-setup-detail').textContent).toBe('GPU device was lost.');
    expect($('popup-setup-start').hidden).toBe(false);
    expect($('popup-setup-start').textContent).toBe('Retry');
  });
});

describe('popup player while a read is preparing', () => {
  it('shows the player with a working Stop as soon as a read starts', async () => {
    const { $, broadcast, sent } = await createHarness();
    broadcast({ state: 'preparing', title: 'No page loaded', progressLabel: '0% complete', remainingLabel: '', modelSetup: { phase: 'idle' } });

    expect($('popup-player').hidden).toBe(false);
    expect($('popup-idle-actions').hidden).toBe(true);
    expect($('popup-player-title').textContent).toBe('Current page');
    expect($('popup-progress').textContent).toBe('Preparing…');
    expect($('popup-stop').disabled).toBe(false);
    expect($('popup-toggle').disabled).toBe(true);
    // Short label: "Preparing…" clipped inside the four-button row.
    expect($('popup-toggle').textContent).toBe('Pause');
    expect($('popup-previous').disabled).toBe(true);
    expect($('popup-next').disabled).toBe(true);

    $('popup-stop').click();
    await vi.waitFor(() => expect(sent.some((message) => message.action?.type === READER_ACTION_TYPES.STOP)).toBe(true));
  });

  it('folds first-read voice setup into the player instead of a second card', async () => {
    const { $, broadcast } = await createHarness();
    broadcast({
      state: 'preparing', title: 'Research Brief', progressLabel: '0% complete', remainingLabel: '',
      queue: ['One.', 'Two.'], modelSetup: { phase: 'loading', progress: 90, detail: 'Downloading config.json...', eta: '1s left' },
    });

    expect($('popup-setup').hidden).toBe(true);
    expect($('popup-player-title').textContent).toBe('Research Brief');
    expect($('popup-progress').textContent).toBe('Downloading config.json...');

    broadcast({ state: 'reading', title: 'Research Brief', currentChunk: 0, totalChunks: 2, progressLabel: '1% complete', remainingLabel: '187 words left', modelSetup: { phase: 'ready' } });
    expect($('popup-setup').hidden).toBe(true);
    expect($('popup-progress').textContent).toBe('1% complete · 187 words left');
    expect($('popup-toggle').textContent).toBe('Pause');
    expect($('popup-toggle').disabled).toBe(false);
  });

  it('marks the header status so errors do not look like the green ready state', async () => {
    const { $, broadcast } = await createHarness();
    expect($('popup-status').dataset.state).toBe('idle');
    broadcast({ state: 'error', errorCode: 'empty_selection' });
    expect($('popup-status').textContent).toBe('Needs attention');
    expect($('popup-status').dataset.state).toBe('error');
    const css = readFileSync(new URL('../../src/popup.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.header-status\[data-state="error"\]\s*\{\s*color:\s*var\(--danger\)/);
  });

  it('names the hardware path without recommending a GPU the reader is already using', async () => {
    const { $, broadcast } = await createHarness();
    expect($('popup-hardware-status').textContent).toBe('Processing shown after reading starts.');
    broadcast({ state: 'idle', backend: { device: 'webgpu', calibration: { gpuClass: 'discrete' } } });
    expect($('popup-hardware-status').textContent).toBe('Processing: WebGPU (dedicated GPU)');
    broadcast({ state: 'idle', backend: { device: 'webgpu', calibration: { gpuClass: 'integrated-probable' } } });
    expect($('popup-hardware-status').textContent).toBe('Processing: WebGPU (integrated GPU)');
    broadcast({ state: 'idle', backend: { device: 'webgpu', calibration: null } });
    expect($('popup-hardware-status').textContent).toBe('Processing: WebGPU');
    broadcast({ state: 'idle', backend: { device: 'wasm' } });
    expect($('popup-hardware-status').textContent).toBe('Processing: CPU / WebAssembly (slower)');
  });

  it('brings the setup card back with Retry when a read fails during setup', async () => {
    const { $, broadcast } = await createHarness();
    broadcast({ state: 'preparing', title: 'Research Brief', modelSetup: { phase: 'loading', progress: 40 } });
    broadcast({ state: 'error', errorCode: 'model_setup_failed', modelSetup: { phase: 'error', detail: 'GPU device was lost.', eta: 'Try again' } });

    expect($('popup-player').hidden).toBe(true);
    expect($('popup-setup').hidden).toBe(false);
    expect($('popup-setup-start').textContent).toBe('Retry');
  });
});
