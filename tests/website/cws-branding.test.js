import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

// Chrome Web Store Branding Guidelines: Google marks may only describe compatibility
// ("for Google Chrome™"), never name or logo the product, and require attribution.
const root = process.cwd();
const attribution = 'Google Chrome is a trademark of Google LLC.';
const readText = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

function getFullDescription() {
  const listing = readText('docs/cws-listing.md');
  const match = listing.match(/## Full description\n([\s\S]*?)\n## /);
  if (!match) throw new Error('docs/cws-listing.md is missing the Full description section.');
  return match[1];
}

describe('Chrome Web Store branding', () => {
  it('keeps Google marks out of the extension name and short description', () => {
    const manifest = JSON.parse(readText('manifest.json'));
    expect(manifest.name).not.toMatch(/chrome|google/i);
    expect(manifest.short_name || '').not.toMatch(/chrome|google/i);
    expect(manifest.description).not.toMatch(/google/i);
  });

  it('references Chrome only as "for Google Chrome™" with attribution in the listing', () => {
    const description = getFullDescription();

    expect(description).toContain('for Google Chrome™');
    expect(description).toContain(attribution);
    expect(description).toContain('not affiliated with or endorsed by Google');
    // Google's attribution template ends with the permissions sentence.
    expect(description).toContain('Use of this trademark is subject to Google Permissions.');
    // Every product mention outside the attribution line is exactly "Google Chrome™";
    // a bare "Chrome" or an unmarked "Google Chrome" fails.
    for (const line of description.split('\n').filter((text) => /\bChrome\b/.test(text) && !text.includes(attribution))) {
      const mentions = line.match(/(?:Google\s+)?Chrome\b™?/g) || [];
      for (const mention of mentions) expect(mention, line).toBe('Google Chrome™');
    }
  });

  it('keeps Google marks and sentiment-gated rating asks out of extension UI strings', () => {
    const messages = Object.values(JSON.parse(readText('_locales/en/messages.json'))).map((entry) => entry.message);
    const pages = readdirSync(join(root, 'src')).filter((name) => name.endsWith('.html'))
      .map((name) => readText(`src/${name}`).replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' '));

    for (const text of [...messages, ...pages]) {
      expect(text).not.toMatch(/\b(?:Google|Gmail|Gemini|YouTube)\b|Chrome Web Store/);
      // The rating prompt goes to every eligible user; wording that asks only
      // satisfied users to rate reads as review gating under the ratings policy.
      expect(text).not.toMatch(/\b(?:enjoying|love|like)\s+PageNarrator\b/i);
    }
  });

  it('keeps website footers free of trademark boilerplate', () => {
    const pages = readdirSync(join(root, 'website/public')).filter((name) => name.endsWith('.html'));
    const footerPages = pages.filter((name) => readText(`website/public/${name}`).includes('class="site-footer"'));

    expect(footerPages.length).toBeGreaterThan(10);
    for (const name of footerPages) {
      const footer = new JSDOM(readText(`website/public/${name}`)).window.document.querySelector('.site-footer');
      expect(footer.textContent, name).not.toMatch(/trademark|not affiliated|endorsed by Google/i);
    }
  });

  it('keeps browser marketing qualifiers out of website copy and metadata', () => {
    for (const name of readdirSync(join(root, 'website/public')).filter((name) => name.endsWith('.html'))) {
      const html = readText(`website/public/${name}`);
      expect(html, name).not.toMatch(/\bfor\s+(?:Google\s+)?Chrome\b|™|&trade;|&#(?:8482|x2122);/i);
    }
  });
});
