// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = 'website/public';
const home = JSON.parse(await readFile('website/locales/home.json', 'utf8'));
const check = process.argv.includes('--check');
const extract = process.argv.includes('--extract');
const variants = ['en', ...home.locales].map(locale => ({ locale, tag: locale.replace('_', '-'), prefix: locale === 'en' ? '' : `/${locale.replace('_', '-').toLowerCase()}` }));
const route = (variant, slug) => `${variant.prefix}/${slug === 'index' ? '' : slug}`;
const literal = text => /^(?:PageNarrator(?: [\d.]+)?|© \d{4} PageNarrator|support@pagenarrator\.com|[.·])$/u.test(text);
const blocks = 'main h1, main h2, main h3, main p, main li, main dt, main dd, main th, main td, main figcaption';
const messages = new Set(), outputs = new Map(), pages = [];
for (const file of (await readdir(root)).filter(file => file.endsWith('.html') && file !== 'cws-demo.html')) {
  const html = await readFile(`${root}/${file}`, 'utf8');
  if (!/<html lang="en">/u.test(html)) continue;
  pages.push({ slug: file.slice(0, -5), html, indexable: !/<meta name="robots" content="[^"]*noindex/u.test(html) });
}
for (const [source, values] of Object.entries(home.messages)) {
  if (values.split('|').length !== home.locales.length || values.split('|').some(value => !value.trim())) throw new Error(`Incomplete homepage translation: ${source}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(home.updatedAt)) throw new Error('Set the date of the last significant website content update.');
for (const variant of extract ? variants.slice(0, 1) : variants) {
  const catalog = variant.locale === 'en' ? {} : JSON.parse(await readFile(`website/locales/pages/${variant.locale}.json`, 'utf8'));
  const shared = source => home.messages[source]?.split('|')[home.locales.indexOf(variant.locale)];
  const translate = source => {
    if (literal(source)) return source;
    if (!Object.hasOwn(home.messages, source)) messages.add(source);
    if (variant.locale === 'en') return source;
    const translated = shared(source) ?? catalog[source];
    if (typeof translated !== 'string' || !translated.trim()) throw new Error(`Missing website translation (${variant.locale}): ${source}`);
    return translated;
  };
  for (const page of pages) {
    const dom = new JSDOM(page.html.trimEnd()), { document } = dom.window;
    document.querySelectorAll('.language-picker, .language-note, link[hreflang], meta[property="og:locale"]').forEach(element => element.remove());
    const translatedBlocks = new Set();
    for (const element of document.querySelectorAll(blocks)) {
      if (element.parentElement.closest('p, li, dt, dd, th, td, figcaption')) continue;
      const source = element.innerHTML;
      const walker = document.createTreeWalker(element, 4), nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) nodes.push(node);
      if (nodes.every(node => literal(node.textContent.trim()) || Object.hasOwn(home.messages, node.textContent.trim()))) {
        for (const node of nodes) node.textContent = node.textContent.replace(node.textContent.trim(), translate(node.textContent.trim()));
      } else element.innerHTML = translate(source);
      translatedBlocks.add(element);
    }
    const walker = document.createTreeWalker(document.documentElement, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const source = node.textContent.trim();
      if (!source || node.parentElement.closest('style, script') || [...translatedBlocks].some(element => element.contains(node))) continue;
      node.textContent = node.textContent.replace(source, translate(source));
    }
    for (const attribute of ['alt', 'aria-label', 'title']) for (const element of document.querySelectorAll(`[${attribute}]`)) {
      if (element.getAttribute(attribute)) element.setAttribute(attribute, translate(element.getAttribute(attribute)));
    }
    for (const element of document.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:description"], meta[property="og:image:alt"], meta[name="twitter:title"], meta[name="twitter:description"]')) element.content = translate(element.content);
    const canonical = `https://pagenarrator.com${route(variant, page.slug)}`;
    document.documentElement.lang = variant.tag;
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonical);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonical);
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const data = JSON.parse(script.textContent);
      if (data.description) data.description = translate(data.description);
      data.url = canonical; data.inLanguage = variant.tag; script.textContent = JSON.stringify(data);
    }
    for (const link of document.querySelectorAll('a[href]')) {
      const url = new URL(link.getAttribute('href'), 'https://pagenarrator.com');
      if (url.origin !== 'https://pagenarrator.com' || !link.getAttribute('href').startsWith('/')) continue;
      const target = pages.find(other => route(variants[0], other.slug) === url.pathname);
      if (target) { link.setAttribute('href', route(variant, target.slug) + url.search + url.hash); link.removeAttribute('hreflang'); }
    }
    if (page.indexable) {
      const og = document.createElement('meta'), locale = new Intl.Locale(variant.tag).maximize();
      og.setAttribute('property', 'og:locale'); og.content = `${locale.language}_${locale.region}`; document.head.append(og);
      for (const alternate of [...variants, { tag: 'x-default', prefix: '' }]) {
        const link = document.createElement('link'); link.rel = 'alternate'; link.hreflang = alternate.tag;
        link.href = `https://pagenarrator.com${route(alternate, page.slug)}`; document.head.append(link);
      }
    }
    const picker = document.createElement('details'); picker.className = 'language-picker';
    const summary = document.createElement('summary');
    summary.textContent = `🌐 ${new Intl.DisplayNames([variant.tag], { type: 'language' }).of(variant.tag)}`;
    summary.title = translate('Language'); picker.append(summary);
    const list = document.createElement('ul');
    for (const alternate of variants) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = route(alternate, page.indexable ? page.slug : 'index'); link.lang = alternate.tag; link.hreflang = alternate.tag;
      link.textContent = new Intl.DisplayNames([alternate.tag], { type: 'language' }).of(alternate.tag);
      if (alternate.locale === variant.locale) link.setAttribute('aria-current', 'page');
      item.append(link); list.append(item);
    }
    picker.append(list); document.querySelector('.nav-links').append(picker);
    const file = `${variant.prefix ? `${variant.prefix.slice(1)}/` : ''}${page.slug}`;
    outputs.set(`${root}/${file}.html`, dom.serialize() + '\n'); dom.window.close();
  }
}
if (extract) { console.log(JSON.stringify([...messages], null, 2)); }
else {
  const entries = variants.flatMap(variant => pages.filter(page => page.indexable).map(page => {
    const url = `https://pagenarrator.com${route(variant, page.slug)}`;
    return `  <url><loc>${url}</loc><lastmod>${home.updatedAt}</lastmod></url>`;
  }));
  outputs.set(`${root}/sitemap.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries.join('\n') + '\n</urlset>\n');
  const begin = '# BEGIN LOCALIZED WEBSITE REDIRECTS', end = '# END LOCALIZED WEBSITE REDIRECTS';
  const redirects = (await readFile(`${root}/_redirects`, 'utf8')).replace(/# BEGIN LOCALIZED (?:HOMEPAGE|WEBSITE) REDIRECTS[\s\S]*?# END LOCALIZED (?:HOMEPAGE|WEBSITE) REDIRECTS\n?/u, '').trimEnd();
  outputs.set(`${root}/_redirects`, `${redirects}\n\n${begin}\n/en / 301\n/en.html / 301\n${variants.slice(1).flatMap(variant => [
    `${variant.prefix} ${route(variant, 'index')} 301`,
    `${variant.prefix}.html ${route(variant, 'index')} 301`,
    ...pages.filter(page => page.indexable).map(page => `${variant.prefix}/${page.slug}.html ${route(variant, page.slug)} 301`),
  ]).join('\n')}\n${end}\n`);
  for (const [file, value] of outputs) {
    if (check) { if (await readFile(file, 'utf8') !== value) throw new Error(`Stale localized website file: ${file}`); }
    else { await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true }); await writeFile(file, value); }
  }
  for (const variant of variants.slice(1)) {
    const previousHome = `${root}${variant.prefix}.html`;
    if (check) {
      try { await readFile(previousHome); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Retired flat locale page must be removed: ${previousHome}`);
    }
    try { await unlink(previousHome); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(JSON.stringify({ locales: variants.length, pages: pages.length, indexableUrls: entries.length, check }));
}
