import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const publicDir = join(root, 'website/public');
const readText = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
// cws-demo.html is a noindex capture fixture, not reader-facing copy.
const pages = readdirSync(publicDir).filter((name) => name.endsWith('.html') && name !== 'cws-demo.html');
const documents = new Map(pages.map((name) => [name, new JSDOM(readText(`website/public/${name}`)).window.document]));
const bodyText = (name) => documents.get(name).body.textContent.replace(/\s+/g, ' ');

// Build and test vocabulary that leaked into reader-facing pages.
const internalJargon = [
  /\bchunks?\b/i,
  /\bpre-?buffer/i,
  /\bguardrails?\b/i,
  /\bcorpus\b/i,
  /release metadata/i,
  /published artifact/i,
  /resubmission/i,
  /\bBrowser-open\b/,
];

describe('website copy', () => {
  it('offers source installation without linking to removed releases or claiming Store availability', () => {
    const document = documents.get('chrome-extension.html');
    expect(document.querySelector('a[href="https://github.com/FelixCAxO/PageNarrator"]')).toBeTruthy();
    const text = bodyText('chrome-extension.html');
    for (const name of ['chrome-extension.html', 'support.html']) {
      expect(bodyText(name), name).not.toMatch(/repository is currently private|repository access is required|(?:already have|with) repository access|preview access/i);
    }
    expect(document.querySelector('a[href*="/releases/tag/"]')).toBeNull();
    expect(text).toContain('Previous release downloads are no longer available');
    expect(text).toContain('Chrome Web Store listing is not available yet');
    for (const step of ['Node.js 22.13+ (22.x) or 24+', 'npm ci', 'npm run build', 'chrome://extensions', 'Load unpacked', 'dist/']) {
      expect(text, step).toContain(step);
    }
    expect(bodyText('index.html')).toContain('Chrome Web Store availability is pending');
    expect(bodyText('changelog.html')).not.toMatch(/pitch, age/);
    for (const name of pages) expect(bodyText(name), name).not.toContain('private preview');
    expect(bodyText('changelog.html')).toContain('Version 1.0.1');
    for (const name of pages) {
      expect(documents.get(name).querySelector('a[href*="chromewebstore.google.com"], a[href*="chrome.google.com/webstore"]'), name).toBeNull();
    }
  });

  it('keeps build and test jargon out of reader-facing pages', () => {
    for (const name of pages) {
      for (const pattern of internalJargon) {
        expect(bodyText(name), `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('does not repeat words within a sentence such as "public ... publicly"', () => {
    for (const name of pages) {
      expect(bodyText(name), name).not.toMatch(/\bpublic\b[^.]*\bpublicly\b/i);
    }
  });

  it('keeps retired custom voices out of the active Store listing', () => {
    expect(readText('docs/cws-listing.md')).not.toMatch(/Optional user-configured custom voices|API key|Imported model/);
    const entries = [...documents.get('changelog.html').querySelectorAll('section')]
      .map((section) => section.textContent)
      .filter((text) => /^Version /.test(text));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^Version 1\.0\.1/);
    expect(entries[1]).toMatch(/^Version 1\.0\.0/);
    expect(entries[0]).not.toMatch(/custom voice|endpoint|imported model/i);
  });

  it('discloses local English OCR and its accuracy limits in the Store listing and PDF pages', () => {
    expect(readText('docs/cws-listing.md')).toContain('local English OCR');
    expect(readText('docs/cws-review-notes.md')).toContain('local English OCR');
    for (const name of ['read-pdf-aloud.html', 'read-research-papers-aloud.html']) {
      expect(bodyText(name), name).toContain('local English OCR');
      expect(bodyText(name), name).toMatch(/accuracy.*(?:scan|layout)/i);
    }
    for (const name of pages) {
      expect(bodyText(name), name).not.toMatch(/scanned,? image-only PDFs are not supported|does not read image-only scans|No OCR/i);
    }
  });

  it('discloses local narration and retention without offering endpoint voices', () => {
    for (const name of ['privacy.html', 'private-text-to-speech.html']) {
      expect(bodyText(name), name).not.toMatch(/If you configure|endpoint voice sends|Optional custom voices/);
    }
    expect(bodyText('privacy.html')).toContain('browser cache');
    expect(bodyText('privacy.html')).toContain('Google Fonts');
    expect(readText('website/public/index.html')).not.toContain('No account, uploads, or usage quota.');
    for (const path of ['website/public/privacy.html', 'website/public/private-text-to-speech.html', 'docs/cws-listing.md', 'src/popup.html']) {
      expect(readText(path), path).toContain('text excerpt');
    }
  });

  it('discloses built-in voice downloads and limits offline use to cached files', () => {
    for (const path of ['README.md', 'docs/cws-listing.md', 'docs/cws-review-notes.md', 'src/popup.html',
      'website/public/privacy.html', 'website/public/private-text-to-speech.html', 'website/public/how-it-works.html',
      'website/public/chrome-extension.html', 'website/public/index.html', 'website/public/support.html']) {
      const text = readText(path);
      expect(text, path).toContain('Hugging Face');
      expect(text, path).toMatch(/download/i);
      expect(text, path).not.toMatch(/bundled (?:English )?Kokoro voices|bundled voices run/i);
    }
    for (const path of ['README.md', 'docs/cws-listing.md', 'docs/cws-review-notes.md', 'website/public/privacy.html']) {
      const text = readText(path);
      expect(text, path).toMatch(/cache[\s\S]*offline|offline[\s\S]*cache/i);
      expect(text, path).toMatch(/clear|evict/i);
    }
    expect(bodyText('privacy.html')).toMatch(/Hugging Face[\s\S]*IP address[\s\S]*requested files/i);
    expect(bodyText('privacy.html')).toMatch(/does not receive[\s\S]*narration text/i);
    expect(readText('docs/cws-listing.md')).toMatch(/JavaScript, WebAssembly, and model runtime code ships inside the extension package/);
    expect(readText('src/popup.html')).toContain('Missing voice files download from Hugging Face');
  });

  it('describes each shared screenshot with one alt text', () => {
    const altsBySource = new Map();
    for (const document of documents.values()) {
      for (const image of document.querySelectorAll('img[src^="/assets/screenshots/"]')) {
        const alts = altsBySource.get(image.getAttribute('src')) || new Set();
        alts.add(image.getAttribute('alt'));
        altsBySource.set(image.getAttribute('src'), alts);
      }
    }

    expect(altsBySource.size).toBeGreaterThan(0);
    for (const [source, alts] of altsBySource) {
      expect([...alts], source).toHaveLength(1);
    }
  });

  it('describes local execution clearly after compatibility wording changes', () => {
    expect(bodyText('how-it-works.html')).toContain('The built-in Kokoro voices run on your device.');
    expect(bodyText('read-pdf-aloud.html')).toContain('Text extraction and built-in narration happen in your browser.');
    for (const name of pages) {
      expect(bodyText(name), name).not.toMatch(/(?:run|happen|Open a PDF|aloud) for Google Chrome/);
    }
  });
});
