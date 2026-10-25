import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  chooseArticleExtraction,
  iterateChatTranscriptSpeechChunks,
  revealChatTranscriptStart,
} from '../../src/lib/article-extraction.js';
import { handleExtractMessage } from '../../src/reader/extraction/content-extraction.js';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

const noArticleFallback = { isArticleDocument: () => false, parse: () => null };

function turnHtml(number) {
  const role = number % 2 ? 'user' : 'assistant';
  const body = role === 'user'
    ? `<div class="whitespace-pre-wrap">Prompt number ${number} asks something.</div>`
    : `<p>Answer number ${number} explains the idea.</p>`;
  return `<section data-testid="conversation-turn-${number}"><div data-message-author-role="${role}">${body}</div></section>`;
}

// Mimics ChatGPT: only some turns are in the DOM, and scrolling a rendered turn into view renders
// its missing neighbour (below for block "end", above for block "start").
function createVirtualizedChat(rendered, { total = 6, renders = true } = {}) {
  const dom = new JSDOM(`<title>Virtual chat</title><main><div id="thread"></div></main>`, { url: 'https://chatgpt.com/c/v' });
  dom.window.getSelection = () => ({ toString: () => '', rangeCount: 0 });
  const { document } = dom.window;
  const thread = document.getElementById('thread');
  const scrolls = [];

  const insertTurn = (number) => {
    if (number < 1 || number > total || document.querySelector(`[data-testid="conversation-turn-${number}"]`)) return;
    const template = document.createElement('template');
    template.innerHTML = turnHtml(number);
    const next = [...thread.children].find((child) => Number(child.dataset.testid.split('-').pop()) > number);
    thread.insertBefore(template.content.firstElementChild, next || null);
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options = {}) {
    const number = Number(this.dataset.testid?.split('-').pop());
    scrolls.push([number, options.block]);
    if (renders) insertTurn(options.block === 'start' ? number - 1 : number + 1);
  };
  rendered.forEach(insertTurn);
  return { document, scrolls };
}

const fastReveal = () => {
  let clock = 0;
  return { wait: async (ms) => { clock += ms; }, now: () => clock };
};

async function streamTurnTexts(document, options = fastReveal()) {
  const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback, startMode: 'top' });
  const speech = [];
  for await (const chunk of iterateChatTranscriptSpeechChunks(document, article, {}, options)) {
    speech.push(chunk.speech);
  }
  return speech.filter((text) => /number \d+/.test(text)).map((text) => Number(/number (\d+)/.exec(text)[1]));
}

describe('virtualized chat transcript streaming', () => {
  it('reveals turns missing between rendered turns instead of skipping them', async () => {
    const { document } = createVirtualizedChat([1, 2, 5, 6]);

    expect(await streamTurnTexts(document)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps reading turns rendered after the last extracted turn', async () => {
    const { document, scrolls } = createVirtualizedChat([1, 2], { total: 4 });
    // The page can still scroll down, so later turns may exist below.
    const root = document.documentElement;
    Object.defineProperty(root, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });

    expect(await streamTurnTexts(document)).toEqual([1, 2, 3, 4]);
    expect(scrolls).toContainEqual([2, 'end']);
  });

  it('stops without waiting once the chat is scrolled to its last turn', async () => {
    const { document, scrolls } = createVirtualizedChat([1, 2], { total: 2 });
    let waited = 0;

    expect(await streamTurnTexts(document, { wait: async (ms) => { waited += ms; }, now: () => waited })).toEqual([1, 2]);
    expect(waited).toBe(0);
    expect(scrolls).toEqual([]);
  });

  it('skips a turn that never renders after the reveal timeout and keeps going', async () => {
    const { document } = createVirtualizedChat([1, 2, 5, 6], { renders: false });

    expect(await streamTurnTexts(document)).toEqual([1, 2, 5, 6]);
  });

  it('scrolls back to the first turn before restarting from the top', async () => {
    const { document, scrolls } = createVirtualizedChat([4, 5, 6]);

    const first = await revealChatTranscriptStart(document, fastReveal());

    expect(first?.dataset.testid).toBe('conversation-turn-1');
    expect(scrolls.map(([number]) => number)).toEqual([4, 3, 2]);
    expect(await streamTurnTexts(document)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('streams revealed turns through the content-script chunk protocol', async () => {
    const { document } = createVirtualizedChat([1, 2, 5, 6]);

    const response = await handleExtractMessage({
      type: MESSAGE_TYPES.EXTRACT,
      streamChunks: true,
      startMode: 'top',
    }, { documentRef: document });
    expect(response.chat).toBe(true);

    const speech = [];
    for (;;) {
      const next = await handleExtractMessage({ type: MESSAGE_TYPES.GET_ARTICLE_CHUNK, streamId: response.chunkStreamId }, { documentRef: document });
      if (next.done) break;
      speech.push(next.chunk.speech);
    }
    expect(speech.join(' ')).toContain('Prompt number 3 asks something.');
    expect(speech.join(' ')).toContain('Answer number 4 explains the idea.');
  });

  it('fills gaps in a Claude ARIA feed and stops at aria-setsize without waiting', async () => {
    const dom = new JSDOM('<title>Claude chat</title><div role="feed" id="feed"></div>', { url: 'https://claude.ai/chat/x' });
    dom.window.getSelection = () => ({ toString: () => '', rangeCount: 0 });
    const { document } = dom.window;
    const feed = document.getElementById('feed');
    const rowHtml = (position) => {
      const message = position % 2
        ? `<div data-testid="user-message"><p class="whitespace-pre-wrap">Prompt number ${position} asks something.</p></div>`
        : `<div data-testid="assistant-message" data-is-streaming="false"><p>Answer number ${position} explains the idea.</p></div>`;
      return `<div data-testid="transcript-row"><div role="article" aria-posinset="${position}" aria-setsize="4">${message}</div></div>`;
    };
    const insertRow = (position) => {
      if (position < 1 || position > 4 || document.querySelector(`[aria-posinset="${position}"]`)) return;
      const template = document.createElement('template');
      template.innerHTML = rowHtml(position);
      const next = [...feed.children].find((row) => Number(row.firstElementChild.getAttribute('aria-posinset')) > position);
      feed.insertBefore(template.content.firstElementChild, next || null);
    };
    dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options = {}) {
      const position = Number(this.closest('[aria-posinset]').getAttribute('aria-posinset'));
      insertRow(options.block === 'start' ? position - 1 : position + 1);
    };
    [1, 4].forEach(insertRow);
    let waited = 0;

    const turns = await streamTurnTexts(document, { wait: async (ms) => { waited += ms; }, now: () => waited });

    expect(turns).toEqual([1, 2, 3, 4]);
    // Turn 5 is past aria-setsize, so the stream ends without polling for it.
    expect(waited).toBe(200);
  });

  it('scrolls an unnumbered chat (Gemini) up until older history stops loading', async () => {
    const dom = new JSDOM('<title>Gemini</title><infinite-scroller id="history"></infinite-scroller>', { url: 'https://gemini.google.com/app/x' });
    const { document } = dom.window;
    const history = document.getElementById('history');
    const addPair = (index, prepend) => {
      const container = document.createElement('div');
      container.className = 'conversation-container';
      container.innerHTML = `<user-query><p class="query-text-line">Prompt number ${index} asks something.</p></user-query>
        <model-response><p>Answer number ${index} explains the idea.</p></model-response>`;
      if (prepend) history.prepend(container); else history.append(container);
    };
    addPair(3); addPair(4);
    let older = 2;
    dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options = {}) {
      if (options.block === 'start' && older > 0) addPair(older--, true);
    };
    let clock = 0;

    const first = await revealChatTranscriptStart(document, { wait: async (ms) => { clock += ms; }, now: () => clock });

    expect(first.textContent).toContain('Prompt number 1');
    expect(history.querySelectorAll('user-query')).toHaveLength(4);
  });
});

