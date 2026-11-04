import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('release metadata', () => {
  it('keeps extension and package versions in sync', () => {
    const packageJson = JSON.parse(read('package.json'));
    const packageLock = JSON.parse(read('package-lock.json'));
    const manifest = JSON.parse(read('extension/manifest.json'));

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(manifest.version).toBe(packageJson.version);
  });
});
