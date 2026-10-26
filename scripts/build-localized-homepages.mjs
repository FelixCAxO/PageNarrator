// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = 'website/public';
const catalog = JSON.parse(await readFile('website/locales/home.json', 'utf8'));
const check = process.argv.includes('--check');
const variants = [{ locale: 'en', tag: 'en', path: '/' }, ...catalog.locales.map(locale => ({
  locale, tag: locale.replace('_', '-'), path: `/${locale.replace('_', '-').toLowerCase()}`,
}))];
for (const [source, values] of Object.entries(catalog.messages)) {
  if (values.split('|').length !== catalog.locales.length || values.split('|').some(value => !value.trim())) throw new Error(`Incomplete website translation: ${source}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(catalog.updatedAt)) throw new Error('Set the date of the last significant homepage content update.');
const english = await readFile(`${root}/index.html`, 'utf8');
async function save(file, value) {
  if (check) { if (await readFile(file, 'utf8') !== value) throw new Error(`Stale localized website file: ${file}`); }
  else await writeFile(file, value);
}
for (const variant of variants) {
  const index = catalog.locales.indexOf(variant.locale);
  const translate = source => {
    if (variant.locale === 'en') return source;
    const result = catalog.messages[source]?.split('|')[index];
    if (!result) throw new Error(`Untranslated website text (${variant.locale}): ${source}`);
    return result;
  };
  const dom = new JSDOM(english.trimEnd());
  const { document } = dom.window;
  document.querySelectorAll('.language-picker, .language-note, link[hreflang], meta[property="og:locale"]').forEach(element => element.remove());
  const walker = document.createTreeWalker(document.documentElement, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const source = node.textContent.trim();
    if (!source || node.parentElement.closest('style, script') || /^PageNarrator(?: [\d.]+)?$|^© \d{4} PageNarrator$|^\.$/u.test(source)) continue;
    node.textContent = node.textContent.match(/^\s*/u)[0] + translate(source) + node.textContent.match(/\s*$/u)[0];
  }
  for (const attribute of ['alt', 'aria-label']) for (const element of document.querySelectorAll(`[${attribute}]`)) {
    if (element.getAttribute(attribute)) element.setAttribute(attribute, translate(element.getAttribute(attribute)));
  }
  for (const element of document.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:description"], meta[property="og:image:alt"], meta[name="twitter:title"], meta[name="twitter:description"]')) {
    element.content = translate(element.content);
  }
  const canonical = `https://pagenarrator.com${variant.path}`;
  document.documentElement.lang = variant.tag;
  document.querySelector('link[rel="canonical"]').href = canonical;
  document.querySelector('meta[property="og:url"]').content = canonical;
  document.querySelector('.brand').href = variant.path;
  const ogLocale = document.createElement('meta');
  const locale = new Intl.Locale(variant.tag).maximize();
  ogLocale.setAttribute('property', 'og:locale'); ogLocale.content = `${locale.language}_${locale.region}`;
  document.head.append(ogLocale);
  for (const alternate of [...variants, { tag: 'x-default', path: '/' }]) {
    const link = document.createElement('link'); link.rel = 'alternate'; link.hreflang = alternate.tag;
    link.href = `https://pagenarrator.com${alternate.path}`; document.head.append(link);
  }
  const picker = document.createElement('details'); picker.className = 'language-picker';
  const summary = document.createElement('summary');
  summary.textContent = `🌐 ${new Intl.DisplayNames([variant.tag], { type: 'language' }).of(variant.tag)}`;
  summary.title = translate('Language'); picker.append(summary);
  const list = document.createElement('ul');
  for (const alternate of variants) {
    const item = document.createElement('li'), link = document.createElement('a');
    link.href = alternate.path; link.lang = alternate.tag; link.hreflang = alternate.tag;
    link.textContent = new Intl.DisplayNames([alternate.tag], { type: 'language' }).of(alternate.tag);
    if (alternate.locale === variant.locale) link.setAttribute('aria-current', 'page');
    item.append(link); list.append(item);
  }
  picker.append(list); document.querySelector('.nav-links').append(picker);
  if (variant.locale !== 'en') {
    const note = document.createElement('p'); note.className = 'language-note';
    note.textContent = translate('Guides and installation instructions are in English.');
    document.querySelector('.hero-actions').after(note);
    document.querySelectorAll('a[href^="/"]:not([hreflang])').forEach(link => { if (link.getAttribute('href') !== variant.path) link.hreflang = 'en'; });
  }
  await save(`${root}/${variant.path === '/' ? 'index' : variant.path.slice(1)}.html`, dom.serialize() + '\n');
}
const previous = await readFile(`${root}/sitemap.xml`, 'utf8');
const entries = new Map([...previous.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?\s*<\/url>/gu)].map(match => [match[1], match[2]]));
for (const variant of variants) entries.set(`https://pagenarrator.com${variant.path}`, catalog.updatedAt);
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + [...entries].map(([url, date]) => `  <url><loc>${url}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>\n';
await save(`${root}/sitemap.xml`, sitemap);
const begin = '# BEGIN LOCALIZED HOMEPAGE REDIRECTS', end = '# END LOCALIZED HOMEPAGE REDIRECTS';
const redirects = (await readFile(`${root}/_redirects`, 'utf8')).replace(new RegExp(`${begin}[\\s\\S]*?${end}\\n?`, 'u'), '').trimEnd();
await save(`${root}/_redirects`, `${redirects}\n\n${begin}\n/en / 301\n/en.html / 301\n${variants.filter(v => v.path !== '/').map(v => `${v.path}.html ${v.path} 301`).join('\n')}\n${end}\n`);
console.log(JSON.stringify({ localizedHomepages: variants.length, languages: 25, sitemapUrls: entries.size, check }));
