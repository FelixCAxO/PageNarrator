import { createDom, makeVisible, makeTextRangeGeometry, installHighlightCapture, getLatestHighlight } from "./page-highlighter.fixtures.js";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';

describe('page highlighter', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it('matches visible article text inside data-nosnippet containers', () => {
    const dom = createDom(`
      <body>
        <main data-nosnippet>
          <p>Visible article text remains highlightable even when publishers suppress search snippets.</p>
        </main>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('main'));
    makeVisible(document.querySelector('p'));
    const highlighted = installHighlightCapture();

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Visible article text remains highlightable even when publishers suppress search snippets.')).toEqual({ ok: true });
    expect(highlighter.highlightWord(2)).toEqual({ ok: true });
    expect(getLatestHighlight(highlighted, 'pagenarrator-word-0')).toEqual({
      name: 'pagenarrator-word-0',
      text: 'text',
    });
  });

  it('applies separate custom CSS variables for the read area and current word highlight', () => {
    const dom = createDom(`
      <body>
        <p>Custom highlight color text.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      value: 'Chrome Test',
      configurable: true,
    });

    const highlighter = createPageHighlighter(document);

    expect(highlighter.setHighlightSettings({
      area: { color: '#00aa55', opacity: 0.45 },
      word: { color: '#7c3aed', opacity: 0.72 },
    })).toEqual({
      area: { color: '#00aa55', opacity: 0.45 },
      word: { color: '#7c3aed', opacity: 0.72 },
    });
    expect(highlighter.highlightChunk('Custom highlight color text.')).toEqual({ ok: true });

    const style = document.getElementById('pagenarrator-highlight-styles');
    expect(style.textContent).toContain('var(--pn-highlight-area-rgb)');
    expect(style.textContent).toContain('var(--pn-highlight-word-rgb)');
    expect(document.documentElement.style.getPropertyValue('--pn-highlight-area-rgb')).toBe('0, 170, 85');
    expect(document.documentElement.style.getPropertyValue('--pn-highlight-area-opacity')).toBe('0.45');
    expect(document.documentElement.style.getPropertyValue('--pn-highlight-word-rgb')).toBe('124, 58, 237');
    expect(document.documentElement.style.getPropertyValue('--pn-highlight-word-opacity-0')).toBe('0.72');
  });

  it('preserves dark code block backgrounds instead of repainting them with the light highlight fill', () => {
    const dom = createDom(`
      <body>
        <pre data-pagenarrator-id="code" style="background: rgb(17, 17, 17); color: rgb(245, 245, 245);"><code>const answer = 42;</code></pre>
        <p data-pagenarrator-id="paragraph">Regular paragraph text.</p>
      </body>
    `);
    const { document } = dom.window;
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      value: 'Chrome Test',
      configurable: true,
    });
    makeVisible(document.querySelector('pre'));
    makeVisible(document.querySelector('p'));

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunkByAnchor('code', null)).toEqual({ ok: true });

    const code = document.querySelector('pre');
    expect(code.classList.contains('pagenarrator-current-block')).toBe(true);
    expect(code.getAttribute('data-pagenarrator-dark-code-block')).toBe('true');
    expect(code.style.getPropertyValue('--pn-highlight-block-background')).toBe('rgb(17, 17, 17)');

    const style = document.getElementById('pagenarrator-highlight-styles');
    expect(style.textContent).toContain('background: var(--pn-highlight-block-background');

    expect(highlighter.highlightChunkByAnchor('paragraph', null)).toEqual({ ok: true });
    expect(code.classList.contains('pagenarrator-current-block')).toBe(false);
    expect(code.hasAttribute('data-pagenarrator-dark-code-block')).toBe(false);
    expect(code.style.getPropertyValue('--pn-highlight-block-background')).toBe('');
  });

  it('draws multi-line active ranges as separate stable overlay fragments', () => {
    const dom = createDom(`
      <body>
        <p>First line of the passage continues onto a second visible line.</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));
    makeTextRangeGeometry(dom.window, [
      {
        top: 120,
        left: 80,
        right: 360,
        bottom: 138,
        width: 280,
        height: 18,
      },
      {
        top: 144,
        left: 80,
        right: 260,
        bottom: 162,
        width: 180,
        height: 18,
      },
    ]);

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('First line of the passage continues onto a second visible line.')).toEqual({ ok: true });

    const overlays = [...document.querySelectorAll('[data-pagenarrator-region="active"]')];
    expect(overlays).toHaveLength(2);
    expect(overlays.map((overlay) => ({
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
      height: overlay.style.height,
    }))).toEqual([
      { left: '76px', top: '116px', width: '288px', height: '26px' },
      { left: '76px', top: '140px', width: '188px', height: '26px' },
    ]);
  });

  it('draws the chunk region from the matched text range even when the block element has no box', () => {
    const dom = createDom(`
      <body>
        <p>Linear Regression is regression technique modelling relationship between dependent variable and independent variables.</p>
      </body>
    `);
    const { document } = dom.window;
    const paragraph = document.querySelector('p');
    let rectCallCount = 0;
    paragraph.getBoundingClientRect = () => {
      rectCallCount += 1;
      if (rectCallCount === 1) {
        return {
          top: 424,
          left: 148,
          right: 1027,
          bottom: 584,
          width: 879,
          height: 160,
        };
      }

      return {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      };
    };
    makeTextRangeGeometry(dom.window, {
      top: 424,
      left: 148,
      right: 1027,
      bottom: 584,
      width: 879,
      height: 160,
    });

    const highlighter = createPageHighlighter(document);

    expect(highlighter.highlightChunk('Linear Regression is regression technique modelling relationship between dependent variable and independent variables.')).toEqual({ ok: true });

    const overlay = document.querySelector('[data-pagenarrator-region]');
    expect(overlay).not.toBeNull();
    expect(overlay.style.display).toBe('block');
    expect(overlay.style.left).toBe('144px');
    expect(overlay.style.top).toBe('420px');
    expect(overlay.style.width).toBe('887px');
    expect(overlay.style.height).toBe('168px');
  });

  it('uses the spoken timing index directly for a fading word highlight trail', () => {
    const dom = createDom(`
      <body>
        <p>one two three four five six seven eight</p>
      </body>
    `);
    const { document } = dom.window;
    makeVisible(document.querySelector('p'));

    const highlighted = [];
    globalThis.Highlight = class TestHighlight {
      constructor(range) {
        this.range = range;
      }
    };
    globalThis.CSS = {
      highlights: {
        set(name, highlight) {
          highlighted.push({ name, text: highlight.range.toString() });
        },
        delete() {},
      },
    };

    const highlighter = createPageHighlighter(document);
    expect(highlighter.highlightChunk('one two three four five six seven eight')).toEqual({ ok: true });
    expect(highlighter.highlightWord(4, 4)).toEqual({ ok: true });

    expect(highlighted.at(-1)).toEqual({ name: 'pagenarrator-word-0', text: 'five' });
    expect(highlighter.highlightWord(5, 4)).toEqual({ ok: true });
    expect(highlighter.highlightWord(6, 4)).toEqual({ ok: true });
    expect(highlighter.highlightWord(7, 4)).toEqual({ ok: true });

    expect(highlighted.slice(-4)).toEqual([
      { name: 'pagenarrator-word-0', text: 'eight' },
      { name: 'pagenarrator-word-1', text: 'seven' },
      { name: 'pagenarrator-word-2', text: 'six' },
      { name: 'pagenarrator-word-3', text: 'five' },
    ]);
  });
});
