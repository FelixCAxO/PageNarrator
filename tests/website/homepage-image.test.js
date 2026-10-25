import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');

it('uses a smaller, pixel-identical lossless WebP for the homepage hero', async () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const png = readFileSync(join(publicDir, 'assets/screenshots/toolbar-player-reading.png'));
  const webp = readFileSync(join(publicDir, 'assets/screenshots/toolbar-player-reading.webp'));
  const [original, optimized] = await Promise.all([
    sharp(png).raw().toBuffer({ resolveWithObject: true }),
    sharp(webp).raw().toBuffer({ resolveWithObject: true }),
  ]);

  const version = createHash('sha256').update(webp).digest('hex').slice(0, 12);
  expect(html).toContain(`src="/assets/screenshots/toolbar-player-reading.webp?v=${version}"`);
  expect(webp.length).toBeLessThan(png.length);
  expect(optimized.info).toMatchObject({ width: original.info.width, height: original.info.height, channels: original.info.channels });
  expect(optimized.data.equals(original.data)).toBe(true);
});
