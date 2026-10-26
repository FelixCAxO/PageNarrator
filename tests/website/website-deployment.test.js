import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWebsite } from '../../scripts/build-website.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('public website deployment', () => {
  it('publishes reader pages and assets without local fixtures, credentials, source maps or stale output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pagenarrator-website-'));
    directories.push(directory);
    const source = join(directory, 'public'), output = join(directory, 'output');
    cpSync('website/public', source, { recursive: true });
    const privateFiles = ['.env', '.dev.vars', 'notes.md', 'credentials.json', 'private.pfx',
      'assets/site.css.map', 'assets/.env', 'assets/debug-capture.png', 'assets/diagnostics.js'];
    for (const file of privateFiles) writeFileSync(join(source, file), 'PRIVATE TEST CONTROL');
    writeFileSync(join(source, 'internal.html'), '<meta name="robots" content="noindex"><h1>Local test page</h1>');
    mkdirSync(output);
    writeFileSync(join(output, 'old-debug.html'), 'STALE TEST CONTROL');

    const result = buildWebsite(source, output);
    for (const file of [...privateFiles, 'internal.html', 'cws-demo.html', 'old-debug.html']) {
      expect(existsSync(join(output, file)), file).toBe(false);
    }
    for (const file of ['index.html', '404.html', 'privacy.html', '_headers', '_redirects',
      'assets/pagenarrator-icon.png', 'assets/screenshots/toolbar-player-reading.webp']) {
      expect(readFileSync(join(output, file)), file).toEqual(readFileSync(join(source, file)));
    }
    expect(result.files.filter(file => file.endsWith('.html'))).toHaveLength(390);
    for (const file of ['sv/index.html', 'de/index.html', 'ja/index.html', 'pt-br/index.html', 'pt-pt/index.html', 'sv/support.html', 'de/privacy.html', 'ja/terms.html', 'pt-pt/404.html', 'assets/fonts/OFL-Newsreader.txt']) {
      expect(readFileSync(join(output, file))).toEqual(readFileSync(join(source, file)));
    }
    expect(existsSync(join(source, 'cws-demo.html'))).toBe(true);
  });

  it('rejects an undeclared HTML page before replacing the previous build', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pagenarrator-website-'));
    directories.push(directory);
    const source = join(directory, 'public'), output = join(directory, 'output');
    cpSync('website/public', source, { recursive: true });
    writeFileSync(join(source, 'internal-debug.html'), '<h1>Private debug page</h1>');
    mkdirSync(output);
    writeFileSync(join(output, 'index.html'), 'PREVIOUS BUILD');

    expect(() => buildWebsite(source, output)).toThrow('sitemap/noindex mismatch');
    expect(readFileSync(join(output, 'index.html'), 'utf8')).toBe('PREVIOUS BUILD');
  });

  it('refuses to overwrite the website sources or an enclosing directory', () => {
    expect(() => buildWebsite('website/public', 'website/public')).toThrow('separate');
    expect(() => buildWebsite('website/public', 'website')).toThrow('separate');
    expect(() => buildWebsite('website/public', 'website/public/output')).toThrow('separate');
  });
});
