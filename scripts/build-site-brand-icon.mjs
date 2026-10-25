import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

// Reuse the canonical transparent artwork without adding a background badge.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_BRAND_ICON = 'website/public/assets/pagenarrator-icon.png';
const SIZE = 84; // 3x the 28px CSS box

export async function renderSiteBrandIcon(root = ROOT) {
  return sharp(join(root, 'icons/PageNarrator_Icon_Transparent.png')).trim()
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 }).toBuffer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeFile(join(ROOT, SITE_BRAND_ICON), await renderSiteBrandIcon());
  console.log(`Wrote ${SITE_BRAND_ICON}.`);
}
