import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');
const socialVersion = createHash('sha256').update(readFileSync(join(publicDir, 'og-image.jpg'))).digest('hex').slice(0, 12);
const socialUrl = `https://pagenarrator.com/og-image.jpg?v=${socialVersion}`;
const htmlFiles = readdirSync(publicDir).filter((name) => name.endsWith('.html'));
// cws-demo.html is a capture fixture; 404.html is served for unknown URLs. Neither is indexed.
const indexableFiles = htmlFiles.filter((name) => !['cws-demo.html', '404.html'].includes(name));

const readPage = (name) => new JSDOM(readFileSync(join(publicDir, name), 'utf8')).window.document;

describe('website SEO', () => {
  it('gives every indexable page complete, unique search and sharing metadata', () => {
    const titles = new Set();
    const descriptions = new Set();

    for (const file of indexableFiles) {
      const document = readPage(file);
      const title = document.title.trim();
      const description = document.querySelector('meta[name="description"]')?.content.trim();
      const canonical = document.querySelector('link[rel="canonical"]')?.href;

      expect(title, file).not.toBe('');
      expect(description, file).toBeTruthy();
      expect(canonical, file).toMatch(/^https:\/\/pagenarrator\.com\/(?:[a-z0-9-]+)?$/);
      expect(document.querySelectorAll('h1'), file).toHaveLength(1);
      expect(document.querySelector('meta[property="og:title"]')?.content, file).toBe(title);
      expect(document.querySelector('meta[property="og:description"]')?.content, file).toBe(description);
      expect(document.querySelector('meta[property="og:url"]')?.content, file).toBe(canonical);
      expect(document.querySelector('meta[property="og:image"]')?.content, file).toBe(socialUrl);
      expect(document.querySelector('meta[name="twitter:card"]')?.content, file).toBe('summary_large_image');
      expect(document.querySelector('meta[name="twitter:title"]')?.content, file).toBe(title);
      expect(document.querySelector('meta[name="twitter:description"]')?.content, file).toBe(description);
      expect(document.querySelector('meta[name="twitter:image"]')?.content, file).toBe(socialUrl);
      expect(titles.has(title), `duplicate title: ${title}`).toBe(false);
      expect(descriptions.has(description), `duplicate description: ${description}`).toBe(false);
      titles.add(title);
      descriptions.add(description);
    }
  });

  it('keeps internal page links valid and the demo out of search', () => {
    for (const file of htmlFiles) {
      const document = readPage(file);
      for (const link of document.querySelectorAll('a[href^="/"]')) {
        const path = link.getAttribute('href').split(/[?#]/)[0];
        const target = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
        expect(existsSync(join(publicDir, target)), `${file}: ${path}`).toBe(true);
      }
    }

    const demo = readPage('cws-demo.html');
    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8');
    expect(demo.querySelector('meta[name="robots"]')?.content).toBe('noindex, nofollow');
    expect(sitemap).not.toContain('cws-demo');
    for (const file of indexableFiles) {
      const route = file === 'index.html' ? '' : file.replace(/\.html$/, '');
      expect(sitemap, file).toContain(`<loc>https://pagenarrator.com/${route}</loc>`);
    }
  });

  it('serves a real not-found page instead of the homepage for unknown URLs', () => {
    // Cloudflare Pages returns 404.html with HTTP 404; without it, every unknown URL got
    // the homepage with HTTP 200 (a soft 404).
    const page = readPage('404.html');
    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8');
    expect(page.querySelector('meta[name="robots"]')?.content).toBe('noindex');
    expect(page.querySelector('link[rel="canonical"]')).toBeNull();
    expect(page.querySelector('h1')?.textContent).toBe('This page is not here');
    expect(page.querySelector('a.btn.primary')?.getAttribute('href')).toBe('/');
    expect(sitemap).not.toContain('404');
    // Served at arbitrary depths, so every asset and link must be root-relative.
    for (const element of page.querySelectorAll('[href], [src]')) {
      expect(element.getAttribute('href') ?? element.getAttribute('src')).toMatch(/^\/|^mailto:|^https:/);
    }
  });

  it('describes the free Chrome extension without a false store CTA', () => {
    const page = readPage('chrome-extension.html');
    const data = JSON.parse(page.querySelector('script[type="application/ld+json"]').textContent);
    const allHtml = indexableFiles.map((name) => readFileSync(join(publicDir, name), 'utf8')).join('\n');

    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'PageNarrator',
      operatingSystem: 'Chrome',
      applicationCategory: 'BrowserApplication',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    });
    expect(allHtml).not.toMatch(/href="\/chrome-extension"[^>]*>\s*(?:Install|Add to Chrome)/i);
    expect(page.body.textContent).toMatch(/Chrome Web Store listing is not (?:publicly )?available/i);
  });
});
