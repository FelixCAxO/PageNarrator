import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createReaderEngineQueueRenderer } from '../../src/lib/reader-engine-queue-renderer.js';

function createHarness() {
  const dom = new JSDOM(`<!doctype html>
    <details id="queue-card">
      <ol id="reading-queue"></ol>
      <span id="queue-count"></span>
    </details>
    <div id="transcript-text"></div>
    <span id="transcript-count"></span>`);
  const document = dom.window.document;
  const els = {
    queueCard: document.getElementById('queue-card'),
    queue: document.getElementById('reading-queue'),
    queueCount: document.getElementById('queue-count'),
    transcript: document.getElementById('transcript-text'),
    transcriptCount: document.getElementById('transcript-count'),
  };
  return { dom, els };
}

describe('readerEngine queue renderer', () => {
  it('opens the queue card and scrolls the active section into view after render', () => {
    const { els } = createHarness();
    const scrolls = [];
    const renderer = createReaderEngineQueueRenderer({
      els,
      requestJump: () => {},
      renderQueueNavigation: () => {},
    });
    const elementPrototype = els.queue.ownerDocument.defaultView.HTMLElement.prototype;
    elementPrototype.scrollIntoView = function scrollIntoView() {};
    vi.spyOn(elementPrototype, 'scrollIntoView')
      .mockImplementation(function scrollIntoView(options) {
        scrolls.push({ text: this.textContent, options });
      });

    const previousDocument = globalThis.document;
    globalThis.document = els.queue.ownerDocument;
    try {
      renderer.renderQueue(['one', 'two', 'three'], 1);
    } finally {
      globalThis.document = previousDocument;
    }

    expect(els.queueCard.open).toBe(true);
    expect(scrolls).toEqual([
      {
        text: '2two',
        options: { block: 'center' },
      },
    ]);
  });

  it('keeps the queue collapsed when the panel mode disables queue auto-open', () => {
    const { els } = createHarness();
    const renderer = createReaderEngineQueueRenderer({
      els,
      requestJump: () => {},
      renderQueueNavigation: () => {},
      shouldAutoOpenQueue: () => false,
    });

    const previousDocument = globalThis.document;
    globalThis.document = els.queue.ownerDocument;
    try {
      renderer.renderQueue(['one', 'two', 'three'], 1);
    } finally {
      globalThis.document = previousDocument;
    }

    expect(els.queueCard.open).toBe(false);
    expect(els.queue.querySelector('[data-state="current"]')?.textContent).toBe('2two');
  });
});
