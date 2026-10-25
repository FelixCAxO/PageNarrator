import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const root = process.cwd();
const neutralCwsDemoPath = 'website/public/cws-demo.html';
const neutralCaptureSourcePaths = [neutralCwsDemoPath];
const forbiddenCaptureSourcePatterns = [
  /Add to Chrome/i,
  /Chrome Web Store listing/i,
  /install path/i,
];
const requiredCwsAssetRule = 'CWS screenshots must not include install CTAs, Add to Chrome buttons, Chrome Web Store listing text, or acquisition-page copy.';
const PNG_SIGNATURE_BYTES = 8;
const websiteScreenshotPairs = [
  ['website/public/assets/screenshots/toolbar-player-idle.png', 'docs/cws-listing/screenshot-01-toolbar-player-idle.png'],
  ['website/public/assets/screenshots/toolbar-player-reading.png', 'docs/cws-listing/screenshot-02-toolbar-player-reading.png'],
  ['website/public/assets/screenshots/toolbar-player-settings.png', 'docs/cws-listing/screenshot-03-toolbar-player-settings.png'],
  ['website/public/assets/screenshots/toolbar-player-pdf.png', 'docs/cws-listing/screenshot-04-toolbar-player-pdf.png'],
  ['website/public/assets/screenshots/omnivoice-controls.png', 'docs/cws-listing/screenshot-05-omnivoice-controls.png'],
];
const submittedCwsPngAssets = [
  'docs/cws-listing/screenshot-01-toolbar-player-idle.png',
  'docs/cws-listing/screenshot-02-toolbar-player-reading.png',
  'docs/cws-listing/screenshot-03-toolbar-player-settings.png',
  'docs/cws-listing/screenshot-04-toolbar-player-pdf.png',
  'docs/cws-listing/screenshot-05-omnivoice-controls.png',
  'docs/cws-listing/promo-tile-440x280.png',
];

function readPngDimensions(path) {
  const bytes = readFileSync(join(root, path));
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readText(path) {
  return readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
}

function readJpegDimensions(path) {
  const bytes = readFileSync(join(root, path));
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`${path} is not a valid JPEG segment stream.`);
    }

    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  throw new Error(`${path} is missing a JPEG start-of-frame marker.`);
}

function readPngImage(path) {
  const bytes = readFileSync(join(root, path));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  const channels = colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`${path} must be a non-interlaced 8-bit RGB / 24-bit PNG with no alpha channel for Chrome Web Store.`);
  }

  const idatChunks = [];
  let offset = PNG_SIGNATURE_BYTES;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const rowOffset = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[source];
      source += 1;
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[rowOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[rowOffset - stride + x - bytesPerPixel] : 0;

      if (filter === 0) {
        pixels[rowOffset + x] = value;
      } else if (filter === 1) {
        pixels[rowOffset + x] = (value + left) & 0xff;
      } else if (filter === 2) {
        pixels[rowOffset + x] = (value + up) & 0xff;
      } else if (filter === 3) {
        pixels[rowOffset + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const predictor = left + up - upLeft;
        const leftDelta = Math.abs(predictor - left);
        const upDelta = Math.abs(predictor - up);
        const upLeftDelta = Math.abs(predictor - upLeft);
        const paeth = leftDelta <= upDelta && leftDelta <= upLeftDelta
          ? left
          : upDelta <= upLeftDelta ? up : upLeft;
        pixels[rowOffset + x] = (value + paeth) & 0xff;
      } else {
        throw new Error(`${path} uses unsupported PNG filter ${filter}.`);
      }
    }
  }

  return { width, height, channels, pixels };
}

function getImageTone(path) {
  const image = readPngImage(path);
  let luminanceTotal = 0;
  let darkPixels = 0;
  let yellowAccentPixels = 0;
  let sampledPixels = 0;

  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const offset = (y * image.width + x) * image.channels;
      const alpha = image.channels === 4 ? image.pixels[offset + 3] / 255 : 1;
      const red = image.pixels[offset] * alpha + 255 * (1 - alpha);
      const green = image.pixels[offset + 1] * alpha + 255 * (1 - alpha);
      const blue = image.pixels[offset + 2] * alpha + 255 * (1 - alpha);
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

      luminanceTotal += luminance;
      if (luminance < 90) darkPixels += 1;
      if (red > 190 && green > 150 && green < 240 && blue < 120) yellowAccentPixels += 1;
      sampledPixels += 1;
    }
  }

  return {
    averageLuminance: luminanceTotal / sampledPixels,
    darkRatio: darkPixels / sampledPixels,
    yellowAccentRatio: yellowAccentPixels / sampledPixels,
  };
}

describe('Chrome Web Store listing assets', () => {
  it('keeps forbidden acquisition copy out of neutral capture sources', () => {
    expect(existsSync(join(root, neutralCwsDemoPath)), `${neutralCwsDemoPath} should exist`).toBe(true);

    for (const sourcePath of neutralCaptureSourcePaths) {
      const source = readText(sourcePath);
      for (const forbiddenPattern of forbiddenCaptureSourcePatterns) {
        expect(source, `${sourcePath} should not include acquisition copy`).not.toMatch(forbiddenPattern);
      }
    }
  });

  it('documents the no-acquisition-copy rule for CWS media submission', () => {
    expect(readText('docs/cws-listing.md')).toContain(requiredCwsAssetRule);
    expect(readText('docs/cws-listing.md')).toContain('The 440x280 promo tile is intentionally unbadged');
    expect(readText('docs/launch-checklist.md')).toContain(requiredCwsAssetRule);
  });

  it('documents the dashboard replacement step for the exact submitted CWS media set', () => {
    const checklist = readText('docs/launch-checklist.md');

    expect(checklist).toContain('Delete every old rejected screenshot and promo tile from the Chrome Web Store dashboard');
    for (const assetPath of submittedCwsPngAssets) {
      expect(checklist).toContain(assetPath);
    }
  });

  it('keeps required screenshots and promo tile in docs', () => {
    const screenshots = [
      'docs/cws-listing/screenshot-01-toolbar-player-idle.png',
      'docs/cws-listing/screenshot-02-toolbar-player-reading.png',
      'docs/cws-listing/screenshot-03-toolbar-player-settings.png',
      'docs/cws-listing/screenshot-04-toolbar-player-pdf.png',
      'docs/cws-listing/screenshot-05-omnivoice-controls.png',
    ];

    for (const screenshot of screenshots) {
      expect(existsSync(join(root, screenshot))).toBe(true);
      expect(readPngDimensions(screenshot)).toEqual({ width: 1280, height: 800 });
    }

    expect(readPngDimensions('docs/cws-listing/promo-tile-440x280.png')).toEqual({
      width: 440,
      height: 280,
    });
  });

  it('OCR-audits forbidden copy in every submitted CWS PNG asset', () => {
    const result = spawnSync(process.execPath, ['scripts/audit-cws-media-text.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('OCR audited 6/6 CWS PNG assets');
  }, 120000);

  it('fails OCR media lint when a PNG contains forbidden install CTA copy', async () => {
    const tempRoot = join(tmpdir(), `pagenarrator-cws-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const fixturePath = join(tempRoot, 'forbidden-cws-copy.png');
    mkdirSync(tempRoot, { recursive: true });

    try {
      await sharp(Buffer.from(`
        <svg width="960" height="320" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#ffffff"/>
          <text x="72" y="184" font-family="Arial, Helvetica, sans-serif" font-size="78" font-weight="700" fill="#111111">Add to Chrome</text>
        </svg>
      `)).png().toFile(fixturePath);

      const result = spawnSync(process.execPath, ['scripts/audit-cws-media-text.mjs', fixturePath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/Add to Chrome/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120000);

  it.each([
    ['Google trademark', 'Google Research', /Google trademark/],
    ['Chrome trademark', 'Chrome extension', /Chrome trademark/],
    ['email address', 'reader@example.com', /email address/],
    ['removed voice claim', 'Piper voice models', /removed Piper voices/],
  ])('fails OCR media lint when a PNG shows a %s', async (_name, text, expectedLabel) => {
    const tempRoot = join(tmpdir(), `pagenarrator-cws-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const fixturePath = join(tempRoot, 'forbidden-cws-branding.png');
    mkdirSync(tempRoot, { recursive: true });

    try {
      await sharp(Buffer.from(`
        <svg width="1100" height="320" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#ffffff"/>
          <text x="60" y="184" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700" fill="#111111">${text}</text>
        </svg>
      `)).png().toFile(fixturePath);

      const result = spawnSync(process.execPath, ['scripts/audit-cws-media-text.mjs', fixturePath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(expectedLabel);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120000);

  it('captures listing media from PageNarrator-owned content only', () => {
    const captureScript = readText('scripts/capture-current-product-media.mjs');

    expect(captureScript).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)[^'"`\s]+\.pdf|arxiv\.org/i);
    expect(captureScript).toContain('A PageNarrator reading guide');
    expect(captureScript).toContain('writePromoTile');
  });

  it('records current capture inputs and the UI states shown by each screenshot', () => {
    const provenance = JSON.parse(readText('docs/cws-listing/capture-provenance.json'));
    expect(provenance.version).toBe(JSON.parse(readText('manifest.json')).version);
    expect(provenance.brandIconSha256, 'Recapture media after changing the shared logo').toBe(
      createHash('sha256').update(readFileSync(join(root, 'website/public/assets/pagenarrator-icon.png'))).digest('hex'),
    );
    for (const path of ['src/popup.html', 'src/popup.css', 'src/popup.js', 'src/pdf-viewer.html', 'src/pdf-viewer.css', 'src/pdf-viewer.js',
      neutralCwsDemoPath, 'scripts/capture-current-product-media.mjs']) {
      const hash = createHash('sha256').update(readText(path)).digest('hex');
      expect(provenance.sourceSha256?.[path], `Recapture media after changing ${path}`).toBe(hash);
    }
    for (const image of provenance.images) {
      expect(image.sha256).toBe(createHash('sha256').update(readFileSync(join(root, 'docs/cws-listing', image.name))).digest('hex'));
    }
    for (const index of [1, 3]) expect(provenance.images[index].state.status).toBe('Reading');
    const settings = provenance.images[2].state;
    expect(settings.advancedOpen).toBe(true);
    expect(settings.visibleControls).toEqual(expect.arrayContaining(['popup-section-pause', 'popup-skip-code', 'popup-area-color', 'popup-word-color']));
    const omniVoice = provenance.images.find(image => image.name === 'screenshot-05-omnivoice-controls.png').state;
    expect(omniVoice.visibleControls).toEqual(expect.arrayContaining(['popup-omnivoice-gender', 'popup-omnivoice-variation', 'popup-omnivoice-whisper', 'popup-speed']));
    expect(omniVoice.visibleControls).not.toContain('popup-omnivoice-tempo');
    expect(omniVoice.visibleControls).not.toContain('popup-omnivoice-pitch');
    expect(omniVoice.visibleControls).not.toContain('popup-omnivoice-age');
  });

  it('captures the native browser display without synthesizing screenshot UI', () => {
    const source = readText('scripts/capture-current-product-media.mjs');
    const screenshots = source.split('async function writePromoTile(')[0];
    expect(screenshots).toContain("execFileSync('import', ['-window', 'root', raw])");
    expect(screenshots).toContain('chrome.action.openPopup()');
    expect(screenshots).toContain('Input.dispatchMouseEvent');
    expect(screenshots).not.toMatch(/\.composite\(|\.resize\(|addStyleTag|addInitScript|reservePopupSpace/);
    expect(JSON.parse(readText('package.json')).scripts['capture:cws-media']).not.toContain('build');
  });

  it('uses the exact Chrome Web Store screenshots on the website', () => {
    for (const [websiteScreenshot, listingScreenshot] of websiteScreenshotPairs) {
      expect(readPngDimensions(listingScreenshot)).toEqual(readPngDimensions(websiteScreenshot));
      expect(readFileSync(join(root, websiteScreenshot))).toEqual(readFileSync(join(root, listingScreenshot)));
    }
  });

  // Store image guidance: the small tile should be saturated and full bleed, avoid a
  // lot of white or light gray, and keep text to a minimum.
  it('keeps the promo tile saturated and full bleed instead of mostly white', () => {
    const image = readPngImage('docs/cws-listing/promo-tile-440x280.png');
    let lightPixels = 0;
    let sampled = 0;
    const edgeSaturation = [];
    for (let y = 0; y < image.height; y += 2) {
      for (let x = 0; x < image.width; x += 2) {
        const offset = (y * image.width + x) * image.channels;
        const [red, green, blue] = [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        if (min > 200 && max - min < 30) lightPixels += 1;
        if (x === 0 || y === 0 || x >= image.width - 2 || y >= image.height - 2) {
          edgeSaturation.push(max === 0 ? 0 : (max - min) / max);
        }
        sampled += 1;
      }
    }
    expect(lightPixels / sampled, 'white or light gray share').toBeLessThan(0.25);
    expect(Math.min(...edgeSaturation), 'every edge pixel is saturated color').toBeGreaterThan(0.35);
    expect(readText('scripts/capture-current-product-media.mjs')).not.toMatch(/Listen to webpages and PDFs/);
  });

  it('keeps the player header in the screenshot-derived social image', async () => {
    expect(readJpegDimensions('website/public/og-image.jpg')).toEqual({
      width: 1200,
      height: 630,
    });
    const expected = await sharp(join(root, websiteScreenshotPairs[1][0]))
      .resize(1200, 630, { fit: 'cover', position: 'north' }).jpeg({ quality: 88 }).toBuffer();
    expect(readFileSync(join(root, 'website/public/og-image.jpg')).equals(expected)).toBe(true);
  });

  it('uses dark current-state screenshots and reserves yellow accents for active reading surfaces', () => {
    const darkScreenshots = [
      ...websiteScreenshotPairs.slice(0, 3).map(([website]) => website),
      ...websiteScreenshotPairs.slice(0, 3).map(([, store]) => store),
    ];

    for (const screenshot of darkScreenshots) {
      const tone = getImageTone(screenshot);
      expect(tone.averageLuminance, `${screenshot} should not be a stale light mockup`).toBeLessThan(125);
      expect(tone.darkRatio, `${screenshot} should be mostly dark UI`).toBeGreaterThan(0.5);
    }

    const activeReadingScreenshots = [
      'website/public/assets/screenshots/toolbar-player-reading.png',
      'website/public/assets/screenshots/toolbar-player-pdf.png',
      'docs/cws-listing/screenshot-02-toolbar-player-reading.png',
      'docs/cws-listing/screenshot-04-toolbar-player-pdf.png',
    ];

    for (const screenshot of activeReadingScreenshots) {
      const tone = getImageTone(screenshot);
      expect(tone.yellowAccentRatio, `${screenshot} should show the current yellow reading highlight`).toBeGreaterThan(0.0002);
    }
  });
});
