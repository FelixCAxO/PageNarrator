import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('release metadata', () => {
  it('keeps extension and package versions in sync', () => {
    const packageJson = JSON.parse(read('package.json'));
    const packageLock = JSON.parse(read('package-lock.json'));
    const manifest = JSON.parse(read('manifest.json'));

    expect(packageJson.version).toBe('1.0.2');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(manifest.version).toBe(packageJson.version);
  });

  it('documents the unreleased candidate, latest published release and retained PDF highlight policy', () => {
    const changelog = read('website/public/changelog.html');
    const readerUi = read('docs/reader-ui.md');
    expect(read('CHANGELOG.md')).toContain('## 1.0.2 (unreleased)');

    expect(changelog).toContain('Version 1.0.1');
    expect(changelog).toContain('Version 1.0.0');
    expect(changelog.match(/<h2>Version /g)).toHaveLength(2);
    expect(readerUi).toContain('deterministic render-window management');
    expect(readerUi).toContain('CSS text-range highlight first');
    expect(readerUi).toContain('queued next-region overlay is disabled for PDFs');
  });
});
