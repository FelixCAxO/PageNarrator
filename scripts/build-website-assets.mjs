// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = 'website/public';
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const image = await readFile(`${root}/assets/screenshots/toolbar-player-reading.png`);
const variants = [];
for (const width of [480, 800, 1280]) {
  const bytes = await sharp(image).resize({ width }).webp({ quality: 82, effort: 6 }).toBuffer();
  const src = `/assets/home-hero-${width}-${hash(bytes)}.webp`;
  await writeFile(`${root}${src}`, bytes);
  variants.push({ width, src, bytes: bytes.length });
}
const fontVersion = hash(await readFile(`${root}/assets/fonts/newsreader.css`));
const siteVersion = hash((await readFile(`${root}/assets/site-1.0.7.1.css`, 'utf8')).replace(/\r\n/g, '\n'));
for (const file of (await readdir(root)).filter(file => file.endsWith('.html'))) {
  let html = await readFile(`${root}/${file}`, 'utf8');
  html = html.replace(/<link\b[^>]*rel="preconnect"[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"[^>]*>/gu, '')
    .replace(/<link\b[^>]*href="https:\/\/fonts\.googleapis\.com[^>]*>/gu, `<link rel="stylesheet" href="/assets/fonts/newsreader.css?v=${fontVersion}">`)
    .replace(/href="\/assets\/fonts\/newsreader\.css(?:\?v=[a-f0-9]+)?"/gu, `href="/assets/fonts/newsreader.css?v=${fontVersion}"`)
    .replace(/href="\/assets\/site-1\.0\.7\.1\.css(?:\?v=[a-f0-9]+)?"/gu, `href="/assets/site-1.0.7.1.css?v=${siteVersion}"`);
  if (file === 'index.html') {
    html = html.replace(/(<figure class="hero-visual">)<img\b[^>]*>/u, (_, figure) => `${figure}<img src="${variants.at(-1).src}" srcset="${variants.map(v => `${v.src} ${v.width}w`).join(', ')}" sizes="(max-width: 520px) calc(100vw - 40px), (max-width: 1184px) calc(100vw - 64px), 1120px" width="1280" height="800" fetchpriority="high" decoding="async" alt="PageNarrator reading a webpage and highlighting the current passage">`);
  }
  await writeFile(`${root}/${file}`, html.replace(/^[\t ]+$/gmu, ''));
}
let headers = await readFile(`${root}/_headers`, 'utf8');
headers = headers.replace(' https://fonts.googleapis.com', '').replace(' https://fonts.gstatic.com', '');
const start = '# BEGIN GENERATED WEBSITE ASSET CACHE', end = '# END GENERATED WEBSITE ASSET CACHE';
const paths = ['/assets/home-hero-*', ...((await readdir(`${root}/assets/fonts`)).filter(file => /^newsreader-[a-f0-9]+\.woff2$/u.test(file)).map(file => `/assets/fonts/${file}`))];
const cacheBlock = `${start}\n${paths.map(path => `${path}\n  Cache-Control: public, max-age=31536000, immutable`).join('\n')}\n${end}\n`;
headers = headers.includes(start)
  ? headers.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, 'u'), cacheBlock)
  : `${headers.trimEnd()}\n\n${cacheBlock}`;
await writeFile(`${root}/_headers`, headers);
console.log(JSON.stringify({ heroVariants: variants, fontStylesheet: 'self-hosted' }));
