import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');
const pages = readdirSync(publicDir).filter((name) => name.endsWith('.html'));
// PostCSS is already installed by Vite; use its parser rather than splitting CSS blocks.
const postcss = createRequire(import.meta.url)('postcss');

const headingFont = '/assets/fonts/newsreader.css';

// The August copy rewrite dropped the font link from Support, Contact, Privacy and Terms,
// so their headings fell back to Georgia while every other page used Newsreader.
it('loads the heading font on every page that uses the site stylesheet', () => {
  const missing = pages.filter((name) => {
    const document = new JSDOM(readFileSync(join(publicDir, name), 'utf8')).window.document;
    const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute('href'));
    return hrefs.some((href) => href.startsWith('/assets/')) && !hrefs.some(href => href.split('?')[0] === headingFont);
  });
  expect(missing).toEqual([]);
});

// The 1.0.6 homepage shipped .hero-actions, .trust-list, .hero-visual and .feature-grid with
// no rules at all, so its buttons touched and its features rendered as a bare text stack.
it('styles every class used in website markup', () => {
  const unstyled = [];
  for (const name of pages) {
    const document = new JSDOM(readFileSync(join(publicDir, name), 'utf8')).window.document;
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"][href^="/assets/"]')]
      .map((link) => readFileSync(join(publicDir, link.getAttribute('href').split(/[?#]/)[0]), 'utf8'));
    const inline = [...document.querySelectorAll('style')].map((style) => style.textContent);
    const defined = new Set([...[...stylesheets, ...inline].join('\n').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]));
    for (const element of document.querySelectorAll('[class]')) {
      for (const name2 of element.classList) {
        if (!defined.has(name2)) unstyled.push(`${name}: .${name2}`);
      }
    }
  }
  expect([...new Set(unstyled)]).toEqual([]);
});

it('keeps shared selectors tied to the static website, including hover and focus states', () => {
  const documents = pages.map((name) => new JSDOM(readFileSync(join(publicDir, name), 'utf8')).window.document);
  const unused = [];
  const css = postcss.parse(readFileSync(join(publicDir, 'assets/site-1.0.7.1.css'), 'utf8'));
  css.walkRules((rule) => {
    // Future conditional at-rules and selectors are not evidence of unused CSS.
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && parent.name !== 'media') return;
    }
    for (const selector of rule.selectors) {
      if (/[()[\]\\]/.test(selector)) continue;
      const base = selector.replace(/::(?:before|after|selection)\b/g, '')
        .replace(/:(?:focus-visible|focus-within|hover|active|focus|visited|link|disabled|enabled)\b/g, '');
      if (/:/.test(base.replace(/:root\b/g, ''))) continue;
      try {
        if (!documents.some((document) => document.querySelector(base.trim() || '*'))) unused.push(selector);
      } catch { /* Unknown syntax is deliberately retained. */ }
    }
  });
  expect(unused).toEqual([]);
});

it('uses every shared custom property in current CSS or inline page styles', () => {
  const css = readFileSync(join(publicDir, 'assets/site-1.0.7.1.css'), 'utf8');
  const html = pages.map((name) => readFileSync(join(publicDir, name), 'utf8')).join('\n');
  const referenced = new Set([...(css + html).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));
  const unused = [];
  postcss.parse(css).walkDecls((declaration) => {
    if (declaration.prop.startsWith('--') && !referenced.has(declaration.prop)) unused.push(declaration.prop);
  });
  expect(unused).toEqual([]);
});
