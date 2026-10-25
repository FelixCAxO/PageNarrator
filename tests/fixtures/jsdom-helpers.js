import { JSDOM } from 'jsdom';

const INSTALLED_GLOBALS = [
  'window',
  'document',
  'location',
  'history',
  'Node',
  'Range',
  'HTMLElement',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

const previousGlobals = new Map();

export function installGlobalDom(html = '<!doctype html>', {
  url = 'https://example.test/',
  pretendToBeVisual = true,
  globals = true,
} = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual });
  if (globals) {
    rememberGlobal('window');
    globalThis.window = dom.window;
    for (const key of INSTALLED_GLOBALS.filter((name) => name !== 'window')) {
      rememberGlobal(key);
      if (key in dom.window) globalThis[key] = dom.window[key];
    }
  }
  return dom;
}

export function cleanupGlobalDom() {
  const win = globalThis.window;
  for (const key of [...previousGlobals.keys()].reverse()) {
    const previous = previousGlobals.get(key);
    if (previous.exists) globalThis[key] = previous.value;
    else delete globalThis[key];
  }
  previousGlobals.clear();
  win?.close?.();
}

export function createVisibleEntry(target, {
  top = 80,
  bottom = 760,
  left = 0,
  right = 600,
} = {}) {
  return {
    target,
    isIntersecting: true,
    boundingClientRect: createRect({ top, bottom, left, right }),
    intersectionRect: createRect({ top, bottom, left, right }),
  };
}

export function makeVisible(element, rect = {}) {
  element.getBoundingClientRect = () => createRect({
    top: rect.top ?? 0,
    bottom: rect.bottom ?? 100,
    left: rect.left ?? 0,
    right: rect.right ?? 100,
  });
  return element;
}

function rememberGlobal(key) {
  if (previousGlobals.has(key)) return;
  previousGlobals.set(key, {
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: globalThis[key],
  });
}

function createRect({ top, bottom, left, right }) {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  };
}
