import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPopupApp } from '../../src/popup.js';
import { MESSAGE_TYPES, READER_ACTION_TYPES } from '../../src/lib/message-types.js';

const htmlContent = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

function createPopupHarness(overrides = {}) {
  const dom = new JSDOM(htmlContent, { url: 'chrome-extension://pagenarrator/src/popup.html' });
  const document = dom.window.document;
  const sentMessages = [];
  const tabMessages = [];
  const messageListeners = [];

  const mockTab = overrides.tab || {
    id: 42,
    url: 'https://news.example.test/article',
    title: 'Test Article',
  };

  const storageData = {
    playbackSettings: {
      language: 'en',
      voice: 'af_heart',
      voicesByLanguage: { en: 'af_heart' },
      speed: 1.0,
      sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'auto',
      ttsBackendPreference: 'auto',
      idleReleaseEnabled: true,
      skipCodeSnippets: false,
      highlight: {
        area: { color: '#ffdd57', opacity: 0.1 },
        word: { color: '#ffdd57', opacity: 0.38 },
      },
    },
    voiceSetupPending: false,
    customVoiceConfigs: [],
    ...overrides.storage,
  };

  const chromeMock = {
    runtime: {
      id: 'pagenarrator',
      getURL: (path) => `chrome-extension://pagenarrator/${path}`,
      sendMessage: vi.fn(async (msg) => {
        sentMessages.push(msg);
        if (msg?.type === MESSAGE_TYPES.READER_ENGINE_GET_STATE) {
          return overrides.engineState || { state: 'idle' };
        }
        if (msg?.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST) {
          return { ok: true };
        }
        return { ok: true };
      }),
      onMessage: {
        addListener: vi.fn((listener) => {
          messageListeners.push(listener);
        }),
      },
    },
    tabs: {
      getCurrent: vi.fn(async () => ({ url: 'chrome-extension://pagenarrator/src/popup.html' })),
      query: vi.fn(async () => [mockTab]),
      sendMessage: vi.fn(async (tabId, msg) => {
        tabMessages.push({ tabId, msg });
        if (overrides.pingFails) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true };
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (typeof keys === 'string') {
            return { [keys]: storageData[keys] };
          }
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = storageData[k];
            return res;
          }
          return storageData;
        }),
        set: vi.fn(async (data) => {
          Object.assign(storageData, data);
        }),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: true }]),
    },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    ...overrides.chrome,
  };

  const popupApp = createPopupApp({
    document,
    chrome: chromeMock,
    window: dom.window,
  });

  return {
    dom,
    document,
    chrome: chromeMock,
    popupApp,
    sentMessages,
    tabMessages,
    messageListeners,
    storageData,
    broadcastState(stateUpdate) {
      const message = { type: MESSAGE_TYPES.READER_STATE_CHANGED, ...stateUpdate };
      for (const listener of messageListeners) {
        listener(message, { id: 'pagenarrator', url: 'chrome-extension://pagenarrator/src/reader-engine.html?engine=1', frameId: 0 });
      }
    },
  };
}

describe('Popup controller flows: Read page, Read selected, and self-repair', () => {
  it('saves OmniVoice design in the toolbar popup and restores the previous Kokoro voice', async () => {
    const harness = createPopupHarness({ storage: { playbackSettings: { language: 'en', voice: 'am_michael', voicesByLanguage: { en: 'am_michael' } } } });
    await harness.popupApp.init();
    const { document, dom, storageData } = harness;
    const engine = document.getElementById('popup-tts-engine');
    expect(engine.value).toBe('kokoro');
    expect(engine.closest('details')).toBeNull();
    expect(document.getElementById('popup-settings').open).toBe(false);
    expect(document.getElementById('popup-language').closest('label').hidden).toBe(true);
    engine.value = 'omnivoice';
    engine.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect(storageData.playbackSettings.ttsEngine).toBe('omnivoice'));
    expect(document.getElementById('popup-voice').closest('label').hidden).toBe(true);
    expect(document.getElementById('popup-settings').open).toBe(true);
    expect(document.getElementById('popup-voice-model-help').textContent).toContain('1.35 GB');
    expect(document.getElementById('popup-backend-preference').closest('label').hidden).toBe(true);
    const language = document.getElementById('popup-language');
    expect(language.options).toHaveLength(32);
    expect([...language.options].map(option => option.value)).toContain('arb');
    expect([...language.options].map(option => option.value)).not.toContain('sol');
    const labels = [...language.options].map(option => option.textContent);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
    language.value = 'sv';
    language.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect(storageData.playbackSettings.language).toBe('sv'));
    expect(document.getElementById('popup-omnivoice-pitch')).toBeNull();
    expect(document.getElementById('popup-omnivoice-age')).toBeNull();
    const variation = document.getElementById('popup-omnivoice-variation');
    variation.value = '4';
    variation.dispatchEvent(new dom.window.Event('input'));
    await vi.waitFor(() => expect(storageData.playbackSettings.omniVoice.variation).toBe(4));
    expect(document.getElementById('popup-omnivoice-variation-out').textContent).toBe('4 / 10');
    expect(storageData.playbackSettings.voice).toBe('am_michael');
    expect(storageData.playbackSettings.voicesByLanguage).toEqual({ en: 'am_michael' });
    engine.value = 'kokoro';
    engine.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect(storageData.playbackSettings.ttsEngine).toBe('kokoro'));
    expect(document.getElementById('popup-voice-model-help').textContent).toContain('saved voice');
    expect(document.getElementById('popup-backend-preference').closest('label').hidden).toBe(false);
    expect(language.value).toBe('en');
    expect(document.getElementById('popup-voice').value).toBe('am_michael');
    expect(document.getElementById('popup-omnivoice-settings').hidden).toBe(true);
    dom.window.close();
  });

  it.each(['en', 'sv'])('restores saved whisper after populating the %s language picker', async (language) => {
    const harness = createPopupHarness({ storage: { playbackSettings: {
      ttsEngine: 'omnivoice', language, omniVoice: { gender: 'male', variation: 4, whisper: true },
    } } });
    await harness.popupApp.init();
    const whisper = harness.document.getElementById('popup-omnivoice-whisper');
    expect(whisper.checked).toBe(true);
    expect(whisper.disabled).toBe(false);
    expect(harness.document.getElementById('popup-language').value).toBe(language);
    expect(harness.document.getElementById('popup-omnivoice-variation').value).toBe('4');
    harness.dom.window.close();
  });

  it.each(['read', 'prepare'])('saves the chosen voice model before %s', async (action) => {
    const harness = createPopupHarness();
    await harness.popupApp.init();
    let finishSave;
    harness.chrome.storage.local.set.mockImplementationOnce(data => new Promise(resolve => {
      finishSave = () => { Object.assign(harness.storageData, data); resolve(); };
    }));
    harness.document.getElementById('popup-tts-engine').value = 'omnivoice';
    const reading = action === 'prepare' ? harness.popupApp.prepareVoice()
      : harness.popupApp.startRead({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, harness.popupApp.els.start);
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
    expect(harness.sentMessages.some(message => message.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST)).toBe(false);
    finishSave();
    await reading;
    expect(harness.storageData.playbackSettings.ttsEngine).toBe('omnivoice');
    expect(harness.sentMessages.some(message => message.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST)).toBe(true);
    harness.dom.window.close();
  });
  it('accepts Enter to jump and rejects empty, fractional, and out-of-range section input', async () => {
    const { popupApp, document, dom, sentMessages, broadcastState } = createPopupHarness();
    await popupApp.init();
    broadcastState({ state: 'paused', queue: ['One.', 'Two.', 'Three.'], currentChunk: 0, totalChunks: 3 });
    const input = document.getElementById('popup-queue-jump');
    input.value = '3';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sentMessages.at(-1).action).toEqual({ type: READER_ACTION_TYPES.JUMP_TO_CHUNK, index: 2 });
    const count = sentMessages.length;
    for (const value of ['', '1.5', '0', '4']) {
      input.value = value;
      document.getElementById('popup-queue-go').click();
      expect(sentMessages).toHaveLength(count);
    }
  });

  it('clears a recovered engine error while retaining a new action failure', async () => {
    const { popupApp, document, broadcastState } = createPopupHarness();
    await popupApp.init();
    broadcastState({ state: 'error', errorCode: 'empty_selection' });
    expect(document.getElementById('popup-error').hidden).toBe(false);
    broadcastState({ state: 'reading', currentChunk: 0, totalChunks: 2 });
    expect(document.getElementById('popup-error').hidden).toBe(true);
    popupApp.showError(new Error('Connection failed'));
    broadcastState({ state: 'reading', currentChunk: 1 });
    expect(document.getElementById('popup-error').hidden).toBe(false);
  });

  it('allows only one start while page and selection controls share a pending request', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();
    let finishLookup;
    harness.chrome.tabs.query.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    const start = harness.document.getElementById('start-reading');
    const selected = harness.document.getElementById('read-selected');
    const pending = harness.popupApp.startRead({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, start);
    expect(selected.disabled).toBe(true);
    await harness.popupApp.startRead({ type: READER_ACTION_TYPES.READ_SELECTED }, selected);
    finishLookup([{ id: 42, url: 'https://news.example.test/article' }]);
    await pending;
    expect(harness.sentMessages.filter((m) => m.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST)).toHaveLength(1);
    expect(start.disabled).toBe(false);
    expect(selected.disabled).toBe(false);
  });

  it('keeps a pending playback control disabled through broadcasts but leaves Stop available', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();
    harness.broadcastState({ state: 'reading', currentChunk: 1, totalChunks: 3 });
    let finishAction;
    harness.chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve; }));
    const toggle = harness.document.getElementById('popup-toggle');
    const pending = harness.popupApp.runControl({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, toggle);
    harness.broadcastState({ state: 'paused' });
    expect(toggle.disabled).toBe(true);
    expect(harness.document.getElementById('popup-stop').disabled).toBe(false);
    finishAction({ ok: true });
    await pending;
    expect(toggle.disabled).toBe(false);
    expect(toggle.textContent).toBe('Resume');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes popup DOM and enables Read page and Read selected buttons', async () => {
    const harness = createPopupHarness();
    const startBtn = harness.document.getElementById('start-reading');
    const selectedBtn = harness.document.getElementById('read-selected');

    expect(startBtn.disabled).toBe(true);
    expect(selectedBtn.disabled).toBe(true);

    await harness.popupApp.init();

    expect(startBtn.disabled).toBe(false);
    expect(selectedBtn.disabled).toBe(false);
    expect(harness.document.getElementById('popup-status').textContent).toBe('Ready to read');
    expect(harness.document.getElementById('popup-error').hidden).toBe(true);
  });

  it('clicking "Read page" dispatches togglePlayback action request with active tab target', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();

    const startBtn = harness.document.getElementById('start-reading');
    await harness.popupApp.startRead({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, startBtn);

    const actionReq = harness.sentMessages.find((m) => m.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST);
    expect(actionReq).toBeDefined();
    expect(actionReq.action).toEqual({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK });
    expect(actionReq.tab).toMatchObject({ id: 42, url: 'https://news.example.test/article' });
  });

  it('clicking "Read selected" dispatches readSelected action request with active tab target', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();

    const selectedBtn = harness.document.getElementById('read-selected');
    await harness.popupApp.startRead({ type: READER_ACTION_TYPES.READ_SELECTED }, selectedBtn);

    const actionReq = harness.sentMessages.find((m) => m.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST);
    expect(actionReq).toBeDefined();
    expect(actionReq.action).toEqual({ type: READER_ACTION_TYPES.READ_SELECTED });
    expect(actionReq.tab).toMatchObject({ id: 42, url: 'https://news.example.test/article' });
  });

  it.each([
    { id: 42, url: 'https://news.example.test/article', title: 'Article' },
    { id: 42, url: 'chrome-extension://pagenarrator/src/pdf-viewer.html?src=https%3A%2F%2Fexample.test%2Fbook.pdf#page=7', title: 'Book' },
  ])('offers Read from start after Stop and forwards $title as its target', async tab => {
    const harness = createPopupHarness({ tab });
    await harness.popupApp.init();
    const { document, broadcastState, sentMessages } = harness;
    const fromStart = document.getElementById('read-from-start');
    expect(fromStart.disabled).toBe(false);
    broadcastState({ state: 'reading', currentChunk: 6, totalChunks: 20, title: tab.title });
    expect(fromStart.closest('[hidden]')).not.toBeNull();
    document.getElementById('popup-stop').click();
    await vi.waitFor(() => expect(sentMessages.some(message => message.action?.type === READER_ACTION_TYPES.STOP)).toBe(true));
    broadcastState({ state: 'idle' });
    expect(fromStart.closest('[hidden]')).toBeNull();
    expect(fromStart.textContent).toBe('Read from start');
    fromStart.click();
    await vi.waitFor(() => expect(sentMessages.at(-1)).toMatchObject({
      type: MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST,
      action: { type: READER_ACTION_TYPES.READ_FROM_START },
      tab: { id: tab.id, url: tab.url },
    }));
    harness.dom.window.close();
  });

  it('self-repairs by injecting content script when content script ping fails', async () => {
    const harness = createPopupHarness({ pingFails: true });
    await harness.popupApp.init();

    const startBtn = harness.document.getElementById('start-reading');
    await harness.popupApp.startRead({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, startBtn);

    expect(harness.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42 },
      files: ['src/content.js'],
    }));

    const actionReq = harness.sentMessages.find((m) => m.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST);
    expect(actionReq).toBeDefined();
  });

  it('surfaces actionable error message on unscriptable chrome URLs', async () => {
    const harness = createPopupHarness({
      tab: { id: 99, url: 'chrome://settings' },
    });
    await harness.popupApp.init();

    // Trigger an error display
    harness.popupApp.showError({ code: 'PAGENARRATOR_UNSCRIPTABLE_URL' });

    const errorEl = harness.document.getElementById('popup-error');
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toMatch(/Chrome pages cannot be read/i);
  });

  it('surfaces actionable recovery message for empty selection', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();

    harness.popupApp.showError({ code: 'empty_selection' });

    const errorEl = harness.document.getElementById('popup-error');
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('Select the text you want to hear, then choose Read selected.');
  });

  it('synchronizes UI state transitions smoothly when reader engine broadcasts state changes', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();

    const statusEl = harness.document.getElementById('popup-status');
    const playerSection = harness.document.getElementById('popup-player');
    const idleActions = harness.document.getElementById('popup-idle-actions');
    const toggleBtn = harness.document.getElementById('popup-toggle');

    // 1. Preparing state
    harness.broadcastState({ state: 'preparing', title: 'Article Headline' });
    expect(statusEl.textContent).toBe('Preparing voice…');

    // 2. Reading state
    harness.broadcastState({
      state: 'reading',
      title: 'Article Headline',
      currentChunk: 1,
      totalChunks: 5,
      progressLabel: '20% complete',
      remainingLabel: '4 sections left',
    });
    expect(statusEl.textContent).toBe('Reading');
    expect(playerSection.hidden).toBe(false);
    expect(idleActions.hidden).toBe(true);
    expect(toggleBtn.textContent).toBe('Pause');
    expect(harness.document.getElementById('popup-progress').textContent).toContain('20% complete');

    // 3. Paused state
    harness.broadcastState({ state: 'paused' });
    expect(statusEl.textContent).toBe('Paused');
    expect(toggleBtn.textContent).toBe('Resume');

    // 4. Finished state
    harness.broadcastState({ state: 'finished' });
    expect(statusEl.textContent).toBe('Finished');
    expect(playerSection.hidden).toBe(true);
    expect(idleActions.hidden).toBe(false);

    // 5. Error state
    harness.broadcastState({ state: 'error', errorCode: 'tts_generation_failed', message: 'Speech generation failed' });
    expect(statusEl.textContent).toBe('Needs attention');
    expect(harness.document.getElementById('popup-error').hidden).toBe(false);
  });

  it('player controls dispatch appropriate reader engine action requests', async () => {
    const harness = createPopupHarness();
    await harness.popupApp.init();

    harness.broadcastState({ state: 'reading', currentChunk: 1, totalChunks: 3 });

    // Previous
    await harness.popupApp.runControl({ type: READER_ACTION_TYPES.PREVIOUS }, harness.document.getElementById('popup-previous'));
    // Pause
    await harness.popupApp.runControl({ type: READER_ACTION_TYPES.TOGGLE_PLAYBACK }, harness.document.getElementById('popup-toggle'));
    // Next
    await harness.popupApp.runControl({ type: READER_ACTION_TYPES.NEXT }, harness.document.getElementById('popup-next'));
    // Stop
    await harness.popupApp.runControl({ type: READER_ACTION_TYPES.STOP }, harness.document.getElementById('popup-stop'));

    const dispatchedActions = harness.sentMessages
      .filter((m) => m.type === MESSAGE_TYPES.READER_ENGINE_ACTION_REQUEST)
      .map((m) => m.action.type);

    expect(dispatchedActions).toContain(READER_ACTION_TYPES.PREVIOUS);
    expect(dispatchedActions).toContain(READER_ACTION_TYPES.TOGGLE_PLAYBACK);
    expect(dispatchedActions).toContain(READER_ACTION_TYPES.NEXT);
    expect(dispatchedActions).toContain(READER_ACTION_TYPES.STOP);
  });
});
