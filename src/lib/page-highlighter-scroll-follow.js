// Keeps the text being read on screen. Chat apps (ChatGPT, Claude, Gemini) scroll an inner
// container rather than the window, so the nearest scrollable ancestor is scrolled when there is
// one. Following pauses briefly after the user scrolls so reading never fights a manual scroll,
// and pages that render content while scrolling (ChatGPT) are re-measured once the scroll settles.

const USER_SCROLL_FOLLOW_PAUSE_MS = 4000;
const FOLLOW_CORRECTION_ATTEMPTS = 2;
const FOLLOW_CORRECTION_DELAY_MS = 450;
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'];
const USER_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * @param {{ win: any, documentRef: Document }} deps
 */
export function createScrollFollower({ win, documentRef }) {
  let userScrolledAtMs = Number.NEGATIVE_INFINITY;
  let listenersEnsured = false;
  let correctionTimer = null;

  /**
   * @param {() => any} getRect Measures the target now (re-run for corrections).
   * @param {Node | null | undefined} node Target node, used to find its scroll container.
   * @param {number} anchorRatio Where in the viewport the target should land (0 = top).
   * @param {{ force?: boolean, attempt?: number }} [options]
   */
  function follow(getRect, node, anchorRatio, { force = false, attempt = 0 } = {}) {
    if (attempt === 0) clearCorrection();
    const rect = getRect();
    if (!rect || rect.height === 0) return;
    ensureListeners();
    if (!force && isSuspendedByUser()) return;

    const scroller = findScrollContainer(node);
    const view = getScrollViewport(scroller);
    if (view.height <= 0) return;
    const margin = Math.min(160, view.height * 0.2);
    const inComfortZone = rect.top >= view.top + margin && rect.bottom <= view.bottom - margin;
    if (inComfortZone && !isCovered(rect, node)) return;

    // Text above the view (going back) only needs to clear the top margin; text below lands
    // a third of the way down so there is room to keep reading.
    const top = rect.top < view.top + margin
      ? rect.top - (view.top + margin)
      : rect.top - (view.top + view.height * anchorRatio);
    const target = scroller || win;
    if (typeof target.scrollBy === 'function') {
      target.scrollBy({ top, behavior: 'smooth' });
    } else if (scroller) {
      scroller.scrollTop += top;
    }
    if (attempt < FOLLOW_CORRECTION_ATTEMPTS && typeof win.setTimeout === 'function') {
      correctionTimer = win.setTimeout(() => {
        correctionTimer = null;
        follow(getRect, node, anchorRatio, { force, attempt: attempt + 1 });
      }, FOLLOW_CORRECTION_DELAY_MS);
    }
  }

  function clearCorrection() {
    if (correctionTimer === null) return;
    win.clearTimeout?.(correctionTimer);
    correctionTimer = null;
  }

  // Chat apps float the message box over the bottom of the conversation, so text can be inside
  // the scroll area yet hidden. The topmost element at the text must be the text's own element.
  /**
   * @param {any} rect
   * @param {Node | null | undefined} node
   */
  function isCovered(rect, node) {
    const element = node?.nodeType === 1 ? /** @type {Element} */ (node) : node?.parentElement;
    if (!element || typeof documentRef.elementFromPoint !== 'function') return false;
    const width = Number(win.innerWidth) || documentRef.documentElement?.clientWidth || 0;
    const height = Number(win.innerHeight) || documentRef.documentElement?.clientHeight || 0;
    const x = Math.min(Math.max(0, rect.left + Math.min(8, rect.width / 2)), Math.max(0, width - 1));
    const y = Math.min(Math.max(0, (rect.top + rect.bottom) / 2), Math.max(0, height - 1));
    const hit = documentRef.elementFromPoint(x, y);
    return Boolean(hit) && !element.contains(hit) && !hit.contains(element);
  }

  /** @param {Node | null | undefined} node */
  function findScrollContainer(node) {
    const root = documentRef.scrollingElement || documentRef.documentElement;
    let element = node?.nodeType === 1 ? /** @type {Element} */ (node) : node?.parentElement;
    for (; element && element !== root && element !== documentRef.body; element = element.parentElement) {
      if (element.scrollHeight <= element.clientHeight + 1) continue;
      const overflowY = win.getComputedStyle?.(element)?.overflowY || '';
      if (/^(auto|scroll|overlay)$/.test(overflowY)) return element;
    }
    return null;
  }

  /** @param {Element | null} scroller */
  function getScrollViewport(scroller) {
    const windowHeight = Number(win.innerHeight) || documentRef.documentElement?.clientHeight || 0;
    if (!scroller) return { top: 0, bottom: windowHeight, height: windowHeight };
    const rect = scroller.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    const bottom = Math.min(windowHeight || rect.bottom, rect.bottom);
    return { top, bottom, height: bottom - top };
  }

  function isSuspendedByUser() {
    return getNowMs() - userScrolledAtMs < USER_SCROLL_FOLLOW_PAUSE_MS;
  }

  function getNowMs() {
    const now = win.performance?.now?.();
    return Number.isFinite(now) ? now : Date.now();
  }

  /** @param {any} event */
  function markUserScroll(event) {
    if (event?.type === 'keydown') {
      if (!USER_SCROLL_KEYS.has(event.key)) return;
      const target = event.target;
      if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName || '')) return;
    }
    userScrolledAtMs = getNowMs();
    clearCorrection();
  }

  function ensureListeners() {
    if (listenersEnsured) return;
    for (const type of USER_SCROLL_EVENTS) {
      win.addEventListener?.(type, markUserScroll, { passive: true, capture: true });
    }
    listenersEnsured = true;
  }

  function dispose() {
    clearCorrection();
    if (!listenersEnsured) return;
    for (const type of USER_SCROLL_EVENTS) {
      win.removeEventListener?.(type, markUserScroll, { capture: true });
    }
    listenersEnsured = false;
  }

  return { follow, cancelPending: clearCorrection, dispose };
}
