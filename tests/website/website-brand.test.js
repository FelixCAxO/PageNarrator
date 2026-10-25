import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { SITE_BRAND_ICON, renderSiteBrandIcon } from '../../scripts/build-site-brand-icon.mjs';

const root = join(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path));
const ICON_ASSET = '/assets/pagenarrator-icon.png';
const assetVersion = (path) => {
  const bytes = read(`website/public${path}`);
  return createHash('sha256').update(path.endsWith('.css') ? bytes.toString().replace(/\r\n/g, '\n') : bytes).digest('hex').slice(0, 12);
};
const SITE_ICON_URL = `${ICON_ASSET}?v=${assetVersion(ICON_ASSET)}`;

function brandRule(css) {
  return /\.brand::before\s*\{([^}]*)\}/.exec(css.replace(/\r\n/g, '\n'))?.[1] || '';
}

// The official logo is the document-and-speech-bubble icon (icons/). The site header once
// showed the decorative voice-line wave in its place.
it('uses the speech-bubble logo throughout the site without a competing wave mark', () => {
  const homepageCss = /href="(\/assets\/home-[a-f0-9]{16}\.css)"/.exec(read('website/public/index.html').toString())[1];
  for (const stylesheet of ['/assets/site-1.0.7.1.css', homepageCss]) {
    const css = read(join('website/public', stylesheet)).toString();
    const rule = brandRule(css);
    expect(rule, stylesheet).toContain(`url("${SITE_ICON_URL}")`);
    expect(rule, stylesheet).not.toMatch(/voice-mark|mask/);
    expect(css, stylesheet).not.toMatch(/voice-line\.svg|--voice-mark/);
    const eyebrow = /\.eyebrow::before\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(eyebrow, stylesheet).toContain(`url("${SITE_ICON_URL}")`);
  }
  const hero = /\.page-hero \.section-inner::after\s*\{([^}]*)\}/
    .exec(read('website/public/assets/site-1.0.7.1.css').toString())?.[1];
  expect(hero).toContain(`url("${SITE_ICON_URL}")`);
});

it('invalidates cached styles and product images when their bytes change', () => {
  for (const page of readdirSync(join(root, 'website/public')).filter((name) => name.endsWith('.html'))) {
    const html = read(`website/public/${page}`).toString();
    const resources = html.matchAll(/(\/assets\/(?:site-[\w.-]+\.css|screenshots\/[\w.-]+\.(?:png|webp))|\/og-image\.jpg)(?:\?v=([a-f0-9]+))?/g);
    for (const [, path, version] of resources) expect(version, `${page}: ${path}`).toBe(assetVersion(path));
  }
});

it('reuses the site logo and extension favicon on every extension page', () => {
  for (const page of ['popup', 'pdf-viewer', 'reader-engine']) {
    const css = read(`src/${page}.css`).toString();
    const html = read(`src/${page}.html`).toString();
    expect(css, page).toContain(`url("../website/public${ICON_ASSET}")`);
    expect(html, page).toContain('<link rel="icon" type="image/png" href="../icons/icon-32.png" />');
  }
});

it('derives the header icon from the canonical transparent artwork', async () => {
  // An alpha channel alone does not catch a white badge baked behind the logo.
  const { channels } = await sharp(read(SITE_BRAND_ICON)).stats();
  expect(channels[3].mean).toBeLessThan(128);
  const expected = await sharp(await renderSiteBrandIcon(root)).ensureAlpha().raw().toBuffer();
  const actual = await sharp(read(SITE_BRAND_ICON)).ensureAlpha().raw().toBuffer();
  expect(actual.length).toBe(expected.length);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference += Math.abs(actual[index] - expected[index]);
  expect(difference / actual.length).toBeLessThan(1);
});
