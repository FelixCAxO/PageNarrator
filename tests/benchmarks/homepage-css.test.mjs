import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { chromium } from '@playwright/test';
import {
  ROOT, SOURCE_CSS, browserOptions, buildHomepageCss, homepageAsset,
  makeHomepageCss, matchingSelectorsInDocument, sha256,
} from '../../scripts/build-homepage-css.mjs';

const postcss = createRequire(import.meta.url)('postcss');
const publicDir = join(ROOT, 'website/public');
const html = await readFile(join(publicDir, 'index.html'), 'utf8');
const asset = homepageAsset(html);
const css = await readFile(join(publicDir, asset), 'utf8');
const source = (await readFile(join(publicDir, SOURCE_CSS), 'utf8')).replace(/\r\n/g, '\n');
const originalHtml = html.replace(`href="${asset}"`, `href="${SOURCE_CSS}"`);
const evidenceDir = process.env.PN_PERF_EVIDENCE_DIR;
const compression = (text) => ({
  raw: Buffer.byteLength(text),
  gzip9: gzipSync(text, { level: 9 }).length,
  brotli11: brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
let browser;
before(async () => { browser = await chromium.launch(browserOptions()); });
after(async () => { await browser?.close(); });

// Deliberately synthetic: proves CSS/layout equivalence, not production font/image rendering.
const imageFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#101713"/><path d="M0 0L1280 800M1280 0L0 800" stroke="#2dd4bf" stroke-width="8"/><text x="70" y="110" fill="white" font-size="36">Synthetic screenshot geometry fixture</text></svg>';

async function openVariant(style, { width = 390, motion = 'no-preference', image = true, fontAlias = false, zoomText = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 844 }, deviceScaleFactor: 1,
    reducedMotion: motion, serviceWorkers: 'block',
  });
  const failures = [];
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.exposeFunction('__pnDigest', (text) => sha256(text));
  // Purely offline rendering: the network and upstream asset contents are not measured.
  const fontStyle = fontAlias
    ? '@font-face{font-family:"Newsreader";src:local("Liberation Serif");font-weight:600 800;font-display:swap}'
    : '/* Synthetic font-outage case. */';
  const fixtureHtml = originalHtml
    .replace(/<link[^>]*rel="preconnect"[^>]*>/g, '')
    .replace(/<link[^>]*href="https:\/\/fonts.googleapis.com[^>]*>/g, `<style>${fontStyle}</style>`)
    .replace(`<link rel="stylesheet" href="${SOURCE_CSS}">`, `<style>${style}</style>`)
    .replace(/\/assets\/screenshots\/toolbar-player-reading\.webp(?:\?v=[a-f0-9]+)?/, image
      ? `data:image/svg+xml,${encodeURIComponent(imageFixture)}` : 'data:image/png;base64,invalid');
  await page.setContent(fixtureHtml, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  if (zoomText) await page.addStyleTag({ content: 'html { font-size: 32px; }' });
  await page.mouse.move(0, 0);
  return { context, page, failures };
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('body, body *')];
    const data = nodes.map((element) => {
      const rect = element.getBoundingClientRect();
      const styles = [null, '::before', '::after', '::selection'].map((pseudo) => {
        const computed = getComputedStyle(element, pseudo);
        return [...computed].sort().map((name) => [name, computed.getPropertyValue(name)]);
      });
      return { tag: element.tagName, rect: [rect.x, rect.y, rect.width, rect.height], styles };
    });
    const text = JSON.stringify({ data, scroll: [scrollX, scrollY], active: document.activeElement?.outerHTML });
    return { sha256: await window.__pnDigest(text), nodes: nodes.length,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
}

// Require two consecutive, byte-identical captures per variant before comparing.
// This waits for compositor stability; it never masks pixels or disables transitions.
async function stableScreenshot(page) {
  let previous;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch((error) => {
        if (error.name !== 'AbortError') throw error;
      })));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const current = await page.screenshot({ fullPage: true });
    if (previous && sha256(previous) === sha256(current)) return current;
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('Rendering did not stabilize to two identical captures.');
}

async function compareVariants(options, name, allStates = true) {
  const a = await openVariant(source, options);
  const b = await openVariant(css, options);
  try {
    const states = allStates ? ['default', 'primary', 'secondary', 'nav', 'footer', 'keyboard', 'selection'] : ['default'];
    for (const state of states) {
      for (const { page } of [a, b]) {
        if (state === 'primary') await page.locator('.hero-actions .primary').hover();
        if (state === 'secondary') await page.locator('.hero-actions .secondary').hover();
        if (state === 'nav') await page.locator('.nav-links a').first().hover();
        if (state === 'footer') await page.locator('.footer-links a').last().hover();
        if (state === 'keyboard') {
          await page.mouse.move(0, 0);
          await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
          await page.keyboard.press('Tab');
        }
        if (state === 'selection') await page.evaluate(() => {
          const range = document.createRange(); range.selectNodeContents(document.querySelector('h1'));
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
      }
      // Let existing transitions settle; do not remove them from the compared styles.
      await Promise.all([a.page.waitForTimeout(260), b.page.waitForTimeout(260)]);
      const [original, optimized] = await Promise.all([snapshot(a.page), snapshot(b.page)]);
      assert.deepEqual(optimized, original, `${name}/${state}: computed styles or geometry differ`);
      const shots = [await stableScreenshot(a.page), await stableScreenshot(b.page)];
      if (evidenceDir && sha256(shots[1]) !== sha256(shots[0])) {
        await mkdir(evidenceDir, { recursive: true });
        const key = `${name}-${state}`.replaceAll('/', '-');
        await writeFile(join(evidenceDir, `${key}-mismatch-before.png`), shots[0]);
        await writeFile(join(evidenceDir, `${key}-mismatch-after.png`), shots[1]);
      }
      assert.equal(sha256(shots[1]), sha256(shots[0]), `${name}/${state}: pixels differ`);
      if (evidenceDir && state === 'default' && options.width === 390 && options.motion === 'no-preference') {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(evidenceDir, 'synthetic-mobile-before.png'), shots[0]);
        await writeFile(join(evidenceDir, 'synthetic-mobile-after.png'), shots[1]);
      }
    }
    assert.deepEqual(a.failures, []);
    assert.deepEqual(b.failures, []);
  } finally { await a.context.close(); await b.context.close(); }
}

void test('generated asset is fresh, content addressed, and has its exact cache rule', async () => {
  assert.match(asset, /^\/assets\/home-[a-f0-9]{16}\.css$/);
  assert.equal(asset, `/assets/home-${sha256(css).slice(0, 16)}.css`);
  await buildHomepageCss(ROOT, { check: true });
});

void test('homepage retains font request, image, links, copy, and zero scripts', () => {
  assert.match(html, /family=Newsreader:opsz,wght@6\.\.72,600\.\.800&display=swap/);
  assert.match(html, /<img src="\/assets\/screenshots\/toolbar-player-reading\.webp\?v=[a-f0-9]{12}"/);
  assert.doesNotMatch(html, /<script\b|\bloading="lazy"/i);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.equal((html.match(/<a\b/g) || []).length, 16);
});

void test('safe minimization beats both baseline and unpruned minification on fixed bytes', async () => {
  const minified = await makeHomepageCss(source, originalHtml, browser, { prune: false });
  const result = { original: compression(source), minifyOnly: compression(minified), scoped: compression(css) };
  assert.ok(result.scoped.raw < result.original.raw * 0.65);
  assert.ok(result.scoped.gzip9 < result.original.gzip9 * 0.85);
  assert.ok(result.scoped.gzip9 < result.minifyOnly.gzip9 * 0.9);
  assert.ok(result.scoped.brotli11 < result.minifyOnly.brotli11);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'css-byte-comparison.json'), JSON.stringify(result, null, 2) + '\n');
  }
});

void test('retained declarations, custom properties, and vendor prefixes are unchanged', () => {
  const declarations = (text) => {
    const records = [];
    postcss.parse(text).walkRules((rule) => {
      const ancestry = []; for (let p = rule.parent; p; p = p.parent) if (p.type === 'atrule') ancestry.push(`${p.name} ${p.params}`);
      records.push(JSON.stringify([ancestry, rule.selector, rule.nodes?.filter((n) => n.type === 'decl').map((d) => [d.prop, d.value, Boolean(d.important)])]));
    });
    return records;
  };
  const original = declarations(source);
  let offset = 0;
  for (const rule of declarations(css)) { const index = original.indexOf(rule, offset); assert.ok(index >= 0); offset = index + 1; }
  assert.match(css, /-webkit-backdrop-filter:blur\(18px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /text-wrap:balance/);
});

void test('browser-state and unknown selectors are conservatively kept', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<a class="btn">Test</a>');
    const values = await page.evaluate(matchingSelectorsInDocument, [
      '.missing', '.btn:hover', '.btn:focus-visible', '.btn::before', '::selection',
      '.missing:has(a)', '.missing[hidden]', '.future:unknown-state', '.absent::marker',
    ]);
    assert.deepEqual(values, [false, true, true, true, true, true, true, true, true]);
  } finally { await page.close(); }
});

void test('media conditions stay intact and future at-rules are never pruned', async () => {
  const output = await makeHomepageCss('@media (max-width: 1px){.used:hover{color:red}.absent{color:blue}}@supports (display: grid){.future{color:green}}@keyframes pulse{from{opacity:0}to{opacity:1}}', '<a class="used">x</a>', browser);
  assert.match(output, /@media \(max-width: 1px\)/);
  assert.match(output, /\.used:hover/);
  assert.doesNotMatch(output, /\.absent/);
  assert.match(output, /\.future/);
  assert.match(output, /from\{opacity:0\}/);
});

void test('future markup reintroduces required styles rather than silently dropping them', async () => {
  const text = '.present{color:red}.later{color:blue}';
  const one = await makeHomepageCss(text, '<div class="present"></div>', browser);
  const two = await makeHomepageCss(text, '<div class="present later"></div>', browser);
  assert.doesNotMatch(one, /\.later/); assert.match(two, /\.later/); assert.notEqual(one, two);
});

void test('immutable caching is limited to the fingerprint and security policy remains', async () => {
  const headers = await readFile(join(publicDir, '_headers'), 'utf8');
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /frame-ancestors 'self'/);
  assert.match(headers, /Strict-Transport-Security: max-age=31536000; includeSubDomains; preload/);
  assert.equal((headers.match(/Cache-Control:/g) || []).length, 1);
  assert.ok(headers.replace(/\r\n/g, '\n').includes(`${asset}\n  Cache-Control: public, max-age=31536000, immutable`));
  assert.doesNotMatch(headers, /\/assets\/\*\n\s+Cache-Control/);
});

void test('check refuses stale HTML and scripted pages without rewriting user files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pn-home-css-'));
  try {
    const target = join(dir, 'website/public'); await mkdir(join(target, 'assets'), { recursive: true });
    await writeFile(join(target, SOURCE_CSS), source);
    const headers = await readFile(join(publicDir, '_headers'), 'utf8');
    await writeFile(join(target, '_headers'), headers);
    await writeFile(join(target, 'index.html'), originalHtml + '<script>window.changed=true;</script>');
    await assert.rejects(buildHomepageCss(dir), /Static-only/);
    assert.equal(await readFile(join(target, '_headers'), 'utf8'), headers);
    await writeFile(join(target, 'index.html'), originalHtml);
    await assert.rejects(buildHomepageCss(dir, { check: true }), /stale/);
    assert.equal(await readFile(join(target, 'index.html'), 'utf8'), originalHtml);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

void test('generation is idempotent and retains original shared assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pn-home-css-idempotent-'));
  try {
    const target = join(dir, 'website/public');
    await mkdir(join(target, 'assets'), { recursive: true });
    await writeFile(join(target, SOURCE_CSS), source);
    await writeFile(join(target, 'index.html'), originalHtml);
    await writeFile(join(target, '_headers'), await readFile(join(publicDir, '_headers'), 'utf8'));
    const first = await buildHomepageCss(dir);
    const afterFirst = await readFile(join(target, 'index.html'), 'utf8');
    assert.deepEqual(await buildHomepageCss(dir), first);
    assert.deepEqual(await buildHomepageCss(dir, { check: true }), first);
    assert.equal(await readFile(join(target, SOURCE_CSS), 'utf8'), source);
    assert.equal(await readFile(join(target, 'index.html'), 'utf8'), afterFirst);
    assert.equal((await readFile(join(target, '_headers'), 'utf8')).split('# BEGIN GENERATED HOMEPAGE CSS CACHE').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

void test('CRLF source and headers keep the same fingerprint and pass the freshness check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pn-home-css-crlf-'));
  try {
    const target = join(dir, 'website/public');
    await mkdir(join(target, 'assets'), { recursive: true });
    await writeFile(join(target, SOURCE_CSS), source.replace(/\r?\n/g, '\r\n'));
    await writeFile(join(target, 'index.html'), originalHtml.replace(/\r?\n/g, '\r\n'));
    await writeFile(join(target, '_headers'), (await readFile(join(publicDir, '_headers'), 'utf8')).replace(/\r?\n/g, '\r\n'));
    assert.equal((await buildHomepageCss(dir)).asset, asset);
    assert.equal((await buildHomepageCss(dir, { check: true })).asset, asset);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

void test('visual oracle detects an intentional color regression', async () => {
  const a = await openVariant(source);
  const b = await openVariant(css.replace('--ink:#f3f7ef', '--ink:#ff0000'));
  try { assert.notEqual((await snapshot(a.page)).sha256, (await snapshot(b.page)).sha256); }
  finally { await a.context.close(); await b.context.close(); }
});

void test('Chromium renders the real PNG and lossless WebP hero pixels identically', async () => {
  const path = join(publicDir, 'assets/screenshots/toolbar-player-reading');
  const [png, webp] = await Promise.all([readFile(`${path}.png`), readFile(`${path}.webp`)]);
  const capture = async (type, bytes) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(`<img src="data:image/${type};base64,${bytes.toString('base64')}" alt="PageNarrator reading">`);
      const dimensions = await page.locator('img').evaluate(async (img) => {
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
      });
      return { dimensions, screenshot: sha256(await page.screenshot()) };
    } finally { await page.close(); }
  };
  assert.deepEqual(await capture('webp', webp), await capture('png', png));
});

for (const width of [360, 390, 412, 520, 521, 820, 821, 1280]) {
  for (const motion of ['no-preference', 'reduce']) {
    void test(`all computed styles and pixels match: ${width}px/${motion}`, { timeout: 30000 }, async () => {
      await compareVariants({ width, motion }, `${width}px/${motion}`);
    });
  }
}

void test('broken screenshot keeps the same layout and accessible alternative text', async () => {
  await compareVariants({ width: 390, image: false }, 'image-failure', false);
});
void test('alternate font metrics keep the same CSS and layout', async () => {
  await compareVariants({ width: 390, fontAlias: true }, 'synthetic-font-metrics', false);
});
void test('200% text sizing keeps the same CSS and layout', async () => {
  await compareVariants({ width: 390, zoomText: true }, 'large-text', false);
});
