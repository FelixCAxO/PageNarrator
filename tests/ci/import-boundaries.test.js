import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const CORE_DIR = join(ROOT, 'src', 'lib', 'core');
const IMPORT_RE = /(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return listJsFiles(path);
    return entry.endsWith('.js') ? [path] : [];
  });
}

function repoPath(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

function resolveSpecifier(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    return repoPath(resolve(dirname(fromFile), specifier));
  }
  return specifier;
}

function isForbiddenImport(resolvedSpecifier) {
  return (
    resolvedSpecifier.startsWith('src/app/')
    || resolvedSpecifier.startsWith('src/ui/')
    || resolvedSpecifier.startsWith('website/')
    || resolvedSpecifier.startsWith('src/platform/storage/')
    || resolvedSpecifier === 'chrome'
    || resolvedSpecifier.startsWith('chrome/')
  );
}

describe('architecture import boundaries', () => {
  it('keeps shared core free of extension app, UI, website, and storage imports', () => {
    const offenders = listJsFiles(CORE_DIR).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(IMPORT_RE)]
        .map((match) => match[1] || match[2])
        .map((specifier) => resolveSpecifier(file, specifier))
        .filter(isForbiddenImport)
        .map((specifier) => `${repoPath(file)} -> ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps shared core from reaching for Chrome globals directly', () => {
    const offenders = listJsFiles(CORE_DIR)
      .filter((file) => /\b(?:chrome|globalThis\.chrome)\b/.test(readFileSync(file, 'utf8')))
      .map(repoPath);

    expect(offenders).toEqual([]);
  });
});
