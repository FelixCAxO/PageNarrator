import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCpuOcrBrowser } from './ocr-cpu-browser.mjs';

export const DEFAULT_CWS_MEDIA_PATHS = [
  'docs/cws-listing/screenshot-01-toolbar-player-idle.png',
  'docs/cws-listing/screenshot-02-toolbar-player-reading.png',
  'docs/cws-listing/screenshot-03-toolbar-player-settings.png',
  'docs/cws-listing/screenshot-04-toolbar-player-pdf.png',
  'docs/cws-listing/screenshot-05-omnivoice-controls.png',
  'docs/cws-listing/promo-tile-440x280.png',
];

export const FORBIDDEN_CWS_MEDIA_TEXT = [
  { label: 'Add to Chrome', pattern: /\badd\s+to\s+chrome\b/i },
  { label: 'Chrome Web Store', pattern: /\bchrome\s+web\s+store\b/i },
  { label: 'Available in the Chrome Web Store', pattern: /\bavailable\s+(?:in|on)\s+(?:the\s+)?chrome\s+web\s+store\b/i },
  { label: 'install CTA', pattern: /\b(?:install|download|get)\s+(?:the\s+)?(?:extension|pagenarrator|now)\b/i },
  { label: 'Pro label', pattern: /\bpro\b/i },
  { label: 'upgrade CTA', pattern: /\bupgrade\b/i },
  { label: 'price', pattern: /\$\s*\d/ },
  // Project convention: submission media uses owned demo content without Google marks.
  // Chrome's branding rules also permit authentic, unaltered Google product screenshots.
  { label: 'Google trademark', pattern: /\b(?:google|gmail|gemini|youtube)\b/i },
  // This project's screenshots keep compatibility references in the text listing.
  { label: 'Chrome trademark', pattern: /\bchrome\b/i },
  // Program Policies (misleading functionality): features removed from the product.
  { label: 'removed Piper voices', pattern: /\bpiper\b/i },
  { label: 'removed browser voices', pattern: /\bbrowser\s+voices?\b/i },
  { label: 'removed custom voices', pattern: /\b(?:custom\s+voices?|byo\s+voices?|model\s+imports?)\b/i },
];

// Checked against raw OCR text, before punctuation is stripped.
export const FORBIDDEN_CWS_MEDIA_RAW_TEXT = [
  { label: 'email address', pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
];

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function prepareImageForOcr(path) {
  const image = sharp(path, { limitInputPixels: false }).flatten({ background: '#ffffff' });
  const metadata = await image.metadata();
  const preferredWidth = Math.max(1600, Math.min(2600, Math.round((metadata.width || 1280) * 1.75)));
  const targetWidth = Math.min(preferredWidth, Math.floor(Math.sqrt(4_000_000 * (metadata.width || 1280) / (metadata.height || 800))));

  return image
    .resize({ width: targetWidth, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
}

export function findForbiddenText(text) {
  const normalized = normalizeOcrText(text);
  return [
    ...FORBIDDEN_CWS_MEDIA_TEXT.filter(({ pattern }) => pattern.test(normalized)),
    ...FORBIDDEN_CWS_MEDIA_RAW_TEXT.filter(({ pattern }) => pattern.test(String(text || ''))),
  ].map(({ label }) => ({ label, text: normalized }));
}

export async function auditCwsMediaText(paths = DEFAULT_CWS_MEDIA_PATHS) {
  const resolvedPaths = paths.map((path) => resolve(path));
  const missingPath = resolvedPaths.find((path) => !existsSync(path));
  if (missingPath) {
    throw new Error(`CWS media asset does not exist: ${missingPath}`);
  }

  const worker = await createCpuOcrBrowser();

  try {
    const results = [];
    const findings = [];

    for (const path of resolvedPaths) {
      const image = await prepareImageForOcr(path);
      const { text } = await worker.recognize(image);
      const matches = findForbiddenText(text);
      results.push({ path, text });

      for (const match of matches) {
        findings.push({ path, ...match });
      }
    }

    return { results, findings };
  } finally {
    await worker.close();
  }
}

async function main() {
  const paths = process.argv.slice(2);
  const requestedPaths = paths.length ? paths : DEFAULT_CWS_MEDIA_PATHS;
  const { results, findings } = await auditCwsMediaText(requestedPaths);

  if (findings.length) {
    console.error('Forbidden CWS media text found:');
    for (const finding of findings) {
      console.error(`- ${finding.path}: ${finding.label}`);
      console.error(`  OCR text: ${finding.text}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`OCR audited ${results.length}/${requestedPaths.length} CWS PNG assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
