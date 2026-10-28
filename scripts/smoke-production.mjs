import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';

const defaultOrigin = 'https://pagenarrator.com';
const { DOMParser } = new JSDOM('').window;
const htmlParser = new DOMParser();
const publicDir = fileURLToPath(new URL('../website/public/', import.meta.url));
const requiredText = {
  '/': ['Read webpages and PDFs aloud.', 'No account or usage quota', 'Hugging Face'],
  '/chrome-extension': ['Install v1.0.2', 'Download the ZIP and extract it.', '93 MB', '326 MB', 'Update an unpacked installation'],
  '/support': ['source installation steps', 'Update without losing your place'],
  '/changelog': ['Version 1.0.2', 'Fixed voices in 32 languages', 'Cantonese and Thai can omit words'],
  '/privacy': ['Chrome Web Store User Data Policy', 'Limited Use requirements', 'Built-in voice downloads', 'Online documents'],
  '/terms': ['GPL-3.0-or-later', 'MIT License', 'Apache License 2.0', 'These Terms do not restrict rights granted by those licenses'],
};
// Pages serves 404.html for unmatched routes. Audit it through an unknown URL so a soft 404
// (the homepage with HTTP 200) fails the check.
const notFoundProbePath = '/pagenarrator-smoke-missing-page';
const pagePath = file => file === 'index.html' || file.endsWith('/index.html') ? `/${file.slice(0, -10)}` : `/${file.slice(0, -5)}`;
const unpublishedPaths = ['/cws-demo', '/cws-demo.html', '/.env', '/.dev.vars', '/package.json', '/docs/release-readiness.md'];
const hostRedirects = [{
  source: 'https://www.pagenarrator.com/*',
  destination: 'https://pagenarrator.com/:splat',
  status: 301,
}];

export function websiteHtmlFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? websiteHtmlFiles(directory, file) : entry.name.endsWith('.html') ? [file] : [];
  });
}

export function loadPageContracts(directory = publicDir) {
  const sitemap = readFileSync(join(directory, 'sitemap.xml'), 'utf8');
  const sitemapPaths = new Set([...sitemap.matchAll(/<loc>https:\/\/pagenarrator\.com(\/[^<]*)<\/loc>/g)].map((match) => match[1]));

  return websiteHtmlFiles(directory)
    .filter(name => name !== 'cws-demo.html')
    .sort()
    .map((file) => {
      const path = pagePath(file);
      const document = htmlParser.parseFromString(readFileSync(join(directory, file), 'utf8'), 'text/html');
      const indexable = !document.querySelector('meta[name="robots"]')?.content.includes('noindex');
      if (indexable !== sitemapPaths.has(path)) throw new Error(`${path} sitemap/noindex mismatch`);
      const contract = {
        file,
        path,
        ...(file.endsWith('404.html') ? { fetchPath: path.replace(/\/404$/u, notFoundProbePath), expectedStatus: 404 } : {}),
        lang: document.documentElement.lang,
        title: document.title,
        canonical: document.querySelector('link[rel="canonical"]')?.href,
        indexable,
        requiredText: requiredText[path] || [],
        requiredLinks: /\/(?:chrome-extension|changelog|support)$/u.test(path)
          ? ['https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.2/pagenarrator-1.0.2.zip',
            'https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.2/pagenarrator-1.0.2-source.zip',
            'https://github.com/FelixCAxO/PageNarrator/releases/tag/v1.0.2',
            ...(path.endsWith('/changelog') ? ['https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.2/pagenarrator-1.0.2-verification.md'] : [])] : [],
        forbiddenText: path === '/changelog' ? [] : ['Piper', 'browser voice', 'system voice'],
      };
      return contract;
    });
}

export function loadRedirectContracts(directory = publicDir) {
  const pathRedirects = readFileSync(join(directory, '_redirects'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map((line) => {
      const [source, destination, status] = line.split(/\s+/);
      return { source, destination, status: Number.parseInt(status, 10) };
    });
  return [...pathRedirects, ...hostRedirects];
}

export async function auditPage(siteOrigin, contract, fetchPage = fetch) {
  const response = await fetchPage(`${siteOrigin}${contract.fetchPath || contract.path}`, { redirect: 'follow' });
  const errors = [];
  if (contract.expectedStatus ? response.status !== contract.expectedStatus : !response.ok) errors.push(`HTTP ${response.status}`);

  const document = htmlParser.parseFromString(await response.text(), 'text/html');
  const title = document.title.trim();
  const description = document.querySelector('meta[name="description"]')?.content.trim();
  const robots = document.querySelector('meta[name="robots"]')?.content || '';
  const text = document.body.textContent.replace(/\s+/g, ' ').trim();

  if (!title) errors.push('missing title');
  if (contract.lang && document.documentElement.lang !== contract.lang) errors.push('wrong language');
  if (contract.title && title !== contract.title) errors.push('wrong translated title');
  if (document.querySelectorAll('h1').length !== 1) errors.push('expected one h1');
  if (contract.indexable && !description) errors.push('missing description');
  if (contract.indexable && document.querySelector('link[rel="canonical"]')?.href !== contract.canonical) errors.push('wrong canonical');
  if (contract.indexable && document.querySelector('meta[property="og:title"]')?.content !== title) errors.push('wrong og:title');
  if (contract.indexable && document.querySelector('meta[property="og:description"]')?.content !== description) errors.push('wrong og:description');
  if (contract.indexable === robots.includes('noindex')) errors.push(contract.indexable ? 'unexpected noindex' : 'missing noindex');
  if (/paddle|checkout|activate pro|\$\d|buy (?:now|pro)/i.test(text)) errors.push('commercial copy present');
  for (const phrase of contract.requiredText) {
    if (!text.includes(phrase)) errors.push(`missing text: ${phrase}`);
  }
  for (const phrase of contract.forbiddenText || []) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) errors.push(`obsolete text: ${phrase}`);
  }
  for (const href of contract.requiredLinks || []) {
    if (![...document.querySelectorAll('a[href], audio[src], source[src]')]
      .some(element => (element.getAttribute('href') || element.getAttribute('src')) === href)) errors.push(`missing link: ${href}`);
  }

  const internalUrls = [...document.querySelectorAll('a[href], link[href], img[src], script[src], audio[src], source[src]')]
    .map((element) => element.getAttribute('href') || element.getAttribute('src'))
    .filter((value) => value && !value.startsWith('#'))
    .map((value) => new URL(value, siteOrigin))
    .filter((url) => url.origin === siteOrigin && url.pathname !== '/cdn-cgi/l/email-protection')
    .map((url) => url.href);

  return { path: contract.path, errors, internalUrls };
}

export async function auditRedirect(siteOrigin, contract, fetchPage = fetch) {
  const source = contract.source.startsWith('http')
    ? contract.source.replace('*', 'smoke-check')
    : `${siteOrigin}${contract.source}`;
  const destination = new URL(contract.destination.replace(':splat', 'smoke-check'), siteOrigin).href;
  const response = await fetchPage(source, { redirect: 'manual' });
  const location = response.headers.get('location');
  const actualDestination = location ? new URL(location, siteOrigin).href : '';
  const errors = [];
  if (response.status !== contract.status) errors.push(`expected HTTP ${contract.status}, got ${response.status}`);
  if (actualDestination !== destination) errors.push(`expected ${destination}, got ${actualDestination || 'no location'}`);
  return { path: contract.source, errors };
}

export async function auditUnpublishedPath(siteOrigin, path, fetchPage = fetch) {
  const response = await fetchPage(`${siteOrigin}${path}`, { redirect: 'manual' });
  return { path, errors: response.status === 404 ? [] : [`expected HTTP 404, got ${response.status}`] };
}

export function websiteBuildIdentity(directory = publicDir) {
  const hash = createHash('sha256');
  const sitemap = readFileSync(join(directory, 'sitemap.xml'), 'utf8');
  const indexed = new Set([...sitemap.matchAll(/<loc>https:\/\/pagenarrator\.com(\/[^<]*)<\/loc>/gu)].map(match => match[1]));
  for (const file of websiteHtmlFiles(directory).filter(file => file !== 'cws-demo.html').sort()) {
    const path = pagePath(file);
    if (!indexed.has(path) && !path.endsWith('/404')) continue;
    hash.update(path).update('\0').update(readFileSync(join(directory, file)));
  }
  return hash.digest('hex');
}

export async function auditBuildIdentity(siteOrigin, directory = publicDir, fetchPage = fetch) {
  const response = await fetchPage(`${siteOrigin}/site-build.json`, { cache: 'no-store' });
  const actual = await response.json().catch(() => null);
  return { path: '/site-build.json', errors: response.ok && actual?.id === websiteBuildIdentity(directory) ? [] : ['deployed website build does not match expected sources'] };
}

export async function auditSite(siteOrigin, directory = publicDir, fetchPage = fetch) {
  // Keep the full language audit from flooding the host with hundreds of simultaneous requests.
  const batches = async (items, audit) => {
    const results = [];
    for (let offset = 0; offset < items.length; offset += 12) results.push(...await Promise.all(items.slice(offset, offset + 12).map(audit)));
    return results;
  };
  const pages = await batches(loadPageContracts(directory), (contract) => auditPage(siteOrigin, contract, fetchPage));
  const redirectContracts = loadRedirectContracts(directory)
    .filter(({ source }) => siteOrigin === defaultOrigin || !source.startsWith('http'));
  const redirects = await batches(redirectContracts, (contract) => auditRedirect(siteOrigin, contract, fetchPage));
  const unpublished = await Promise.all(unpublishedPaths.map((path) => auditUnpublishedPath(siteOrigin, path, fetchPage)));
  const resources = [...new Set(pages.flatMap((page) => page.internalUrls))];
  const resourceResults = await batches(resources, async (url) => {
    const response = await fetchPage(url, { redirect: 'follow' });
    return { path: url, errors: response.ok ? [] : [`HTTP ${response.status}`] };
  });
  const build = await auditBuildIdentity(siteOrigin, directory, fetchPage);
  return { pages, redirects, unpublished, resources: [...resourceResults, build] };
}

async function main() {
  const origin = String(process.argv[2] || process.env.PAGENARRATOR_ORIGIN || defaultOrigin).replace(/\/$/, '');
  const result = await auditSite(origin);
  const failures = [...result.pages, ...result.redirects, ...result.unpublished, ...result.resources].filter(({ errors }) => errors.length);
  if (failures.length) throw new Error(failures.map(({ path, errors }) => `${path}: ${errors.join(', ')}`).join('\n'));
  console.log(`Checked ${result.pages.length} pages, ${result.redirects.length} redirects, ${result.unpublished.length} unpublished paths, and ${result.resources.length} linked resources.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
