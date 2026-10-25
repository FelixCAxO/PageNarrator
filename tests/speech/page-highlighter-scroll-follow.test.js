import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

const VIEWPORT_HEIGHT = 800;

function createDom(html) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://example.test/' });
  Object.defineProperty(dom.window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true });
  dom.window.scrollBy = vi.fn();
  let now = 10_000;
  dom.window.performance.now = () => now;
  return { dom, advance: (ms) => { now += ms; } };
}

function setRect(element, top, height = 60) {
  element.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height });
}

// Every text range reports the rect of its containing paragraph.
function mirrorRangeGeometry(window) {
  const createRange = window.document.createRange.bind(window.document);
  window.document.createRange = () => {
    const range = createRange();
    const rectOf = () => {
      const node = range.startContainer;
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return element?.getBoundingClientRect?.() || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };
    range.getBoundingClientRect = rectOf;
    range.getClientRects = () => [rectOf()];
    return range;
  };
}

function installHighlights() {
  globalThis.Highlight = class TestHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  globalThis.CSS = { highlights: { set() {}, delete() {} } };
}

function createChatLayout() {
  const env = createDom(`
    <body>
      <div id="scroller" style="overflow-y: auto; height: 800px">
        <p id="above" data-pagenarrator-id="1">An earlier answer paragraph that is already on screen.</p>
        <p id="below" data-pagenarrator-id="2">The latest answer paragraph sits far below the visible area.</p>
      </div>
    </body>
  `);
  const { document } = env.dom.window;
  const scroller = document.getElementById('scroller');
  Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true });
  scroller.scrollBy = vi.fn();
  setRect(scroller, 0, VIEWPORT_HEIGHT);
  setRect(document.getElementById('above'), 200);
  setRect(document.getElementById('below'), 2400);
  mirrorRangeGeometry(env.dom.window);
  installHighlights();
  return { ...env, document, scroller };
}

describe('page highlighter scroll follow', () => {
  afterEach(() => {
    delete globalThis.Highlight;
    delete globalThis.CSS;
  });

  it('scrolls the inner chat container, not the window, to the section being read', () => {
    const { dom, document, scroller } = createChatLayout();
    const highlighter = createPageHighlighter(document);

    const below = document.getElementById('below');
    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });

    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
    expect(scroller.scrollBy.mock.calls[0][0].top).toBe(2400 - VIEWPORT_HEIGHT * 0.35);
    expect(dom.window.scrollBy).not.toHaveBeenCalled();
  });

  it('does not scroll when the section is already comfortably on screen', () => {
    const { dom, document, scroller } = createChatLayout();
    const highlighter = createPageHighlighter(document);

    const above = document.getElementById('above');
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    expect(scroller.scrollBy).not.toHaveBeenCalled();
    expect(dom.window.scrollBy).not.toHaveBeenCalled();
  });

  it('follows the spoken word through a long webpage section', () => {
    const { document, scroller } = createChatLayout();
    const highlighter = createPageHighlighter(document);
    const above = document.getElementById('above');
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });
    expect(scroller.scrollBy).not.toHaveBeenCalled();

    // The paragraph grows past the bottom of the screen as it is read.
    setRect(above, 200, 1400);
    above.getBoundingClientRect = () => ({ top: 760, bottom: 790, left: 0, right: 600, width: 600, height: 30 });
    highlighter.highlightWord(3);

    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('pauses following after the user scrolls, then resumes', () => {
    const { dom, document, scroller, advance } = createChatLayout();
    const highlighter = createPageHighlighter(document);
    const above = document.getElementById('above');
    const below = document.getElementById('below');
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    dom.window.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 400 }));
    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });
    expect(scroller.scrollBy).not.toHaveBeenCalled();

    advance(4_100);
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });
    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });
    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('ignores scroll keys typed into editable fields', () => {
    const { dom, document, scroller } = createChatLayout();
    const input = document.createElement('textarea');
    document.body.append(input);
    const highlighter = createPageHighlighter(document);
    const above = document.getElementById('above');
    const below = document.getElementById('below');
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });

    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('always scrolls to an explicitly flashed resume section', () => {
    const { dom, document, scroller } = createChatLayout();
    const highlighter = createPageHighlighter(document);
    const above = document.getElementById('above');
    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });
    dom.window.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 400 }));

    highlighter.flashResumeSectionByAnchor('2', 'The latest answer');

    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('re-measures after the scroll settles when the page re-renders mid-scroll', () => {
    const { dom, document, scroller } = createChatLayout();
    const timers = [];
    dom.window.setTimeout = (callback) => timers.push(callback);
    const below = document.getElementById('below');
    // Content rendered during the scroll pushes the target further down than first measured.
    scroller.scrollBy = vi.fn(() => setRect(below, scroller.scrollBy.mock.calls.length === 1 ? 1500 : 250));
    const highlighter = createPageHighlighter(document);

    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });
    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);

    timers.shift()();
    expect(scroller.scrollBy).toHaveBeenCalledTimes(2);
    expect(scroller.scrollBy.mock.calls[1][0].top).toBe(1500 - VIEWPORT_HEIGHT * 0.35);

    // Once the target is on screen, the next check leaves the scroll alone.
    timers.shift()();
    expect(scroller.scrollBy).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(0);
  });

  it.each(['clear', 'pause', 'navigation'])('cancels delayed scroll corrections on %s', (action) => {
    const { dom, document, scroller } = createChatLayout();
    const timers = new Map();
    dom.window.setTimeout = (callback) => {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    const highlighter = createPageHighlighter(document);
    const below = document.getElementById('below');
    highlighter.highlightChunkByAnchor('2', below.textContent, { chunkText: below.textContent });
    expect(timers.size).toBe(1);

    if (action === 'clear') highlighter.clearHighlights();
    else if (action === 'pause') highlighter.setPaused(true);
    else highlighter.cancelPendingScroll();

    expect(timers.size).toBe(0);
    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
    highlighter.dispose();
  });

  it('lets user scrolling cancel a forced resume correction', () => {
    const { dom, document, scroller } = createChatLayout();
    const timers = new Map();
    let nextTimer = 0;
    dom.window.setTimeout = (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    const highlighter = createPageHighlighter(document);
    highlighter.flashResumeSectionByAnchor('2', 'The latest answer');
    expect([...timers.values()].filter(timer => timer.delay === 450)).toHaveLength(1);

    dom.window.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400 }));

    expect([...timers.values()].filter(timer => timer.delay === 450)).toHaveLength(0);
    expect([...timers.values()].filter(timer => timer.delay === 1500)).toHaveLength(1);
    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
    highlighter.dispose();
  });

  it('scrolls text that is on screen but covered by a floating message box', () => {
    const { document, scroller } = createChatLayout();
    const composer = document.createElement('form');
    document.body.append(composer);
    const above = document.getElementById('above');
    setRect(above, 560);
    document.elementFromPoint = (_x, y) => (y >= 540 ? composer : above);
    const highlighter = createPageHighlighter(document);

    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
    expect(scroller.scrollBy.mock.calls[0][0].top).toBe(560 - VIEWPORT_HEIGHT * 0.35);
  });

  it('leaves visible, uncovered text alone even when elementFromPoint is available', () => {
    const { document, scroller } = createChatLayout();
    const above = document.getElementById('above');
    document.elementFromPoint = () => above.firstChild?.parentElement || above;
    const highlighter = createPageHighlighter(document);

    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it('scrolls only far enough to reveal text above the view (reading backwards)', () => {
    const { document, scroller } = createChatLayout();
    const above = document.getElementById('above');
    setRect(above, -500);
    const highlighter = createPageHighlighter(document);

    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    expect(scroller.scrollBy.mock.calls[0][0].top).toBe(-500 - 160);
  });

  it('repositions the reading overlay when an inner container scrolls', () => {
    const { dom, document } = createChatLayout();
    const addEventListener = vi.spyOn(dom.window, 'addEventListener');
    const highlighter = createPageHighlighter(document);
    const above = document.getElementById('above');

    highlighter.highlightChunkByAnchor('1', above.textContent, { chunkText: above.textContent });

    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), expect.objectContaining({ capture: true }));
  });
});
