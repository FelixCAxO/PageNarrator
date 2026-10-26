// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(path, 'utf8');
const scope = JSON.parse(read('config/language-rollout.json'));
const variants = scope.languages.flatMap(language => language.locales).map(locale => ({
  locale, tag: locale.replace('_', '-'), path: locale === 'en' ? '/' : `/${locale.replace('_', '-').toLowerCase()}`,
}));

describe('localized website landing pages', () => {
  it('keeps generated translations, sitemap and reciprocal language links current', () => {
    execFileSync(process.execPath, ['scripts/build-localized-homepages.mjs', '--check']);
    expect(variants).toHaveLength(26);
  });

  it.each(variants)('$locale has a crawlable translated page and a complete language switcher', variant => {
    const file = `website/public/${variant.path === '/' ? 'index' : variant.path.slice(1)}.html`;
    const document = new JSDOM(read(file)).window.document;
    const canonical = `https://pagenarrator.com${variant.path}`;
    expect(document.documentElement.lang).toBe(variant.tag);
    expect(document.querySelector('link[rel="canonical"]').href).toBe(canonical);
    expect(document.querySelector('meta[property="og:url"]').content).toBe(canonical);
    expect(document.querySelector('meta[name="robots"]')?.content || '').not.toContain('noindex');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    if (variant.locale !== 'en') {
      expect(document.querySelector('h1').textContent).not.toBe('Read aloud. Keep your place.');
      expect(document.body.textContent).not.toContain('Chrome Web Store availability is pending');
      expect(document.querySelector('meta[name="description"]').content).not.toContain('Listen to webpages and PDFs with a free browser');
    }
    for (const other of variants) {
      const alternate = document.querySelector(`link[hreflang="${other.tag}"]`);
      expect(alternate?.href).toBe(`https://pagenarrator.com${other.path}`);
      expect(document.querySelector(`.language-picker a[hreflang="${other.tag}"]`)?.getAttribute('href')).toBe(other.path);
    }
    expect(document.querySelector('link[hreflang="x-default"]').href).toBe('https://pagenarrator.com/');
    expect(document.querySelector('.language-picker a[aria-current="page"]').hreflang).toBe(variant.tag);
    expect(read('website/public/sitemap.xml')).toContain(`<loc>${canonical}</loc>`);
    expect(document.querySelector('img').getAttribute('srcset')).toContain('480w');
    expect([...document.querySelectorAll('link[href]')].some(link => /fonts\.googleapis|fonts\.gstatic/u.test(link.href))).toBe(false);
  });
});
