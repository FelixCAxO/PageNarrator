import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');

it('delivers a smaller responsive hero with explicit dimensions and high fetch priority', async () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  expect(html).toContain('width="1280" height="800" fetchpriority="high"');
  expect(html).toContain('480w,');
  const path = html.match(/\/assets\/home-hero-480-[a-f0-9]+\.webp/u)[0];
  const bytes = readFileSync(join(publicDir, path));
  const metadata = await sharp(bytes).metadata();
  expect(metadata.width).toBe(480);
  expect(bytes.length).toBeLessThan(25_000);
  const variants = [...new Set(html.match(/home-hero-\d+-[a-f0-9]+\.webp/gu))].sort();
  expect(variants).toHaveLength(3);
  expect(readdirSync(join(publicDir, 'assets')).filter(name => /^home-hero-.*\.webp$/u.test(name)).sort()).toEqual(variants);
  for (const variant of variants) {
    const width = Number(variant.match(/^home-hero-(\d+)-/u)[1]);
    expect((await sharp(readFileSync(join(publicDir, 'assets', variant))).metadata()).width).toBe(width);
  }
});

it('removes superseded hero derivatives when rebuilding website assets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pn-hero-build-'));
  try {
    const source = join(directory, 'website/public');
    mkdirSync(join(directory, 'website'));
    cpSync(publicDir, source, { recursive: true });
    const obsolete = join(source, 'assets/home-hero-480-000000000000.webp');
    writeFileSync(obsolete, 'old generated control');
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../../tooling/scripts/build-website-assets.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 25_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(obsolete)).toBe(false);
    const html = readFileSync(join(source, 'index.html'), 'utf8');
    const retained = [...new Set(html.match(/home-hero-\d+-[a-f0-9]+\.webp/gu))].sort();
    expect(readdirSync(join(source, 'assets')).filter(name => /^home-hero-.*\.webp$/u.test(name)).sort()).toEqual(retained);
    expect(existsSync(join(source, 'assets/screenshots/toolbar-player-reading.png'))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
