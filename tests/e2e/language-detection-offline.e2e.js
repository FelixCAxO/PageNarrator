// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { launchExtensionContext, getExtensionId, seedFlowTestFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';
import { detectPageLanguage, normalizeDetectionSample } from '../../src/lib/language-detection.js';
import { getDetectedLanguageSuggestion, normalizeLanguageCode } from '../../src/lib/language-voice-options.js';
import { selectNativeOption } from './native-controls-fixture.js';

test('detects requested page languages offline with the real Chrome API and engine-aware suggestions', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_LANGUAGE_DETECTION !== '1', 'Opt in to the real offline detector benchmark.');
  test.setTimeout(120_000);
  const root = path.resolve(process.env.PN_E2E_LANGUAGE_AUDIT_DIR || 'artifacts/omnivoice-language-retest');
  const corpus = JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8'));
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  const networkRequests = [];
  try {
    await getExtensionId(context);
    const worker = context.serviceWorkers()[0];
    await context.route(/^https?:\/\//u, route => { networkRequests.push(route.request().url()); return route.abort('internetdisconnected'); });
    await context.setOffline(true);
    const samples = [];
    for (const code of new Set(corpus.languages.map(item => item.code))) {
      const cases = corpus.languages.filter(item => item.code === code);
      for (let index = 0; index < 3; index += 1) {
        samples.push({ code, id: `${code}-passage-${index + 1}`, kind: 'passage',
          text: cases.slice(index, index + 4).map(item => item.text).join(' ') });
      }
      for (const item of cases) samples.push({ code, id: item.id, kind: 'single-sentence', text: item.text });
    }
    samples.push({ code: 'und', id: 'too-short', kind: 'challenge', text: 'OK' });
    samples.push({ code: 'und', id: 'numbers', kind: 'challenge', text: '1234567890 '.repeat(20) });
    const results = [];
    for (const sample of samples) {
      const normalized = normalizeDetectionSample(sample.text);
      let raw = null;
      const detected = await detectPageLanguage(sample.text, { i18n: { detectLanguage: async () => {
        raw = await worker.evaluate(text => chrome.i18n.detectLanguage(text), normalized);
        return raw;
      } } });
      results.push({ ...sample, raw, detected, correct: detected.reliable && normalizeLanguageCode(detected.code) === sample.code,
        suggestions: { kokoro: getDetectedLanguageSuggestion(detected, 'kokoro'), omnivoice: getDetectedLanguageSuggestion(detected, 'omnivoice') } });
    }
    const report = { browserVersion: context.browser()?.version(), offline: true, networkRequests,
      scope: 'Real chrome.i18n.detectLanguage in a fresh extension profile with network disabled; source-language metadata is used only for scoring.',
      results, passages: results.filter(item => item.kind === 'passage').length,
      correctPassages: results.filter(item => item.kind === 'passage' && item.correct).length };
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'offline-language-detection.json'), `${JSON.stringify(report, null, 2)}\n`);
    expect(networkRequests).toEqual([]);
    expect(results.filter(item => item.kind === 'challenge').every(item => !item.detected.reliable)).toBe(true);
    for (const result of results.filter(item => item.detected.reliable)) {
      expect(result.suggestions.omnivoice).toMatchObject({ engine: 'omnivoice', supported: true });
      expect(result.suggestions.kokoro?.engine).toBe(normalizeLanguageCode(result.detected.code) === 'en' ? 'kokoro' : 'omnivoice');
    }
    console.log(JSON.stringify({ passages: report.passages, correct: report.correctPassages, networkRequests: networkRequests.length,
      missed: results.filter(item => item.kind === 'passage' && !item.correct).map(item => ({ id: item.id, detected: item.detected })) }));
    // Record accuracy failures instead of silently excluding languages from the benchmark.
    expect(report.correctPassages).toBe(report.passages);
  } finally { await cleanup(); }
});

for (const locale of ['en', 'sv', 'ja']) test(`the ${locale} player detects German offline for Kokoro and OmniVoice`, async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_LANGUAGE_DETECTION !== '1', 'Opt in to the real offline detector benchmark.');
  const root = path.resolve(process.env.PN_E2E_LANGUAGE_AUDIT_DIR || 'artifacts/omnivoice-language-retest');
  const corpus = JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8'));
  const text = corpus.languages.filter(item => item.code === 'de').slice(0, 4).map(item => item.text).join(' ');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Deliberately wrong page metadata: the suggestion must come from the actual text.
    response.end(`<html lang="en"><title>Language detection test</title><article><p>${text}</p></article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let cleanup = async () => {};
  try {
    const launched = await launchExtensionContext({ testInfo, locale, hostPermissions: ['http://127.0.0.1/*'] });
    cleanup = launched.cleanup;
    const { context } = launched;
    await seedFlowTestFlags(context);
    const engine = await openRoutedReaderEngine(context);
    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${server.address().port}`);
    const requests = [];
    await context.route(/^https?:\/\//u, route => { requests.push(route.request().url()); return route.abort('internetdisconnected'); });
    await context.setOffline(true);
    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
    const suggestion = await engine.evaluate(() => chrome.i18n.getMessage('languageSuggestionOmniVoice', [
      new Intl.DisplayNames([chrome.i18n.getUILanguage()], { type: 'language' }).of('de'),
    ]));
    expect(suggestion.length).toBeGreaterThan(20);
    await expect(popup.locator('#popup-error')).toHaveText(suggestion);
    await expect(engine.locator('#language-status')).toContainText(suggestion);
    await expect(popup.locator('#popup-tts-engine')).toHaveValue('kokoro');
    // The reader explicitly changes engines; detection must then select German without changing the UI locale.
    await selectNativeOption(popup.locator('#popup-tts-engine'), 'omnivoice');
    await expect(popup.locator('#popup-language')).toHaveValue('en');
    await popup.close();
    const omnivoicePopup = await startReadFromToolbarPopup(context, article, { closePopup: false });
    const worker = context.serviceWorkers()[0];
    await expect.poll(async () => (await worker.evaluate(() => chrome.storage.session.get('readerEngineState')))
      .readerEngineState?.state).toBe('finished');
    await expect(engine.locator('#language-select')).toHaveValue('de');
    await expect(omnivoicePopup.locator('#popup-tts-engine')).toHaveValue('omnivoice');
    expect((await omnivoicePopup.evaluate(() => chrome.i18n.getUILanguage())).split('-')[0]).toBe(locale);
    expect(requests).toEqual([]);
    await writeFile(path.join(root, `offline-player-${locale}.json`), `${JSON.stringify({ locale, detected: 'de',
      suggestion, kokoroRetainedUntilChoice: true, omnivoiceAutomaticallySelectedGerman: true,
      speech: 'silent flow fixture; real synthesis quality is measured separately', networkRequests: requests }, null, 2)}\n`);
  } finally { try { await cleanup(); } finally { await new Promise(resolve => server.close(resolve)); } }
});
