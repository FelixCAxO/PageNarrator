// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { getNoiseSelector } from '../lib/dom-selectors.js';

const BLOCKS = 'p,blockquote,pre,li,dt,dd,figcaption,caption,td,th,h1,h2,h3,h4,h5,h6,div,section,article,main,body';
const LANDMARKS = 'article,main,[role="main"]';
const NOISE = `${getNoiseSelector()},[hidden],[inert],button,input,select,textarea`;
const NON_HEADER_NOISE = NOISE.split(',').filter(selector => selector !== 'header').join(',');

export function isArticleDocument(document) { return Boolean(document?.body?.childNodes.length); }

/**
 * Non-mutating fallback for pages that lack PageNarrator's structured blocks.
 * DOM traversal and metadata stay in JavaScript; no clone or HTML serialization.
 * @param {Document} document
 * @param {{root?: Node|null}} [options]
 */
export function parseArticleDocument(document, { root = null } = {}) {
  if (!document?.body) return null;
  const elementRoot = root?.nodeType === 1 ? /** @type {Element} */ (root) : null;
  const scope = elementRoot && document.body.contains(elementRoot) ? elementRoot : document.body;
  const walker = document.createTreeWalker(scope, 5);
  const styles = new WeakMap(), suppressed = new WeakMap();
  function style(element) {
    if (!styles.has(element)) styles.set(element, document.defaultView?.getComputedStyle(element) ?? element.style);
    return styles.get(element);
  }
  function layoutHidden(element) {
    const path = [];
    let ancestor = element;
    while (ancestor && !suppressed.has(ancestor)) { path.push(ancestor); ancestor = ancestor.parentElement; }
    let hidden = ancestor ? suppressed.get(ancestor) : false;
    for (let i = path.length - 1; i >= 0; i--) {
      const computed = style(path[i]);
      hidden ||= computed?.display === 'none' || computed?.contentVisibility === 'hidden';
      suppressed.set(path[i], hidden);
    }
    return hidden;
  }
  const visible = element => !layoutHidden(element) && !['hidden', 'collapse'].includes(style(element)?.visibility);
  const noisy = element => element.closest(NON_HEADER_NOISE)
    || (element.closest('header') && !element.closest('header').closest(LANDMARKS));
  const records = [];
  let current = null, pieces = [], links = 0, visited = 0, total = 0;
  function flush() {
    const text = pieces.join('').replace(/\s+/g, ' ').trim();
    if (text) records.push({ element: current, text, links });
    pieces = []; links = 0;
  }
  while (walker.nextNode()) {
    if (++visited > 200000 || total > 10000000) return null;
    const node = walker.currentNode;
    if (node.nodeType === 1) {
      const element = /** @type {Element} */ (node);
      if (element.tagName === 'BR' && visible(element) && !noisy(element)) pieces.push(' ');
      continue;
    }
    const parent = node.parentElement;
    if (!parent) continue;
    if (noisy(parent)) continue;
    if (!visible(parent)) continue;
    const nearest = parent.closest(BLOCKS), block = nearest && scope.contains(nearest) ? nearest : scope;
    if (block !== current) { flush(); current = block; }
    const text = node.nodeValue ?? '';
    pieces.push(text); total += text.length;
    if (parent.closest('a')) links += text.trim().length;
  }
  flush();
  const readable = records.filter(record => record.text.length >= 2 && record.links / record.text.length < .7);
  if (readable.reduce((sum, record) => sum + record.text.length, 0) < 40) return null;
  const scores = new Map();
  for (const record of readable) {
    const score = record.text.length * Math.max(0, 1 - record.links / record.text.length * 1.5);
    const ancestors = new Set([scope]);
    let element = record.element;
    for (let depth = 0; element && depth < 6; depth++, element = element.parentElement) {
      if (scope.contains(element) && element.matches('div,section,article,main,[role="main"]')) ancestors.add(element);
    }
    const landmark = record.element.closest(LANDMARKS);
    if (landmark && scope.contains(landmark)) ancestors.add(landmark);
    for (const candidate of ancestors) {
      const weight = candidate === document.body ? .2 : candidate.tagName === 'ARTICLE' ? 2 : candidate.matches(LANDMARKS) ? 1.5 : 1;
      scores.set(candidate, (scores.get(candidate) ?? 0) + score * weight);
    }
  }
  let selected = scope, best = -1;
  for (const [candidate, score] of scores) if (score > best) { selected = candidate; best = score; }
  const textContent = readable.filter(record => selected.contains(record.element)).map(record => record.text).join('\n\n');
  if (!textContent) return null;
  const title = [...selected.querySelectorAll('h1')].find(element => visible(element) && !noisy(element))?.textContent?.trim()
    || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || document.title;
  const byline = document.querySelector('meta[name="author"]')?.getAttribute('content')?.trim() || null;
  return { title, textContent, byline, length: textContent.length };
}
