import { afterEach, vi } from 'vitest';

if (!globalThis.chrome) {
  globalThis.chrome = {
    runtime: {
      id: 'pagenarrator-test',
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      sendMessage: () => Promise.resolve(),
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    scripting: {
      executeScript: () => Promise.resolve(),
    },
    permissions: {
      request: () => Promise.resolve(false),
    },
    windows: {
      create: () => Promise.resolve(),
    },
  };
}

if (!globalThis.SpeechSynthesisUtterance) {
  globalThis.SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
    constructor(text = '') {
      this.text = String(text);
      this.lang = '';
      this.voice = null;
      this.volume = 1;
      this.rate = 1;
      this.pitch = 1;
      this.onstart = null;
      this.onboundary = null;
      this.onend = null;
      this.onerror = null;
      this.onpause = null;
      this.onresume = null;
    }
  };
}

function createSpeechSynthesisMock() {
  const state = {
    queue: [],
    spoken: [],
    voices: [],
    timers: new Set(),
    current: null,
    paused: false,
    speaking: false,
  };

  const schedule = (callback) => {
    const id = setTimeout(() => {
      state.timers.delete(id);
      callback();
    }, 0);
    state.timers.add(id);
    return id;
  };

  const clearScheduled = () => {
    for (const id of state.timers) clearTimeout(id);
    state.timers.clear();
  };

  const emit = (utterance, name, event = {}) => {
    const handler = utterance?.[`on${name}`];
    if (typeof handler === 'function') {
      handler({
        utterance,
        elapsedTime: 0,
        charIndex: 0,
        charLength: 0,
        name,
        ...event,
      });
    }
  };

  const runNext = () => {
    if (state.paused || state.speaking) return;
    const utterance = state.queue.shift();
    if (!utterance) return;

    state.current = utterance;
    state.speaking = true;
    emit(utterance, 'start');

    for (const match of String(utterance.text || '').matchAll(/\S+/g)) {
      emit(utterance, 'boundary', {
        name: 'word',
        charIndex: match.index,
        charLength: match[0].length,
      });
    }

    state.speaking = false;
    state.current = null;
    emit(utterance, 'end');
    if (state.queue.length) schedule(runNext);
  };

  return {
    get pending() {
      return state.queue.length > 0;
    },
    get paused() {
      return state.paused;
    },
    get speaking() {
      return state.speaking;
    },
    onvoiceschanged: null,
    getVoices() {
      return [...state.voices];
    },
    speak(utterance) {
      state.queue.push(utterance);
      state.spoken.push(utterance);
      schedule(runNext);
    },
    cancel() {
      clearScheduled();
      state.queue = [];
      state.current = null;
      state.speaking = false;
      state.paused = false;
    },
    pause() {
      if (state.paused) return;
      state.paused = true;
      emit(state.current, 'pause');
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      emit(state.current, 'resume');
      schedule(runNext);
    },
    __setVoices(voices = []) {
      state.voices = [...voices];
      if (typeof this.onvoiceschanged === 'function') this.onvoiceschanged();
    },
    __getSpokenUtterances() {
      return [...state.spoken];
    },
    __reset() {
      this.cancel();
      state.spoken = [];
      state.voices = [];
      this.onvoiceschanged = null;
    },
  };
}

if (!globalThis.speechSynthesis) {
  globalThis.speechSynthesis = createSpeechSynthesisMock();
}

const ISOLATED_GLOBALS = [
  'window',
  'document',
  'location',
  'history',
  'Node',
  'Range',
  'HTMLElement',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'fetch',
  'URL',
  'Blob',
  'File',
  'Audio',
  'chrome',
  'speechSynthesis',
  'SpeechSynthesisUtterance',
];

const baselineGlobals = new Map(ISOLATED_GLOBALS.map((key) => [key, {
  exists: Object.prototype.hasOwnProperty.call(globalThis, key),
  value: globalThis[key],
}]));

afterEach(() => {
  try {
    vi.clearAllTimers();
  } catch {
    // Real timers do not always have a fake queue to clear.
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreGlobals();
  globalThis.speechSynthesis?.__reset?.();
});

function restoreGlobals() {
  const leakedWindow = globalThis.window;
  for (const [key, snapshot] of baselineGlobals) {
    restoreGlobal(key, snapshot);
  }
  if (leakedWindow && leakedWindow !== globalThis.window) leakedWindow.close?.();
}

function restoreGlobal(key, snapshot) {
  try {
    if (snapshot.exists) globalThis[key] = snapshot.value;
    else delete globalThis[key];
  } catch {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: snapshot.exists ? snapshot.value : undefined,
    });
  }
}
