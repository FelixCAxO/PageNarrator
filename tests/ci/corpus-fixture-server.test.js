import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCorpusFixtureServer } from '../e2e/corpus-fixture-server.js';

describe('corpus fixture server', () => {
  it('serves stripped offline article snapshots by slug', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pn-corpus-'));
    await writeFile(path.join(root, 'example-news.html'), '<!doctype html><main><h1>Offline</h1><p>Article body.</p></main>');

    const server = await startCorpusFixtureServer({ corpusDir: root });
    try {
      const response = await fetch(`${server.origin}/example-news.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Article body.');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves many concurrent requests for the same slug', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pn-corpus-'));
    await writeFile(path.join(root, 'concurrent.html'), '<!doctype html><main><p>Parallel body.</p></main>');
    const server = await startCorpusFixtureServer({ corpusDir: root });
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${server.origin}/concurrent.html`)));
      const bodies = await Promise.all(responses.map((response) => response.text()));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(bodies.every((body) => body.includes('Parallel body.'))).toBe(true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for missing slugs, 405 for non-GET, and no-store on hits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pn-corpus-'));
    await writeFile(path.join(root, 'present.html'), '<!doctype html><main><p>Here.</p></main>');
    const server = await startCorpusFixtureServer({ corpusDir: root });
    try {
      const hit = await fetch(`${server.origin}/present.html`);
      expect(hit.status).toBe(200);
      expect(hit.headers.get('cache-control')).toBe('no-store');
      await hit.text();
      const missing = await fetch(`${server.origin}/missing.html`);
      expect(missing.status).toBe(404);
      await missing.text();
      const post = await fetch(`${server.origin}/present.html`, { method: 'POST' });
      expect(post.status).toBe(405);
      await post.text();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
