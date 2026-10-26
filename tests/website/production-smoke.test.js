import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditPage,
  auditBuildIdentity,
  websiteBuildIdentity,
  auditRedirect,
  auditUnpublishedPath,
  loadPageContracts,
  loadRedirectContracts,
} from '../../scripts/smoke-production.mjs';

const publicDir = join(import.meta.dirname, '../../website/public');

describe('production website smoke audit', () => {
  it('checks a mocked route through the rendered page contract', async () => {
    const html = readFileSync(join(publicDir, 'terms.html'), 'utf8');
    const fetchPage = async () => new Response(html, { status: 200 });

    await expect(auditPage('https://pagenarrator.com', {
      path: '/terms',
      canonical: 'https://pagenarrator.com/terms',
      indexable: true,
      requiredText: ['Apache License 2.0'],
      forbiddenText: ['browser voice'],
    }, fetchPage)).resolves.toMatchObject({ path: '/terms', errors: [] });
  });

  it('derives every page and redirect from the deployed website sources', () => {
    expect(loadPageContracts(publicDir)).toHaveLength(40);
    expect(loadPageContracts(publicDir).filter(({ indexable }) => indexable)).toHaveLength(39);
    expect(loadRedirectContracts(publicDir)).toHaveLength(47);
  });

  it('requires unknown URLs to return HTTP 404 with the not-found page, not a soft 404', async () => {
    const contract = loadPageContracts(publicDir).find(({ path }) => path === '/404');
    expect(contract).toMatchObject({ indexable: false, expectedStatus: 404 });
    expect(contract.fetchPath).not.toBe('/404');

    const notFound = readFileSync(join(publicDir, '404.html'), 'utf8');
    const requested = [];
    const served = await auditPage('https://pagenarrator.com', contract, async (url) => {
      requested.push(url);
      return new Response(notFound, { status: 404 });
    });
    expect(requested).toEqual([`https://pagenarrator.com${contract.fetchPath}`]);
    expect(served.errors).toEqual([]);

    // Before 404.html existed, Pages answered unknown URLs with the homepage and HTTP 200.
    const home = readFileSync(join(publicDir, 'index.html'), 'utf8');
    const soft = await auditPage('https://pagenarrator.com', contract, async () => new Response(home, { status: 200 }));
    expect(soft.errors).toEqual(expect.arrayContaining(['HTTP 200', 'missing noindex']));
  });

  it('keeps removed voice paths out of current website copy', () => {
    const html = loadPageContracts(publicDir)
      .filter(({ path }) => path !== '/changelog')
      .map(({ path }) => readFileSync(join(publicDir, path === '/' ? 'index.html' : `${path.slice(1)}.html`), 'utf8'))
      .join('\n');

    expect(html).not.toMatch(/Piper|browser voice|system voice/i);
  });

  it('rejects a privacy page that omits built-in download data handling', async () => {
    const contract = loadPageContracts(publicDir).find(({ path }) => path === '/privacy');
    const html = readFileSync(join(publicDir, 'privacy.html'), 'utf8');
    const current = await auditPage('https://pagenarrator.com', contract, async () => new Response(html));
    expect(current.errors).toEqual([]);
    const stale = html.replaceAll('Built-in voice downloads', 'Downloads');
    const result = await auditPage('https://pagenarrator.com', contract, async () => new Response(stale));
    expect(result.errors).not.toEqual([]);
  });

  it('checks redirect status and destination', async () => {
    const fetchPage = async () => new Response(null, {
      status: 301,
      headers: { location: '/chrome-extension' },
    });

    await expect(auditRedirect('https://pagenarrator.com', {
      source: '/pricing',
      destination: '/chrome-extension',
      status: 301,
    }, fetchPage)).resolves.toEqual({ path: '/pricing', errors: [] });
  });

  it('rejects a stale install page with missing source instructions', async () => {
    const contract = loadPageContracts(publicDir).find(({ path }) => path === '/chrome-extension');
    const html = readFileSync(join(publicDir, 'chrome-extension.html'), 'utf8');
    const current = await auditPage('https://pagenarrator.com', contract, async () => new Response(html));
    expect(current.errors).toEqual([]);
    const stale = html.replaceAll('Previous release downloads are no longer available', 'Old downloads are available')
      .replaceAll('https://github.com/FelixCAxO/PageNarrator', 'https://example.invalid');
    const result = await auditPage('https://pagenarrator.com', contract, async () => new Response(stale));
    expect(result.errors).toEqual(expect.arrayContaining([
      'missing text: Previous release downloads are no longer available',
      'missing link: https://github.com/FelixCAxO/PageNarrator',
    ]));
  });

  it('requires the deployed build identity to match the intended website sources', async () => {
    const id = websiteBuildIdentity(publicDir);
    const current = await auditBuildIdentity('https://pagenarrator.com', publicDir, async () => Response.json({ id }));
    expect(current.errors).toEqual([]);
    for (const response of [Response.json({ id: 'old-build' }), new Response('not found', { status: 404 })]) {
      expect((await auditBuildIdentity('https://pagenarrator.com', publicDir, async () => response)).errors).not.toEqual([]);
    }
  });

  it('requires capture fixtures and private paths to be unavailable, including redirects and soft 404s', async () => {
    const path = '/cws-demo.html';
    expect(await auditUnpublishedPath('https://pagenarrator.com', path,
      async () => new Response(null, { status: 404 }))).toEqual({ path, errors: [] });
    for (const status of [200, 301, 403, 500]) {
      const result = await auditUnpublishedPath('https://pagenarrator.com', path,
        async () => new Response(null, { status }));
      expect(result.errors).not.toEqual([]);
    }
  });
});
