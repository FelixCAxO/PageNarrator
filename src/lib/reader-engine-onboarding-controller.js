import { getMessage as defaultGetMessage } from './i18n.js';

export const ONBOARDING_STORAGE_KEY = 'pn:onboard:progress.v1';

function createDefaultState() {
  return { version: 1, step: 'quick-win', completed: false };
}

/** @param {any} [deps] */
export function createReaderEngineOnboardingController({
  els,
  storage = globalThis.chrome?.storage?.local,
  getMessage = defaultGetMessage,
  onPrimary = () => {},
  onStepChange = () => {},
  onError = () => {},
} = {}) {
  let state = createDefaultState();
  let initPromise = null;
  let listenersBound = false;
  let hydrated = false;
  let lastRenderedReadingState = 'idle';

  function init() {
    if (!initPromise) initPromise = hydrate();
    return initPromise;
  }

  async function hydrate() {
    bindListeners();
    if (!storage?.get) {
      hydrated = true;
      return;
    }

    try {
      const stored = await storage.get(ONBOARDING_STORAGE_KEY);
      const persisted = stored?.[ONBOARDING_STORAGE_KEY];
      if (persisted?.version === 1) state = { ...createDefaultState(), ...persisted };
    } catch (error) {
      onError(error);
    } finally {
      hydrated = true;
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    els?.onboardingPrimary?.addEventListener?.('click', () => onPrimary?.());
    els?.onboardingDismiss?.addEventListener?.('click', () => {
      void dismiss();
    });
  }

  function getStep() {
    return state.step;
  }

  function isComplete() {
    return state.completed === true;
  }

  function setBannerVisible(visible, readingState = lastRenderedReadingState) {
    if (els?.onboardingBanner) els.onboardingBanner.hidden = !visible;
    if (!els?.readSelected) return;
    if (visible) {
      els.readSelected.hidden = true;
    } else if (['idle', 'finished'].includes(readingState)) {
      els.readSelected.hidden = false;
    }
  }

  /** @param {any} [options] */
  function render({ readingState = 'idle' } = {}) {
    lastRenderedReadingState = readingState;
    const banner = els?.onboardingBanner;
    if (!banner) return;
    if (!hydrated || isComplete() || !['idle', 'finished'].includes(readingState)) {
      setBannerVisible(false, readingState);
      return;
    }

    const messages = state.step === 'full-page'
      ? {
        title: 'onboardingFullPageTitle',
        body: 'onboardingFullPageBody',
        cta: 'onboardingFullPageCta',
      }
      : {
        title: 'onboardingQuickWinTitle',
        body: 'onboardingQuickWinBody',
        cta: 'onboardingQuickWinCta',
      };

    if (els?.onboardingTitle) els.onboardingTitle.textContent = getMessage(messages.title);
    if (els?.onboardingBody) els.onboardingBody.textContent = getMessage(messages.body);
    if (els?.onboardingPrimary) els.onboardingPrimary.textContent = getMessage(messages.cta);
    setBannerVisible(true, readingState);
  }

  /** @param {any} [event] */
  async function recordSuccessfulRead({ source } = {}) {
    await init();
    if (isComplete()) return;

    if (state.step === 'quick-win' && source === 'selection') {
      const previous = state.step;
      state = { version: 1, step: 'full-page', completed: false };
      await persist();
      notifyStepChange({ from: previous, to: state.step, completed: state.completed, source });
      render({ readingState: lastRenderedReadingState });
      return;
    }

    if (state.step === 'full-page' && source !== 'selection') {
      const previous = state.step;
      state = { version: 1, step: 'done', completed: true };
      await persist();
      notifyStepChange({ from: previous, to: state.step, completed: state.completed, source });
      render({ readingState: lastRenderedReadingState });
    }
  }

  async function dismiss() {
    await init();
    state = { version: 1, step: 'done', completed: true };
    await persist();
    setBannerVisible(false);
  }

  function notifyStepChange(event) {
    try {
      void Promise.resolve(onStepChange(event)).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  async function persist() {
    if (!storage?.set) return;
    try {
      await storage.set({ [ONBOARDING_STORAGE_KEY]: { ...state } });
    } catch (error) {
      onError(error);
    }
  }

  return {
    init,
    getStep,
    isComplete,
    render,
    recordSuccessfulRead,
    dismiss,
  };
}
