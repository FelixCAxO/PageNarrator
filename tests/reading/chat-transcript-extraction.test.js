import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { chooseArticleExtraction } from '../../src/lib/article-extraction.js';
import { findStartChunkIndex } from '../../src/lib/reading-start.js';

const noArticleFallback = { isArticleDocument: () => false, parse: () => null };
const VIEWPORT_HEIGHT = 800;

function createDocument(html, url) {
  const dom = new JSDOM(html, { url });
  dom.window.getSelection = () => ({ toString: () => '', rangeCount: 0 });
  Object.defineProperty(dom.window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true });
  return dom.window.document;
}

// Lays turns out top to bottom with the given heights, scrolled by `scrollTop`.
function layoutTurns(document, turnSelector, heights, scrollTop) {
  let top = -scrollTop;
  [...document.querySelectorAll(turnSelector)].forEach((turn, index) => {
    const height = heights[index];
    const rect = { top, bottom: top + height, left: 0, right: 600, width: 600, height };
    turn.getBoundingClientRect = () => rect;
    for (const child of turn.querySelectorAll('*')) {
      child.getBoundingClientRect = () => rect;
    }
    top += height;
  });
}

function chatGptTurn(index, role, body) {
  const label = role === 'user' ? 'You said:' : 'ChatGPT said:';
  const message = role === 'user'
    ? `<div data-message-author-role="user"><div class="whitespace-pre-wrap">${body}</div></div>`
    : `<div data-message-author-role="assistant"><div class="markdown">${body}</div></div>`;
  return `<section data-testid="conversation-turn-${index}"><h4 class="sr-only">${label}</h4>${message}
    <button aria-label="Copy ${role === 'user' ? 'message' : 'response'}">Copy</button></section>`;
}

function createChatGptDocument() {
  return createDocument(`
    <title>Worry-free brains</title>
    <body>
      <nav><a href="/c/1">Older chat</a></nav>
      <main id="main">
        <div id="thread">
          ${chatGptTurn(1, 'user', 'Please continue')}
          ${chatGptTurn(2, 'assistant', '<p>The first answer explains how automation started.</p>')}
          ${chatGptTurn(3, 'user', 'Please continue')}
          ${chatGptTurn(4, 'assistant', '<p>The second answer goes deeper into brains.</p><p>It keeps going for a while.</p>')}
          ${chatGptTurn(5, 'user', 'What about worry?')}
          ${chatGptTurn(6, 'assistant', '<p>The latest answer talks about worry and caution.</p>')}
        </div>
        <div class="rail"><button>Prompt 1</button><button>Prompt 2</button></div>
        <form><textarea aria-label="Ask anything"></textarea><button>Send prompt</button></form>
      </main>
    </body>
  `, 'https://chatgpt.com/c/abc');
}

const CHATGPT_TURNS = '[data-testid^="conversation-turn"]';
const CHATGPT_HEIGHTS = [120, 400, 120, 900, 120, 500];

function startSpeech(article) {
  const index = findStartChunkIndex(article.chunks, article.startPosition, { fallbackIndex: 0 });
  return article.chunks.slice(index, index + 3).map((chunk) => chunk.speech);
}

describe('chat transcript extraction', () => {
  it('reads ChatGPT prompts, per-turn labels, and repeated prompts without UI chrome', () => {
    const document = createChatGptDocument();
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 0);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });
    const speech = article.chunks.map((chunk) => chunk.speech);

    expect(speech).toEqual([
      'Worry-free brains.',
      'You said:',
      'Please continue.',
      'ChatGPT said:',
      'The first answer explains how automation started.',
      'You said:',
      'Please continue.',
      'ChatGPT said:',
      'The second answer goes deeper into brains.',
      'It keeps going for a while.',
      'You said:',
      'What about worry?',
      'ChatGPT said:',
      'The latest answer talks about worry and caution.',
    ]);
  });

  it('reads from the top when the start of the conversation is on screen', () => {
    const document = createChatGptDocument();
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 0);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(article.startPosition).toBeUndefined();
  });

  it('starts at the latest sent prompt when scrolled to the bottom', () => {
    const document = createChatGptDocument();
    // Turn 5 (the last prompt) starts at y=20; its answer fills the rest of the screen.
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 1540);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(article.startPosition).toMatchObject({ source: 'chat-turn' });
    expect(startSpeech(article)).toEqual(['You said:', 'What about worry?', 'ChatGPT said:']);
  });

  it('starts at the beginning of a long answer being read mid-way', () => {
    const document = createChatGptDocument();
    // Turn 4 (900px answer) began 300px above the fold and fills most of the viewport.
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 940);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(startSpeech(article)).toEqual([
      'ChatGPT said:',
      'The second answer goes deeper into brains.',
      'It keeps going for a while.',
    ]);
  });

  it('skips the thin tail of the previous answer at the top of the screen', () => {
    const document = createChatGptDocument();
    // Only 40px of turn 4 remain visible, so the prompt below it is the current message.
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 1500);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(startSpeech(article)).toEqual(['You said:', 'What about worry?', 'ChatGPT said:']);
  });

  it('pins a repeated prompt to the turn on screen instead of its earlier copy', () => {
    const document = createChatGptDocument();
    // Turn 3 repeats turn 1's prompt text and starts on screen.
    layoutTurns(document, CHATGPT_TURNS, CHATGPT_HEIGHTS, 520);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });
    const index = findStartChunkIndex(article.chunks, article.startPosition, { fallbackIndex: 0 });

    expect(index).toBe(5);
    expect(article.chunks.slice(index, index + 2).map((chunk) => chunk.speech)).toEqual(['You said:', 'Please continue.']);
  });

  // Mirrors claude.ai markup captured live on 2026-09-24 (anonymized): an ARIA feed of rows, a
  // visually hidden h2 preview per turn, and response buttons inside the message.
  function claudeRow(position, role, body) {
    const preview = role === 'user' ? 'You said: preview of the prompt' : 'Claude responded: preview of the answer';
    const message = role === 'user'
      ? `<div data-testid="user-message"><p class="whitespace-pre-wrap">${body}</p></div>`
      : `<div data-testid="assistant-message" data-is-streaming="false"><h2 class="sr-only">${preview}</h2>
          <div data-testid="TurnStatus"><button>Thought for 4s</button></div><p>${body}</p></div>
          <div data-testid="message-actions"><button aria-label="Copy">Copy</button></div>`;
    const userPreview = role === 'user' ? `<h2 class="sr-only">${preview}</h2>` : '';
    return `<div data-testid="transcript-row" data-index="${position - 1}">
      <div role="article" aria-posinset="${position}" aria-setsize="4">${userPreview}${message}</div></div>`;
  }

  it('starts at the current Claude prompt and skips hidden previews and buttons', () => {
    const document = createDocument(`
      <title>Planning a trip - Claude</title>
      <body>
        <div data-autoscroll-container="true"><div role="feed"><div data-testid="transcript-sizer">
          ${claudeRow(1, 'user', 'Plan a weekend in Oslo.')}
          ${claudeRow(2, 'assistant', 'Here is a relaxed Oslo weekend plan.')}
          ${claudeRow(3, 'user', 'Make it cheaper please.')}
          ${claudeRow(4, 'assistant', 'A budget version skips the fjord cruise.')}
        </div></div></div>
      </body>
    `, 'https://claude.ai/chat/abc');
    layoutTurns(document, '[data-testid="user-message"], [data-testid="assistant-message"]', [100, 700, 100, 600], 750);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(article.chunks.map((chunk) => chunk.speech)).toEqual([
      'Planning a trip - Claude.',
      'You said:', 'Plan a weekend in Oslo.',
      'Claude said:', 'Here is a relaxed Oslo weekend plan.',
      'You said:', 'Make it cheaper please.',
      'Claude said:', 'A budget version skips the fjord cruise.',
    ]);
    expect(startSpeech(article)).toEqual(['You said:', 'Make it cheaper please.', 'Claude said:']);
    // Role labels have no page text: an empty highlight text makes the highlighter outline the
    // whole turn instead of matching the chat app's hidden 1px label and drawing a stray box.
    const labels = article.chunks.filter((chunk) => chunk.type === 'chat-role');
    expect(labels.map((chunk) => chunk.chunkText)).toEqual(['', '', '', '']);
    const turn = document.querySelector(`[data-pagenarrator-id="${labels[2].anchorId}"]`);
    expect(turn.matches('[data-testid="user-message"]')).toBe(true);
  });

  it('starts at the current Gemini prompt', () => {
    const document = createDocument(`
      <title>Gemini</title>
      <body>
        <infinite-scroller>
          <div class="conversation-container">
            <user-query><h5 class="cdk-visually-hidden">You said</h5><div class="query-text"><p class="query-text-line">Summarize photosynthesis.</p></div></user-query>
            <model-response><h6 class="cdk-visually-hidden">Gemini said</h6><message-content><p>Plants turn light into chemical energy.</p></message-content></model-response>
          </div>
          <div class="conversation-container">
            <user-query><h5 class="cdk-visually-hidden">You said</h5><div class="query-text"><p class="query-text-line">Now explain respiration.</p></div></user-query>
            <model-response><h6 class="cdk-visually-hidden">Gemini said</h6><message-content><p>Respiration releases that stored energy.</p></message-content></model-response>
          </div>
        </infinite-scroller>
      </body>
    `, 'https://gemini.google.com/app/abc');
    layoutTurns(document, 'user-query, model-response', [100, 700, 100, 600], 760);

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(startSpeech(article)).toEqual(['You said:', 'Now explain respiration.', 'Gemini said:']);
    expect(article.chunks.map((chunk) => chunk.speech)).toEqual([
      'Gemini.',
      'You said:', 'Summarize photosynthesis.',
      'Gemini said:', 'Plants turn light into chemical energy.',
      'You said:', 'Now explain respiration.',
      'Gemini said:', 'Respiration releases that stored energy.',
    ]);
  });

  it('keeps the generic viewport start on pages without chat turns', () => {
    const document = createDocument(`
      <title>Article</title>
      <main>
        <p id="first">The earlier paragraph is above the viewport.</p>
        <p id="second">The visible paragraph should be the default starting section.</p>
      </main>
    `, 'https://example.test/article');
    document.querySelector('#first').getBoundingClientRect = () => ({ top: -80, bottom: -20, left: 0, right: 400, width: 400, height: 60 });
    document.querySelector('#second').getBoundingClientRect = () => ({ top: 120, bottom: 180, left: 0, right: 400, width: 400, height: 60 });

    const article = chooseArticleExtraction(document, { articleFallback: noArticleFallback });

    expect(article.startPosition).toMatchObject({ source: 'viewport' });
  });
});
