import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createPopupApp } from '../../src/popup.js';

const html = readFileSync(new URL('../../src/popup.html', import.meta.url), 'utf8');

function createApp() {
  const dom = new JSDOM(html, { url: 'chrome-extension://pagenarrator/src/popup.html' });
  const app = createPopupApp({ document: dom.window.document, chrome: {}, window: dom.window });
  return { app, document: dom.window.document, window: dom.window };
}

const queue = Array.from({ length: 3000 }, (_, index) => `Section ${index} narrated text.`);
const state = (currentChunk, overrides = {}) => ({
  state: 'reading', queue, transcript: queue.join('\n'), totalChunks: queue.length, currentChunk, ...overrides,
});

describe('popup queue rendering', () => {
  it('preserves a section number being edited across live progress updates', () => {
    const { app, document } = createApp();
    app.renderReaderState(state(0));
    document.getElementById('popup-queue-card').open = true;
    const input = document.getElementById('popup-queue-jump');
    input.focus();
    input.value = '125';
    app.renderReaderState(state(1));
    expect(input.value).toBe('125');
    input.blur();
    app.renderReaderState(state(2));
    expect(input.value).toBe('3');
  });

  it('marks exactly one current section for both assistive technology and the existing CSS', () => {
    const { app, document } = createApp();
    app.renderReaderState(state(0));
    app.renderReaderState(state(2));
    const current = document.querySelectorAll('#popup-queue [aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('3. Section 2 narrated text.');
    expect(document.querySelector('#popup-queue button').hasAttribute('aria-current')).toBe(false);
  });

  it('explains an empty search and restores the queue when the query is cleared', () => {
    const { app, document } = createApp();
    app.renderReaderState(state(0));
    const search = document.getElementById('popup-queue-search');
    expect(search.getAttribute('aria-label')).toBe('Search sections');
    search.value = 'no matching passage';
    app.renderReaderState(state(1));
    expect(document.querySelectorAll('#popup-queue button')).toHaveLength(0);
    expect(document.getElementById('popup-queue-empty')?.hidden).toBe(false);
    expect(document.getElementById('popup-queue-empty')?.textContent).toMatch(/No matching sections/);
    search.value = '';
    app.renderReaderState(state(1));
    expect(document.getElementById('popup-queue-empty')?.hidden).toBe(true);
    expect(document.querySelectorAll('#popup-queue button')).toHaveLength(queue.length);
  });

  it('moves the active section without rebuilding the queue on chunk broadcasts', () => {
    const { app, document } = createApp();
    app.renderReaderState(state(0));
    const firstButton = document.querySelector('#popup-queue button');
    const transcriptNode = document.getElementById('popup-transcript').firstChild;

    for (let chunk = 1; chunk <= 40; chunk += 1) app.renderReaderState(state(chunk));

    expect(document.querySelector('#popup-queue button')).toBe(firstButton);
    expect(document.getElementById('popup-transcript').firstChild).toBe(transcriptNode);
    const active = [...document.querySelectorAll('#popup-queue button.active')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toBe('41. Section 40 narrated text.');
  });

  it('rebuilds when the queue content or search changes', () => {
    const { app, document, window } = createApp();
    app.renderReaderState(state(2));
    const firstButton = document.querySelector('#popup-queue button');

    app.renderReaderState(state(2, { queue: ['Only section.'], totalChunks: 1, currentChunk: 0 }));
    expect(document.querySelector('#popup-queue button')).not.toBe(firstButton);
    expect(document.querySelectorAll('#popup-queue li')).toHaveLength(1);
    expect(document.querySelector('#popup-queue button.active')?.textContent).toBe('1. Only section.');

    app.renderReaderState(state(5));
    const search = document.getElementById('popup-queue-search');
    search.value = 'Section 2999 ';
    search.dispatchEvent(new window.Event('input'));
    app.renderReaderState(state(5));
    expect(document.querySelectorAll('#popup-queue li')).toHaveLength(1);
    expect(document.getElementById('popup-queue-count').textContent).toBe('3000 sections');
  });

  it('hides empty transcript and queue panels until sections exist', () => {
    const { app, document } = createApp();
    // Hidden in markup too, so the idle popup never flashes two dead panels.
    expect(document.getElementById('popup-transcript-card').hidden).toBe(true);
    expect(document.getElementById('popup-queue-card').hidden).toBe(true);

    app.renderReaderState({ state: 'idle', queue: [], transcript: '' });
    expect(document.getElementById('popup-transcript-card').hidden).toBe(true);
    expect(document.getElementById('popup-queue-card').hidden).toBe(true);

    app.renderReaderState(state(2));
    expect(document.getElementById('popup-transcript-card').hidden).toBe(false);
    expect(document.getElementById('popup-queue-card').hidden).toBe(false);
    expect(document.getElementById('popup-transcript-count').textContent).not.toMatch(/^0 /);

    app.renderReaderState({ state: 'idle', queue: [], transcript: '' });
    expect(document.getElementById('popup-transcript-card').hidden).toBe(true);
    expect(document.getElementById('popup-queue-card').hidden).toBe(true);
  });
});

describe('popup settings summary', () => {
  it('names the voice explicitly and falls back without repeating the word', () => {
    const { app, document } = createApp();
    app.populateLanguages('en');
    app.populateVoices('af_heart');
    expect(document.getElementById('popup-settings-summary').textContent).toMatch(/^Heart voice · 1\.00x$/);

    document.getElementById('popup-voice').replaceChildren();
    app.populateVoices('missing');
    expect(document.getElementById('popup-settings-summary').textContent).not.toMatch(/voice voice/i);
  });
});
