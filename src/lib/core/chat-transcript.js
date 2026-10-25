// Chat assistants (ChatGPT, Claude, Gemini) render a conversation as a list of message turns.
// Reading them as an article drops prompts, reads UI buttons, and starts from the top; these
// helpers let extraction treat each turn as a unit and start from the turn the user is viewing.

export const CHAT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn"]', // ChatGPT turn wrapper
  '[data-message-author-role]', // ChatGPT message
  '[data-testid="user-message"]', // Claude prompt
  '[data-testid="assistant-message"]', // Claude response
  '[data-is-streaming]', // Claude response (older markup)
  'user-query', // Gemini prompt
  'model-response', // Gemini response
].join(',');

// Prompt bubbles that hold plain text without <p> blocks, so the reading model would skip them.
export const CHAT_PLAIN_TEXT_SELECTOR = [
  '[data-message-author-role="user"] .whitespace-pre-wrap',
  '[data-testid="user-message"]',
  'user-query .query-text',
].join(',');

const USER_TURN_SELECTOR = '[data-message-author-role="user"], [data-testid="user-message"], user-query';
// Screen-reader-only labels and previews ("You said: …", "Claude responded: …") repeat the
// message, so chat reads skip them and speak one consistent role label per turn instead.
const VISUALLY_HIDDEN_CLASS_PATTERN = /(^|\s)(sr-only|visually-hidden|cdk-visually-hidden|screen-reader-text)(\s|$)/;
/** @type {Array<[RegExp, string]>} */
const ASSISTANT_NAMES = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'ChatGPT'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)gemini\.google\.com$/, 'Gemini'],
];

const CHAT_BLOCK_CHILD_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, ul, ol, dl, pre, blockquote, table, figure';

// A turn that started above the fold still counts as the one being read when it covers this
// share of the viewport, or when most of it (a short prompt) is on screen; otherwise it is
// just the previous answer's tail.
const PARTIAL_TURN_MIN_VIEWPORT_SHARE = 0.3;
const PARTIAL_TURN_MIN_OWN_SHARE = 0.5;

/**
 * @param {Document | null | undefined} document
 * @returns {Element[]}
 */
export function findChatTurns(document) {
  if (!document?.querySelectorAll) return [];
  return [...document.querySelectorAll(CHAT_TURN_SELECTOR)]
    .filter((turn) => !turn.parentElement?.closest(CHAT_TURN_SELECTOR));
}

/**
 * @param {Element | null | undefined} element
 * @returns {Element | null}
 */
export function getChatTurn(element) {
  let turn = element?.closest?.(CHAT_TURN_SELECTOR) || null;
  for (let outer = turn?.parentElement?.closest(CHAT_TURN_SELECTOR); outer; outer = outer.parentElement?.closest(CHAT_TURN_SELECTOR)) {
    turn = outer;
  }
  return turn;
}

/**
 * Spoken before each turn so listeners know who is talking, e.g. "You said:" / "Claude said:".
 * @param {Element} turn
 */
export function getChatRoleLabel(turn) {
  const isUser = turn.matches(USER_TURN_SELECTOR) || Boolean(turn.querySelector(USER_TURN_SELECTOR));
  if (isUser) return 'You said:';
  const host = turn.ownerDocument?.defaultView?.location?.hostname || '';
  const name = ASSISTANT_NAMES.find(([pattern]) => pattern.test(host))?.[1] || 'The assistant';
  return `${name} said:`;
}

/** @param {Element} element */
export function isVisuallyHiddenChatElement(element) {
  for (let node = /** @type {Element | null} */ (element); node; node = node.parentElement) {
    if (VISUALLY_HIDDEN_CLASS_PATTERN.test(node.getAttribute('class') || '')) return true;
    if (node.matches(CHAT_TURN_SELECTOR)) break;
  }
  return false;
}

/**
 * @param {Element[]} turns
 * @returns {Element | null}
 */
export function findChatTranscriptRoot(turns = []) {
  if (!turns.length) return null;
  let root = turns[0].parentElement;
  while (root) {
    const candidate = root;
    if (turns.every((turn) => candidate.contains(turn))) return candidate;
    root = root.parentElement;
  }
  return null;
}

/** @param {Element | null | undefined} element */
export function isChatPlainTextBlock(element) {
  if (!element?.matches?.(CHAT_PLAIN_TEXT_SELECTOR)) return false;
  return !element.querySelector(CHAT_BLOCK_CHILD_SELECTOR);
}

/**
 * Picks the turn the user is looking at: the first turn that starts on screen, or an earlier
 * turn that still fills a meaningful part of the viewport (a long answer being read).
 * @param {Element[]} turns
 * @param {number} viewportHeight
 * @returns {Element | null}
 */
export function findCurrentChatTurn(turns = [], viewportHeight = 0) {
  if (!viewportHeight) return null;
  const visible = turns
    .map((turn) => ({ turn, rect: turn.getBoundingClientRect?.() }))
    .filter(({ rect }) => rect && rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight);

  for (let index = 0; index < visible.length; index += 1) {
    const { turn, rect } = visible[index];
    if (rect.top >= 0) return turn;
    const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    const minVisibleHeight = Math.min(viewportHeight * PARTIAL_TURN_MIN_VIEWPORT_SHARE, rect.height * PARTIAL_TURN_MIN_OWN_SHARE);
    if (visibleHeight >= minVisibleHeight || index === visible.length - 1) return turn;
  }
  return null;
}

const TURN_NUMBER_PATTERN = /^conversation-turn-(\d+)$/;
const REVEAL_POLL_MS = 100;
const REVEAL_TIMEOUT_MS = 2500;

/**
 * ChatGPT numbers its turns (data-testid="conversation-turn-N") and only keeps the turns near
 * the viewport in the DOM, so numbers expose turns that exist but are not rendered.
 * @param {Element | null | undefined} turn
 * @returns {number | null}
 */
export function getChatTurnNumber(turn) {
  const match = TURN_NUMBER_PATTERN.exec(turn?.getAttribute?.('data-testid') || '');
  if (match) return Number(match[1]);
  // Claude renders turns as an ARIA feed: article rows with aria-posinset / aria-setsize.
  const position = Number(turn?.closest?.('[aria-posinset]')?.getAttribute('aria-posinset'));
  return Number.isInteger(position) && position > 0 ? position : null;
}

/**
 * Total turns in the conversation when the chat says so (aria-setsize), else null.
 * @param {Document} document
 */
function getChatTurnTotal(document) {
  const sizes = [...document.querySelectorAll('[aria-setsize]')]
    .map((element) => Number(element.getAttribute('aria-setsize')))
    .filter((size) => Number.isInteger(size) && size > 0);
  return sizes.length ? Math.max(...sizes) : null;
}

/** @param {Document} document */
export function hasChatTurns(document) {
  return findChatTurns(document).length > 0;
}

/** @param {Document} document */
export function hasNumberedChatTurns(document) {
  return findChatTurns(document).some((turn) => getChatTurnNumber(turn) !== null);
}

/**
 * @param {Document} document
 * @param {number} number
 */
function findRenderedChatTurn(document, number) {
  return findChatTurns(document).find((turn) => getChatTurnNumber(turn) === number) || null;
}

/**
 * Brings a numbered turn into the DOM by scrolling its rendered neighbour into view, then waits
 * for the chat app to render it. Resolves null when the turn does not exist (end of chat).
 * @param {Document} document
 * @param {number} number
 * @param {{ wait?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number }} [options]
 * @returns {Promise<Element | null>}
 */
export async function revealChatTurn(document, number, {
  wait = defaultWait,
  now = () => Date.now(),
  timeoutMs = REVEAL_TIMEOUT_MS,
} = {}) {
  const total = getChatTurnTotal(document);
  if (total !== null && number > total) return null;
  const deadline = now() + timeoutMs;
  for (;;) {
    const turn = findRenderedChatTurn(document, number);
    if (turn) return turn;

    // Each scroll only renders a few more turns, so keep stepping toward the target.
    const rendered = findChatTurns(document).flatMap((candidate) => {
      const candidateNumber = getChatTurnNumber(candidate);
      return candidateNumber === null ? [] : [{ turn: candidate, number: candidateNumber }];
    });
    const before = rendered.filter((entry) => entry.number < number).at(-1);
    const after = rendered.find((entry) => entry.number > number);
    // Past the last turn: once the container can't scroll further, nothing more will render.
    if (!after && isScrolledToEnd(before?.turn)) return null;
    const neighbour = before || after;
    if (!neighbour || now() >= deadline) return null;
    neighbour.turn.scrollIntoView?.({ block: before ? 'end' : 'start' });
    await wait(REVEAL_POLL_MS);
  }
}

/**
 * "Restart from the top" on a virtualized chat: scroll to the first turn so it is rendered.
 * @param {Document} document
 * @param {{ wait?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number }} [options]
 */
export async function revealChatTranscriptStart(document, options = {}) {
  const numbers = findChatTurns(document).map(getChatTurnNumber).filter((number) => number !== null);
  if (!numbers.length) return loadEarlierChatHistory(document, options);
  const first = Math.min(...numbers);
  if (first <= 1) return findRenderedChatTurn(document, first);
  return revealChatTurn(document, 1, options);
}

/**
 * Chats without turn numbers (Gemini) load older history when scrolled to the top, so keep
 * scrolling up until the first turn stops changing.
 * @param {Document} document
 * @param {{ wait?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number }} [options]
 */
async function loadEarlierChatHistory(document, {
  wait = defaultWait,
  now = () => Date.now(),
  timeoutMs = REVEAL_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  let first = findChatTurns(document)[0] || null;
  let stableChecks = 0;
  while (first && now() < deadline && stableChecks < 3) {
    first.scrollIntoView?.({ block: 'start' });
    const scroller = findScrollableAncestor(first);
    if (scroller) scroller.scrollTop = 0;
    await wait(REVEAL_POLL_MS * 3);
    const next = findChatTurns(document)[0] || null;
    stableChecks = next === first ? stableChecks + 1 : 0;
    first = next;
  }
  return first;
}

/** @param {Element} element */
function findScrollableAncestor(element) {
  const win = element.ownerDocument?.defaultView;
  for (let node = element.parentElement; node && node !== element.ownerDocument?.body; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    if (/^(auto|scroll|overlay)$/.test(win?.getComputedStyle?.(node)?.overflowY || '')) return node;
  }
  return null;
}

/** @param {Element | null | undefined} turn */
function isScrolledToEnd(turn) {
  const document = turn?.ownerDocument;
  const win = document?.defaultView;
  for (let element = turn?.parentElement; element && element !== document?.body; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    if (!/^(auto|scroll|overlay)$/.test(win?.getComputedStyle?.(element)?.overflowY || '')) continue;
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
  }
  const root = document?.scrollingElement || document?.documentElement;
  return !root || root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
}

/** @param {number} ms */
function defaultWait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
