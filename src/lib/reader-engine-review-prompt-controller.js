import { getMessage as defaultGetMessage } from './i18n.js';

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const REVIEW_STORAGE_KEY = 'pn:onboard:reviewState.v1';
export const REVIEW_THRESHOLD = 3;

function createDefaultState() {
  return {
    version: 1,
    successDays: 0,
    lastCountedDay: '',
    lastShownDay: '',
    dismissed: false,
    laterAt: '',
  };
}

/** @param {any} [deps] */
export function createReaderEngineReviewPromptController({
  els,
  storage = globalThis.chrome?.storage?.local,
  getMessage = defaultGetMessage,
  now = () => new Date(),
  getExtensionId = () => globalThis.chrome?.runtime?.id,
  openReview = () => {},
  onError = () => {},
} = {}) {
  let state = createDefaultState();
  let initPromise = null;
  let listenersBound = false;
  let countedThisSession = false;

  function init() {
    if (!initPromise) initPromise = hydrate();
    return initPromise;
  }

  async function hydrate() {
    bindListeners();
    if (!storage?.get) return;
    try {
      const stored = await storage.get(REVIEW_STORAGE_KEY);
      const persisted = stored?.[REVIEW_STORAGE_KEY];
      if (persisted?.version === 1) state = { ...createDefaultState(), ...persisted };
    } catch (error) {
      onError(error);
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    els?.reviewNever?.addEventListener?.('click', () => {
      void setNever();
    });
    els?.reviewLater?.addEventListener?.('click', () => {
      void setLater();
    });
    els?.reviewReview?.addEventListener?.('click', () => {
      void openStoreReview();
    });
  }

  async function recordSuccessfulRead() {
    await init();
    if (state.dismissed) return;
    const day = todayKey(now());
    if (day === state.lastCountedDay && countedThisSession) return;
    countedThisSession = true;
    state = {
      ...state,
      successDays: state.successDays + 1,
      lastCountedDay: day,
    };
    await persist();
  }

  /** @param {any} [options] */
  async function maybeShow({ readingState = 'idle', protected: isProtected = false } = {}) {
    await init();
    const day = todayKey(now());
    if (
      isProtected
      || state.dismissed
      || state.successDays < REVIEW_THRESHOLD
      || state.successDays <= 1
      || !['idle', 'finished'].includes(readingState)
      || state.lastShownDay === day
      || state.laterAt === day
    ) {
      hidePrompt();
      return false;
    }

    state = { ...state, lastShownDay: day };
    await persist();
    if (els?.reviewPromptTitle) els.reviewPromptTitle.textContent = getMessage('reviewPromptTitle');
    if (els?.reviewPromptBody) els.reviewPromptBody.textContent = getMessage('reviewPromptBody');
    if (els?.reviewPrompt) els.reviewPrompt.hidden = false;
    return true;
  }

  async function setNever() {
    await init();
    state = { ...state, dismissed: true };
    await persist();
    hidePrompt();
  }

  async function setLater() {
    await init();
    state = { ...state, laterAt: todayKey(now()) };
    await persist();
    hidePrompt();
  }

  async function openStoreReview() {
    await init();
    hidePrompt();
    state = { ...state, dismissed: true };
    await persist();
    openReview(`https://chromewebstore.google.com/detail/${getExtensionId()}/reviews`);
  }

  function hidePrompt() {
    if (els?.reviewPrompt) els.reviewPrompt.hidden = true;
  }

  function hide() {
    hidePrompt();
  }

  async function persist() {
    if (!storage?.set) return;
    try {
      await storage.set({ [REVIEW_STORAGE_KEY]: { ...state } });
    } catch (error) {
      onError(error);
    }
  }

  return {
    init,
    recordSuccessfulRead,
    maybeShow,
    setNever,
    setLater,
    openStoreReview,
    hide,
  };
}
