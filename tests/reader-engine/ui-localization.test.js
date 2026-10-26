// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { localizeDocument, t, languageName, messageKey } from '../../src/lib/i18n.js';
import { validateTranslatedCatalog } from '../../scripts/prepare-translations.mjs';
import { VOICE_ENGINE_HELP } from '../../src/lib/omnivoice-settings.js';

const readJson = path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const source = readJson('_locales/en/messages.json');
const rollout = readJson('config/language-rollout.json');
const sources = readJson('config/ui-message-sources.json');
const locales = rollout.languages.flatMap(language => language.locales);

describe('packaged UI translations', () => {
  it('rebuilds every reviewed locale offline without drafting artifacts or a translation model', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pagenarrator-reviewed-locales-'));
    try {
      cpSync(new URL('../../config', import.meta.url), join(directory, 'config'), { recursive: true });
      cpSync(new URL('../../_locales/en', import.meta.url), join(directory, '_locales/en'), { recursive: true });
      execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-ui-translations.mjs', import.meta.url))], { cwd: directory });
      for (const locale of locales) {
        expect(JSON.parse(readFileSync(join(directory, '_locales', locale, 'messages.json'), 'utf8'))).toEqual(readJson(`_locales/${locale}/messages.json`));
      }
    } finally {
      if (!directory.startsWith(join(tmpdir(), 'pagenarrator-reviewed-locales-'))) throw new Error('Unexpected test directory');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps reviewed controls and recovery instructions from regressing to ambiguous draft wording', () => {
    const text = (locale, english) => readJson(`_locales/${locale}/messages.json`)[messageKey(english)].message;
    expect(text('sv', 'Sign in')).toBe('Logga in');
    expect(text('nl', 'min')).toBe('min');
    expect(text('ja', 'Free storage')).toBe('空き容量を確保');
    expect(text('ko', 'No text is selected.')).toBe('선택된 텍스트가 없습니다.');
    const caption = text('sv', 'Read page');
    expect(text('sv', 'Open the page, click the PageNarrator icon, then choose Read page.')).toContain(caption);
    const unverified = { en: 'unverified', de: 'nicht auf realen Geräten überprüft', pl: 'nie zostały potwierdzone', it: 'non sono state verificate', cs: 'nebyly ověřeny',
      pt_BR: 'não foram verificadas', pt_PT: 'não foram verificadas', sv: 'inte verifierats', da: 'ikke verificeret', fi: 'ei ole varmennettu', ro: 'nu au fost verificate',
      sk: 'neboli overené', et: 'pole füüsilistel seadmetel kontrollitud', bg: 'не са проверени', zh_CN: '尚未', ru: 'не проверены', ko: '검증되지 않았습니다',
      tr: 'doğrulanmamıştır', th: 'ยังไม่ได้ตรวจสอบ', uk: 'не перевірені', vi: 'chưa được kiểm chứng', id: 'belum diverifikasi', es: 'no se han verificado',
      fr: 'n’ont pas été vérifiés', nl: 'niet op fysieke apparaten geverifieerd', ja: '検証されていません' };
    for (const locale of locales) {
      const catalog = readJson(`_locales/${locale}/messages.json`);
      const hardware = catalog[messageKey('Use Chromium 120 or newer. Kokoro has a slower CPU fallback. Physical hardware tiers are unverified.')].message;
      expect(hardware).toContain('120');
      expect(hardware).toContain('Kokoro');
      expect(hardware).toContain('CPU');
      expect(hardware, `${locale}: hardware caveat`).toContain(unverified[locale]);
    }
  });

  it.each(locales)('%s contains complete messages and intact substitutions', locale => {
    const catalog = readJson(`_locales/${locale}/messages.json`);
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort());
    expect(validateTranslatedCatalog(source, catalog)).toEqual([]);
    for (const [key, entry] of Object.entries(catalog)) {
      expect(entry.message, `${locale}/${key}: leftover drafting token`).not.toMatch(/9876\d{4}/u);
      expect(entry.placeholders).toEqual(source[key].placeholders);
      for (const brand of ['PageNarrator', 'Kokoro', 'OmniVoice', 'Hugging Face', 'WebGPU', 'WebAssembly']) {
        if (source[key].message.includes(brand)) expect(entry.message, `${locale}/${key}`).toContain(brand);
      }
    }
    for (const english of Object.values(VOICE_ENGINE_HELP)) {
      const key = Object.entries(source).find(([, entry]) => entry.message === english)[0];
      const numbers = text => [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:MB|GB)\b/gu)]
        .map(match => Number(match[1].replace(',', '.'))).sort();
      expect(numbers(catalog[key].message), `${locale}: model requirements`).toEqual(numbers(english));
      if (english.includes('fp16')) expect(catalog[key].message).toContain('fp16');
    }
  });

  it('keeps all static controls and accessibility text wired without replacing nested controls', () => {
    for (const file of ['src/popup.html', 'src/reader-engine.html', 'src/pdf-viewer.html']) {
      const document = new JSDOM(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')).window.document;
      const walker = document.createTreeWalker(document.body, 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (!/[A-Za-z]{2}/u.test(text) || ['PageNarrator', 'WebGPU'].includes(text) || node.parentElement.closest('script,style')) continue;
        expect(node.parentElement.closest('[data-i18n]'), `${file}: ${text}`).not.toBeNull();
      }
      for (const element of document.querySelectorAll('[data-i18n]')) {
        expect(source[element.dataset.i18n], `${file}: ${element.outerHTML}`).toBeDefined();
        expect(element.querySelector('input,output,select,button,a'), 'Localizing a caption must preserve nested controls').toBeNull();
      }
      for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'data-label']) {
        for (const element of document.querySelectorAll(`[${attribute}]`)) {
          if (!/[A-Za-z]{2}/u.test(element.getAttribute(attribute))) continue;
          const key = element.getAttribute(`data-i18n-${attribute}`);
          expect(source[key], `${file}: ${attribute} ${element.outerHTML}`).toBeDefined();
        }
      }
    }
    for (const [key, entry] of Object.entries(sources)) {
      expect(source[key], entry.source).toBeDefined();
      expect(entry.locations.length).toBeGreaterThan(0);
    }
  });
});

describe('localization behavior', () => {
  it('preserves substituted article text literally with a missing catalog', () => {
    const i18n = { getMessage: () => '' };
    expect(t('Reading: $1', ['<b>Title</b> $2'], { i18n })).toBe('Reading: <b>Title</b> $2');
    expect(t('$1 of $2', [1, 20], { i18n })).toBe('1 of 20');
  });

  it('localizes accessibility attributes as text while preserving controls and source content', () => {
    const document = new JSDOM('<html><body><button data-i18n="read" data-i18n-title="hint" title="Read">Read</button><label><span data-i18n="voice">Voice</span><select><option value="af_heart">Heart</option></select></label><p id="article">Original source</p></body></html>').window.document;
    const i18n = { getUILanguage: () => 'sv', getMessage: vi.fn(key => ({ read: '<img src=x onerror=alert(1)>', hint: 'Läs sidan', voice: 'Röst', '@@bidi_dir': 'ltr' })[key]) };
    localizeDocument(document, { i18n });
    expect(document.documentElement.lang).toBe('sv');
    expect(document.querySelector('button').title).toBe('Läs sidan');
    expect(document.querySelector('button').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('option').value).toBe('af_heart');
    expect(document.querySelector('option').textContent).toBe('Heart');
    expect(document.querySelector('#article').textContent).toBe('Original source');
    expect(languageName('de', 'German', 'sv')).toBe('tyska');
  });
});
