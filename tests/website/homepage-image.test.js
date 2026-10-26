import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');

it('uses a smaller, pixel-identical lossless WebP for the homepage hero', async () => {
  const png = readFileSync(join(publicDir, 'assets/screenshots/toolbar-player-reading.png'));
  const webp = readFileSync(join(publicDir, 'assets/screenshots/toolbar-player-reading.webp'));
  const [original, optimized] = await Promise.all([
    sharp(png).raw().toBuffer({ resolveWithObject: true }),
    sharp(webp).raw().toBuffer({ resolveWithObject: true }),
  ]);

  expect(webp.length).toBeLessThan(png.length);
  expect(optimized.info).toMatchObject({ width: original.info.width, height: original.info.height, channels: original.info.channels });
  expect(optimized.data.equals(original.data)).toBe(true);
});

it('delivers a smaller responsive hero with explicit dimensions and high fetch priority', async () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  expect(html).toContain('width="1280" height="800" fetchpriority="high"');
  expect(html).toContain('480w,');
  const path = html.match(/\/assets\/home-hero-480-[a-f0-9]+\.webp/u)[0];
  const bytes = readFileSync(join(publicDir, path));
  const metadata = await sharp(bytes).metadata();
  expect(metadata.width).toBe(480);
  expect(bytes.length).toBeLessThan(25_000);
});
