import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { ROOT, browserOptions } from '../../scripts/build-homepage-css.mjs';

// Rendered layout checks for the marketing site: real pages, real stylesheets (including the
// generated homepage CSS), offline. Google Fonts is blocked, so headings use the fallback serif.
const publicDir = join(ROOT, 'website/public');
const pages = ['/', '/chrome-extension', '/how-it-works', '/support', '/contact', '/read-pdf-aloud',
  '/read-research-papers-aloud', '/listen-to-documentation-aloud', '/private-text-to-speech',
  '/speechify-alternative', '/naturalreader-alternative', '/changelog', '/privacy', '/terms', '/404'];
const widths = [320, 375, 768, 1366];
const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

let server;
let origin;
let browser;
const measurements = new Map();

before(async () => {
  server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(publicDir, path === '' || path === '.' ? 'index.html' : extname(path) ? path : `${path}.html`);
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserOptions());
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    const page = await context.newPage();
    for (const path of pages) {
      await page.goto(origin + path, { waitUntil: 'load' });
      measurements.set(`${path}@${width}`, await page.evaluate(measure));
    }
    await context.close();
  }
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

function measure() {
  const box = (element) => element?.getBoundingClientRect() || null;
  const hero = document.querySelector('.page-hero, .hero');
  const eyebrow = box(hero?.querySelector('.eyebrow'));
  const h1 = box(hero?.querySelector('h1'));
  const lead = box(hero?.querySelector('h1 ~ p'));
  const actions = [...document.querySelectorAll('.hero-actions .btn')].map(box);
  const features = [...document.querySelectorAll('.feature-grid article')].map(box);
  const tables = [...document.querySelectorAll('.comparison')].map((table) => ({
    hidden: table.scrollWidth - table.clientWidth,
    cellsOutside: [...table.querySelectorAll('td, th')]
      .filter((cell) => getComputedStyle(cell).display !== 'none')
      .filter((cell) => box(cell).right > box(table).right + 1 || box(cell).right > innerWidth).length,
  }));
  return {
    overflow: document.documentElement.scrollWidth - innerWidth,
    eyebrowToH1: eyebrow && h1 ? h1.top - eyebrow.bottom : null,
    h1ToLead: h1 && lead ? lead.top - h1.bottom : null,
    lefts: {
      brand: box(document.querySelector('.brand'))?.left,
      hero: h1?.left,
      content: box(document.querySelector('.page-content h2, main > .section h2'))?.left,
      footer: box(document.querySelector('.footer-inner p'))?.left,
    },
    ctaGap: actions.length === 2
      ? Math.max(actions[1].top - actions[0].bottom, actions[1].left - actions[0].right) : null,
    featureColumns: features.length ? new Set(features.map((rect) => Math.round(rect.left))).size : null,
    tables,
  };
}

const each = (fn) => {
  for (const [key, value] of measurements) fn(key, value);
};

void test('no page scrolls sideways at phone, tablet or desktop widths', () => {
  each((key, m) => assert.ok(m.overflow <= 0, `${key} overflows by ${m.overflow}px`));
});

void test('hero headlines sit close to their eyebrow and lead paragraph', () => {
  each((key, m) => {
    if (m.eyebrowToH1 !== null) assert.ok(m.eyebrowToH1 <= 28, `${key} eyebrow→h1 is ${m.eyebrowToH1}px`);
    if (m.h1ToLead !== null) assert.ok(m.h1ToLead <= 28, `${key} h1→lead is ${m.h1ToLead}px`);
  });
});

void test('brand, hero, content and footer share one left edge on phones and tablets', () => {
  each((key, m) => {
    const width = Number(key.split('@')[1]);
    const lefts = Object.entries(m.lefts).filter(([, left]) => left != null);
    // Desktop inner pages keep a deliberately narrower centered reading column.
    const aligned = width <= 768 ? lefts : lefts.filter(([name]) => name !== 'content' || key.startsWith('/@'));
    const [first] = aligned;
    for (const [name, left] of aligned) {
      assert.ok(Math.abs(left - first[1]) <= 1, `${key}: ${name} starts at ${Math.round(left)}px, ${first[0]} at ${Math.round(first[1])}px`);
    }
  });
});

void test('comparison tables show every column without hidden sideways scrolling', () => {
  each((key, m) => {
    for (const table of m.tables) {
      assert.ok(table.hidden <= 0, `${key}: ${table.hidden}px of the table is scrolled out of view`);
      assert.equal(table.cellsOutside, 0, `${key}: ${table.cellsOutside} cells extend past the table`);
    }
  });
});

void test('homepage calls to action are separated and features form a grid', () => {
  for (const width of widths) {
    const m = measurements.get(`/@${width}`);
    assert.ok(m.ctaGap >= 8, `CTA gap at ${width}px is ${m.ctaGap}px`);
    const expected = width >= 1024 ? 3 : width >= 700 ? 2 : 1;
    assert.equal(m.featureColumns, expected, `feature columns at ${width}px`);
  }
});
