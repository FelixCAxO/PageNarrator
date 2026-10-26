// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, openExtensionPage, getExtensionId, seedFlowTestFlags } from './extension-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';
import { messageKey } from '../../src/lib/i18n.js';
import { selectNativeOption } from './native-controls-fixture.js';

const rollout = JSON.parse(await readFile('config/language-rollout.json', 'utf8'));
const locales = rollout.languages.flatMap(language => language.locales);
const selected = new Set((process.env.PN_E2E_UI_LOCALES || locales.join(',')).split(','));
const root = path.resolve('artifacts/ui-translations/layout');

async function checkLayout(page, selector, { clipping = true } = {}) {
  return page.locator(selector).evaluateAll((elements, clipping) => elements.filter(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none';
  }).flatMap(element => {
    const rect = element.getBoundingClientRect();
    const overflow = rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
    const clipped = clipping && element.tagName !== 'SELECT' && element.tagName !== 'INPUT'
      && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2);
    return overflow || clipped ? [{ id: element.id, tag: element.tagName, text: element.textContent?.trim(),
      width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      height: rect.height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflow, clipped }] : [];
  }), clipping);
}

for (const locale of locales.filter(locale => selected.has(locale))) {
  test(`localizes and lays out ${locale} offline`, async ({}, testInfo) => {
    test.skip(process.env.PN_E2E_UI_LOCALIZATION !== '1', 'Opt in to the full locale layout matrix.');
    test.setTimeout(90_000);
    await mkdir(root, { recursive: true });
    const messages = JSON.parse(await readFile(`_locales/${locale}/messages.json`, 'utf8'));
    const copy = source => messages[messageKey(source)].message;
    const { context, cleanup } = await launchExtensionContext({ testInfo, locale });
    const requests = [], layouts = [];
    let actualLocale;
    try {
      await context.route(/^https?:\/\//u, route => { requests.push(route.request().url()); return route.abort('internetdisconnected'); });
      await context.setOffline(true);
      await seedFlowTestFlags(context);
      const engine = await openRoutedReaderEngine(context);
      const popup = await openExtensionPage(context, 'popup');
      actualLocale = await popup.evaluate(() => chrome.i18n.getUILanguage());
      const normalizedLocale = actualLocale.replace('-', '_').toLowerCase();
      expect(locale.includes('_') ? normalizedLocale : normalizedLocale.split('_')[0]).toBe(locale.toLowerCase());
      await expect(popup.locator('#start-reading')).toHaveText(copy('Read page'));
      expect(await popup.locator('html').getAttribute('lang')).toBe(actualLocale);
      await popup.locator('#popup-settings').evaluate(element => { element.open = true; });
      await popup.locator('#popup-advanced').evaluate(element => { element.open = true; });
      for (const width of [350, 320, 175]) {
        await popup.setViewportSize({ width, height: 900 });
        const failures = await checkLayout(popup, 'button, select, input, .settings summary, .field > span, .toggle');
        layouts.push({ surface: 'popup-settings', width, failures });
        await popup.screenshot({ path: path.join(root, `${locale}-popup-${width}.png`), fullPage: true });
        expect(failures, JSON.stringify(failures)).toEqual([]);
      }
      await selectNativeOption(popup.locator('#popup-tts-engine'), 'omnivoice');
      await expect(popup.locator('#popup-omnivoice-settings')).toBeVisible();
      await expect(popup.locator('#popup-omnivoice-gender option[value="female"]')).toHaveText(copy('Female'));
      for (const width of [350, 175]) {
        await popup.setViewportSize({ width, height: 900 });
        const failures = await checkLayout(popup, 'button, select, input, .settings summary, .field > span, .toggle, .field-help, .privacy-notice');
        layouts.push({ surface: 'popup-omnivoice', width, failures });
        await popup.screenshot({ path: path.join(root, `${locale}-omnivoice-${width}.png`), fullPage: true });
        expect(failures, JSON.stringify(failures)).toEqual([]);
      }
      await engine.evaluate(() => chrome.runtime.sendMessage({ type: 'readerStateChanged', state: 'paused',
        title: 'Untranslated article title', currentChunk: 1, totalChunks: 3,
        transcript: 'Untranslated article text.', queue: ['First source paragraph.', 'Second source paragraph.', 'Third source paragraph.'] }));
      await expect(popup.locator('#popup-toggle')).toHaveText(copy('Resume'));
      await expect(popup.locator('#popup-player-title')).toHaveText('Untranslated article title');
      for (const width of [350, 175]) {
        await popup.setViewportSize({ width, height: 900 });
        const failures = await checkLayout(popup, '.player-controls button, .queue-nav button, .queue-nav input');
        layouts.push({ surface: 'popup-player', width, failures });
        await popup.screenshot({ path: path.join(root, `${locale}-player-${width}.png`), fullPage: true });
        expect(failures, JSON.stringify(failures)).toEqual([]);
      }
      // The reader engine is intentionally hidden in production; inspect its translated controls in a diagnostic render.
      await engine.evaluate(() => { document.body.hidden = false; document.body.removeAttribute('aria-hidden');
        for (const details of document.querySelectorAll('details')) details.open = true; });
      await engine.setViewportSize({ width: 400, height: 900 });
      const readerFailures = await checkLayout(engine, 'button:not([hidden]), select, .controls > summary');
      layouts.push({ surface: 'reader-diagnostic', width: 400, failures: readerFailures });
      await engine.screenshot({ path: path.join(root, `${locale}-reader.png`), fullPage: true });
      expect(readerFailures, JSON.stringify(readerFailures)).toEqual([]);
      const extensionId = await getExtensionId(context);
      const pdf = await context.newPage();
      const bytes = await readFile('tests/fixtures/pdfs/single-column.pdf');
      await pdf.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
      await expect(pdf.locator('#pdf-status')).toHaveText(copy('$1 page loaded').replace('$arg1$', '1'));
      await expect(pdf.locator('.textLayer')).toContainText('PageNarrator single column fixture');
      await expect(pdf.locator('#pdf-zoom-out-btn')).toHaveAttribute('aria-label', copy('Zoom out'));
      for (const width of [900, 320]) {
        await pdf.setViewportSize({ width, height: 900 });
        await pdf.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
        await expect(pdf.locator('#pdf-toolbar')).toBeInViewport({ ratio: 1 });
        const failures = await checkLayout(pdf, '.viewer-header button, .viewer-header input, .toolbar-group');
        layouts.push({ surface: 'pdf', width, failures });
        await pdf.screenshot({ path: path.join(root, `${locale}-pdf-${width}.png`), fullPage: false });
        expect(failures, JSON.stringify(failures)).toEqual([]);
      }
      expect(requests).toEqual([]);
    } finally {
      await writeFile(path.join(root, `${locale}.json`), `${JSON.stringify({ locale, actualLocale,
        browserVersion: context.browser()?.version(), requests, layouts }, null, 2)}\n`);
      await cleanup();
    }
  });
}
