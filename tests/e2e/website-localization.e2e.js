// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

test.skip(process.env.PN_E2E_WEBSITE_LOCALIZATION !== '1', 'Opt in to the localized website layout matrix.');
test.use({ launchOptions: { args: ['--mute-audio'] } });
const scope = JSON.parse(await readFile('config/language-rollout.json', 'utf8'));
const variants = scope.languages.flatMap(language => language.locales).map(locale => ({
  locale, tag: locale.replace('_', '-'), path: locale === 'en' ? '/' : `/${locale.replace('_', '-').toLowerCase()}/`,
}));
const root = resolve('artifacts/website');
const output = resolve('artifacts/website-localization/layout');
const slugs = ['index', 'chrome-extension', 'how-it-works', 'support', 'contact', 'changelog', 'privacy', 'terms',
  'private-text-to-speech', 'read-pdf-aloud', 'read-research-papers-aloud', 'listen-to-documentation-aloud',
  'speechify-alternative', 'naturalreader-alternative', '404'];
const localizedPath = (variant, slug) => slug === 'index' ? variant.path : `${variant.path}${slug}`;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
let server, origin;
test.beforeAll(async () => {
  await mkdir(output, { recursive: true });
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = pathname.endsWith('/') ? `${pathname}index.html` : extname(pathname) ? pathname : `${pathname}.html`;
      const file = resolve(root, `.${filename}`);
      if (!file.startsWith(root + sep)) throw new Error('Outside public build');
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); response.end(bytes);
    } catch {
      const prefix = new URL(request.url, 'http://localhost').pathname.split('/')[1];
      const locale = variants.find(variant => variant.path === `/${prefix}/`);
      const errorFile = resolve(root, locale ? `${prefix}/404.html` : '404.html');
      response.writeHead(404, { 'content-type': types['.html'] }); response.end(await readFile(errorFile));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server?.close(resolve)); });

for (const [index, variant] of variants.entries()) test(`${variant.locale} every page, responsive layout and language navigation`, async ({ page, context }) => {
  test.setTimeout(180_000);
  const externalRequests = [], layouts = [];
  const next = variants[(index + 1) % variants.length];
  await context.route(url => /^https?:/u.test(url.protocol) && url.origin !== origin, route => {
    externalRequests.push(route.request().url()); return route.abort();
  });
  for (const slug of slugs) {
    const response = await page.goto(origin + localizedPath(variant, slug === '404' ? 'missing-layout-test-page' : slug), { waitUntil: 'networkidle' });
    expect(response.status()).toBe(slug === '404' ? 404 : 200);
    await expect(page.locator('html')).toHaveAttribute('lang', variant.tag);
    for (const width of [320, 768, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const failures = await page.locator('h1, h2, h3, main p, main li, table.comparison, .feature-grid article, .nav > .brand, .nav-links > a, .nav summary, .hero-actions a, .footer-links a').evaluateAll(elements => elements.flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') return [];
        const outside = rect.left < -1 || rect.right > innerWidth + 1;
        const clipped = element.scrollWidth > element.clientWidth + 2;
        return outside || clipped ? [{ text: element.textContent, outside, clipped, left: rect.left, right: rect.right }] : [];
      }));
      layouts.push({ slug, width, failures });
      await page.screenshot({ path: `${output}/${variant.locale}-${slug}-${width}.png`, fullPage: true });
      expect(failures).toEqual([]);
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('.language-picker summary').click();
    const menu = page.locator('.language-picker ul');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(321);
    expect(await menu.locator('a').evaluateAll(links => links.filter(link => link.scrollWidth > link.clientWidth + 2).map(link => link.textContent))).toEqual([]);
    if (slug === 'support') await page.screenshot({ path: `${output}/${variant.locale}-menu.png`, fullPage: false });
    await page.locator(`.language-picker a[hreflang="${next.tag}"]`).click();
    await expect(page).toHaveURL(origin + localizedPath(next, slug === '404' ? 'index' : slug));
    await expect(page.locator('html')).toHaveAttribute('lang', next.tag);
  }
  expect(externalRequests).toEqual([]);
  await writeFile(`${output}/${variant.locale}.json`, JSON.stringify({ ...variant, layouts, languageSwitch: next.tag, externalRequests }, null, 2));
});
