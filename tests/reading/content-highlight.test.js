import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';

async function importContentHighlight({ storageGet }) {
  vi.resetModules();
  const dom = new JSDOM('<body><p data-pagenarrator-id="p1">One two.</p></body>', {
    pretendToBeVisual: true,
    url: 'https://example.test/article',
  });
  dom.window.scrollBy = () => {};
  const paragraph = dom.window.document.querySelector('[data-pagenarrator-id="p1"]');
  paragraph.getBoundingClientRect = () => ({
    top: 120,
    left: 40,
    right: 240,
    bottom: 150,
    width: 200,
    height: 30,
  });

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: storageGet,
        remove: vi.fn(async () => {}),
      },
    },
  });

  const module = await import('../../src/reader/highlighting/content-highlight.js');
  return {
    document: dom.window.document,
    handleHighlightMessage: module.handleHighlightMessage,
  };
}

describe('content highlight message handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('handles highlighting immediately without reading inaccessible extension storage', async () => {
    const storageGet = vi.fn(async () => { throw new Error('Storage access is restricted to trusted contexts'); });
    const { document, handleHighlightMessage } = await importContentHighlight({ storageGet });
    const paragraph = document.querySelector('[data-pagenarrator-id="p1"]');

    const first = handleHighlightMessage({
      type: MESSAGE_TYPES.HIGHLIGHT_CHUNK,
      anchorId: 'p1',
      text: 'One two.',
    });
    expect(paragraph.classList.contains('pagenarrator-current-block')).toBe(true);
    await first;
    expect(paragraph.classList.contains('pagenarrator-current-block')).toBe(true);

    paragraph.classList.remove('pagenarrator-current-block');
    const second = handleHighlightMessage({
      type: MESSAGE_TYPES.HIGHLIGHT_CHUNK,
      anchorId: 'p1',
      text: 'One two.',
    });

    expect(paragraph.classList.contains('pagenarrator-current-block')).toBe(true);
    await second;
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('records diagnostic word events only while enabled by trusted message configuration', async () => {
    vi.stubGlobal('CSS', { highlights: new Map() });
    vi.stubGlobal('Highlight', class extends Set {
      constructor(...ranges) { super(ranges); }
    });
    const storageGet = vi.fn(async () => ({}));
    const { handleHighlightMessage } = await importContentHighlight({ storageGet });
    await handleHighlightMessage({ type: MESSAGE_TYPES.HIGHLIGHT_CHUNK, anchorId: 'p1', text: 'One two.' });
    await handleHighlightMessage({ type: MESSAGE_TYPES.HIGHLIGHT_WORD, index: 0 });
    expect((await handleHighlightMessage({ type: MESSAGE_TYPES.GET_FLOW_LOG })).log).toEqual([]);

    await handleHighlightMessage({ type: MESSAGE_TYPES.HIGHLIGHT_WORD, index: 1, contentDiagnostics: { recordFlow: true } });
    expect((await handleHighlightMessage({ type: MESSAGE_TYPES.GET_FLOW_LOG })).log).toMatchObject([
      { kind: 'word', domToken: 'two' },
    ]);
    await handleHighlightMessage({ type: MESSAGE_TYPES.HIGHLIGHT_WORD, index: 0, contentDiagnostics: { recordFlow: false } });
    expect((await handleHighlightMessage({ type: MESSAGE_TYPES.GET_FLOW_LOG })).log).toHaveLength(1);
    expect(storageGet).not.toHaveBeenCalled();
  });
});
