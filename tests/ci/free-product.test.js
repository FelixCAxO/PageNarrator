import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

describe('free product', () => {
  it('ships one unrestricted extension without licensing network access', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const packageJson = JSON.parse(read('package.json'));
    const source = [
      read('src/background.js'),
      read('src/popup.js'),
      read('src/app/reader-engine/reader-engine-session.js'),
    ].join('\n');

    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).not.toContain('alarms');
    expect(packageJson.scripts.build).toBe('vite build');
    expect(read('scripts/package-release.mjs')).toContain('pagenarrator-${packageJson.version}.zip');
    expect(source).not.toMatch(/license verification|reading quota|checkout|paddle/i);
  });
});
