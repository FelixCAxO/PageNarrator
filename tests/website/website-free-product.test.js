import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = join(import.meta.dirname, '../../website/public');

describe('free website', () => {
  it('has no purchase path and redirects old commercial URLs', () => {
    const files = readdirSync(publicDir).filter((name) => name.endsWith('.html'));
    const html = files.map((name) => readFileSync(join(publicDir, name), 'utf8')).join('\n');
    const redirects = readFileSync(join(publicDir, '_redirects'), 'utf8');

    expect(existsSync(join(publicDir, 'pricing.html'))).toBe(false);
    expect(existsSync(join(publicDir, 'activate.html'))).toBe(false);
    expect(existsSync(join(publicDir, 'refund.html'))).toBe(false);
    expect(html).not.toMatch(/paddle|checkout|\$\d|buy (?:now|pro)|activate pro/i);
    for (const path of ['/pricing', '/activate', '/refund']) {
      expect(redirects).toContain(`${path} /chrome-extension 301`);
    }
  });

  it('discloses both built-in and optional third-party voice processing', () => {
    const privacy = readFileSync(join(publicDir, 'privacy.html'), 'utf8');
    const html = readdirSync(publicDir)
      .filter((name) => name.endsWith('.html') && name !== 'changelog.html')
      .map((name) => readFileSync(join(publicDir, name), 'utf8'))
      .join('\n');

    expect(privacy).toContain('Chrome Web Store User Data Policy');
    expect(privacy).toContain('Limited Use requirements');
    expect(privacy).toMatch(/does not sell[^<]*data/i);
    expect(privacy).toContain('Built-in Kokoro voices run locally');
    expect(privacy).toContain('does not receive narration text');
    expect(privacy).toContain('API key');
    expect(privacy).toContain('clearing the extension');
    expect(privacy).not.toContain('Optional custom voices');
    expect(privacy).toContain('Online documents');
    expect(html).not.toMatch(/Piper|browser voice|system voice/i);
  });

  it('preserves open-source license rights in the terms', () => {
    const terms = readFileSync(join(publicDir, 'terms.html'), 'utf8');

    expect(terms).toContain('GPL-3.0-or-later');
    expect(terms).toContain('MIT License');
    expect(terms).toContain('Apache License 2.0');
    expect(terms).toContain('These Terms do not restrict rights granted by those licenses');
    expect(terms).not.toMatch(/revocable|non-transferable/);
  });
});
