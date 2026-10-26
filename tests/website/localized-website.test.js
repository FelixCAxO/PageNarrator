// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(path, 'utf8');
const scope = JSON.parse(read('config/language-rollout.json'));
const variants = scope.languages.flatMap(language => language.locales).map(locale => ({
  locale, tag: locale.replace('_', '-'), prefix: locale === 'en' ? '' : `/${locale.replace('_', '-').toLowerCase()}`,
}));
const slugs = ['index', 'chrome-extension', 'how-it-works', 'support', 'contact', 'changelog', 'privacy', 'terms',
  'private-text-to-speech', 'read-pdf-aloud', 'read-research-papers-aloud', 'listen-to-documentation-aloud',
  'speechify-alternative', 'naturalreader-alternative', '404'];
const route = (variant, slug) => `${variant.prefix}/${slug === 'index' ? '' : slug}`;
const file = (variant, slug) => `website/public/${variant.prefix ? `${variant.prefix.slice(1)}/` : ''}${slug}.html`;
const englishPaths = slugs.map(slug => route(variants[0], slug));
const sitemap = read('website/public/sitemap.xml');
const { DOMParser } = new JSDOM('').window;
const parser = new DOMParser();

describe('complete localized website', () => {
  it('keeps all pages, the sitemap and language links current without a translation service', () => {
    execFileSync(process.execPath, ['scripts/build-localized-website.mjs', '--check'], { timeout: 120_000 });
    expect(variants).toHaveLength(26);
    expect([...sitemap.matchAll(/<loc>/gu)]).toHaveLength(14 * 26);
  }, 120_000);

  it.each(variants)('$locale translates every page and keeps navigation in that language', variant => {
    for (const slug of slugs) {
      const document = parser.parseFromString(read(file(variant, slug)), 'text/html');
      const source = parser.parseFromString(read(file(variants[0], slug)), 'text/html');
      const canonical = `https://pagenarrator.com${route(variant, slug)}`;
      expect(document.documentElement.lang, `${variant.locale}/${slug}`).toBe(variant.tag);
      expect(document.querySelectorAll('h1')).toHaveLength(1);
      expect(document.querySelector('.language-note')).toBeNull();
      if (slug === '404') {
        expect(document.querySelector('meta[name="robots"]')?.content).toContain('noindex');
        expect(document.querySelector('link[rel="canonical"]')).toBeNull();
        expect(sitemap).not.toContain(`<loc>${canonical}</loc>`);
      } else {
        expect(document.querySelector('link[rel="canonical"]').href).toBe(canonical);
        expect(document.querySelector('meta[property="og:url"]').content).toBe(canonical);
        expect(document.querySelector('meta[name="robots"]')?.content || '').not.toContain('noindex');
        expect(sitemap).toContain(`<loc>${canonical}</loc>`);
        for (const other of variants) expect(document.querySelector(`link[hreflang="${other.tag}"]`)?.href).toBe(`https://pagenarrator.com${route(other, slug)}`);
        expect(document.querySelector('link[hreflang="x-default"]').href).toBe(`https://pagenarrator.com${route(variants[0], slug)}`);
      }
      for (const other of variants) expect(document.querySelector(`.language-picker a[hreflang="${other.tag}"]`)?.getAttribute('href')).toBe(route(other, slug === '404' ? 'index' : slug));
      expect(document.querySelector('.language-picker a[aria-current="page"]').hreflang).toBe(variant.tag);
      if (variant.locale !== 'en') {
        expect(document.title).not.toBe(source.title);
        expect(document.querySelector('meta[name="description"]').content).not.toBe(source.querySelector('meta[name="description"]').content);
        const sourceBlocks = [...source.querySelectorAll('main h1, main h2, main h3, main p, main li, main td, main th')];
        const targetBlocks = [...document.querySelectorAll('main h1, main h2, main h3, main p, main li, main td, main th')];
        expect(targetBlocks.length).toBe(sourceBlocks.length);
        for (const [index, block] of sourceBlocks.entries()) {
          const text = block.textContent.trim();
          if (text.split(/\s+/u).length >= 5 && /[a-z]{3}/u.test(text)) expect(targetBlocks[index].textContent.trim(), `${variant.locale}/${slug}: ${text}`).not.toBe(text);
        }
        for (const link of document.querySelectorAll('a[href^="/"]:not(.language-picker a)')) {
          const pathname = new URL(link.href, 'https://pagenarrator.com').pathname;
          expect(englishPaths, `${variant.locale}/${slug}: ${pathname}`).not.toContain(pathname);
        }
      }
      const schema = document.querySelector('script[type="application/ld+json"]');
      if (schema) expect(JSON.parse(schema.textContent)).toMatchObject({ url: canonical, inLanguage: variant.tag });
      expect([...document.querySelectorAll('link[href]')].some(link => /fonts\.googleapis|fonts\.gstatic/u.test(link.href))).toBe(false);
    }
  }, 60_000);

  it.each(variants.filter(variant => variant.locale !== 'en'))('$locale preserves all links, code, brands and technical values in the authored copy', variant => {
    const catalog = JSON.parse(read(`website/locales/pages/${variant.locale}.json`));
    const englishUi = JSON.parse(read('_locales/en/messages.json')), localizedUi = JSON.parse(read(`_locales/${variant.locale}/messages.json`));
    const controls = Object.fromEntries(Object.entries(englishUi).filter(([, value]) => ['Read page', 'Read selected', 'Prepare voice', 'Skip code snippets'].includes(value.message)).map(([key, value]) => [value.message, localizedUi[key].message]));
    for (const [source, translated] of Object.entries(catalog)) {
      expect(translated).not.toMatch(/987\s*6|\{\{inline\d+\}\}/u);
      const markup = html => [...JSDOM.fragment(html).querySelectorAll('*')].map(element => JSON.stringify({
        tag: element.tagName, attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(),
        ...(element.tagName === 'CODE' ? { code: element.textContent } : {}),
      })).sort();
      expect(markup(translated), `${variant.locale}: ${source}`).toEqual(markup(source));
      const sourceControls = [...JSDOM.fragment(source).querySelectorAll('strong')].map(element => element.textContent).filter(text => controls[text]);
      const targetControls = [...JSDOM.fragment(translated).querySelectorAll('strong')].map(element => element.textContent);
      for (const control of sourceControls) expect(targetControls, `${variant.locale}: ${control}`).toContain(controls[control]);
      for (const brand of ['PageNarrator', 'Kokoro', 'OmniVoice', 'WebGPU', 'WebAssembly', 'Hugging Face', 'Node.js', 'GitHub', 'Cloudflare', 'NaturalReader', 'Speechify', 'fp16']) {
        const count = value => value.split(brand).length - 1;
        expect(count(translated), `${variant.locale}: ${brand} in ${source}`).toBe(count(source));
      }
      const numbers = value => [...value.replace(/<[^>]*>/gu, '').matchAll(/\d+(?:[.,]\d+)*/gu)].map(match => match[0].replace(',', '.')).sort();
      if (!source.startsWith('Last updated:')) {
        const original = numbers(source), target = numbers(translated);
        for (const number of new Set(original)) expect(target.filter(value => value === number).length, `${variant.locale}: ${source}`).toBeGreaterThanOrEqual(original.filter(value => value === number).length);
      }
    }
  }, 60_000);
});
