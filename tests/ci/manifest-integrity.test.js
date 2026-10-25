import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function collectManifestPaths(manifest) {
  const paths = new Set();
  if (manifest.background?.service_worker) paths.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) paths.add(manifest.action.default_popup);
  if (manifest.side_panel?.default_path) paths.add(manifest.side_panel.default_path);
  if (manifest.options_page) paths.add(manifest.options_page);

  for (const script of manifest.content_scripts || []) {
    for (const jsPath of script.js || []) paths.add(jsPath);
  }

  return [...paths].sort();
}

describe('manifest integrity', () => {
  it('points source manifest entry files at real files before bundling', () => {
    const manifest = readJson('manifest.json');
    expect(manifest.incognito).toBe('not_allowed');

    expect(collectManifestPaths(manifest)).toEqual(expect.arrayContaining([
      'src/background.js',
      'src/popup.html',
    ]));

    for (const filePath of collectManifestPaths(manifest)) {
      expect(existsSync(join(ROOT, filePath)), filePath).toBe(true);
    }
  });

  it('points built manifest entry files at real bundled files when dist exists', () => {
    const distRoot = join(ROOT, 'dist');
    const manifestPath = join(distRoot, 'manifest.json');
    if (!existsSync(manifestPath)) return;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Offscreen sender authorization uses this exact emitted path without runtime.getManifest.
    expect(manifest.background.service_worker).toBe('service-worker-loader.js');
    for (const filePath of collectManifestPaths(manifest)) {
      const absolutePath = join(distRoot, filePath);
      expect(existsSync(absolutePath), filePath).toBe(true);
      expect(statSync(absolutePath).isFile(), filePath).toBe(true);
    }

    for (const pagePath of [
      manifest.action?.default_popup,
      manifest.side_panel?.default_path,
    ].filter(Boolean)) {
      expect(existsSync(join(distRoot, dirname(pagePath))), pagePath).toBe(true);
    }
  });
});
