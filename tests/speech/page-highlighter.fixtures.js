import { JSDOM } from 'jsdom';

export function createDom(html) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://example.test/' });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  dom.window.scrollBy = () => {};
  return dom;
}

export function makeVisible(element, rect = { top: 120, left: 80, right: 420, bottom: 180, width: 340, height: 60 }) {
  element.getBoundingClientRect = () => rect;
}

export function makeTextRangeGeometry(window, rect) {
  const originalCreateRange = window.document.createRange.bind(window.document);
  const rects = Array.isArray(rect) ? rect : [rect];
  const bounds = {
    top: Math.min(...rects.map((entry) => entry.top)),
    left: Math.min(...rects.map((entry) => entry.left)),
    right: Math.max(...rects.map((entry) => entry.right)),
    bottom: Math.max(...rects.map((entry) => entry.bottom)),
  };
  bounds.width = bounds.right - bounds.left;
  bounds.height = bounds.bottom - bounds.top;
  window.document.createRange = () => {
    const range = originalCreateRange();
    range.getBoundingClientRect = () => bounds;
    range.getClientRects = () => rects;
    return range;
  };
}

export function installHighlightCapture() {
  const highlighted = [];
  globalThis.Highlight = class TestHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
      this.range = ranges[0] || null;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        const ranges = highlight.ranges?.length ? highlight.ranges : [highlight.range].filter(Boolean);
        highlighted.push({ name, text: ranges.map((range) => range.toString()).join('') });
      },
      delete() {},
    },
  };
  return highlighted;
}

export function getLatestHighlight(highlighted, name) {
  return [...highlighted].reverse().find((entry) => entry.name === name) || null;
}

export function normalizePdfSoftHyphenWord(value) {
  return String(value || '').replace(/-\s+(?=\p{Ll})/gu, '').replace(/\s+/g, ' ').trim();
}
