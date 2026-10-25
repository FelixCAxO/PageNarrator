import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
const ALLOWED_FACADES = new Set([
  'src/lib/article-extraction.js',
  'src/lib/reading-model.js',
  'src/lib/speech-audio.js',
  'src/lib/speech-playback.js',
]);
const CORE_OWNED_MODULES = [
  'reading-model',
  'speech-audio',
  'speech-playback',
];
const SIDE_PANEL_SESSION_CORE_IMPORTS = [
  '../../lib/core/reader-engine-read-orchestrator.js',
  '../../lib/core/reader-engine-message-router.js',
];
const SIDE_PANEL_SESSION_CORE_IMPORT_SET = new Set(SIDE_PANEL_SESSION_CORE_IMPORTS);
const IMPORT_RE = /(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return listJsFiles(path);
    return entry.endsWith('.js') ? [path] : [];
  });
}

function directCoreImports(source) {
  return [...source.matchAll(IMPORT_RE)]
    .map((match) => match[1] || match[2])
    .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'))
    .filter((specifier) => /(?:^|\/)lib\/core\//.test(specifier) || /(?:^|\/)core\//.test(specifier));
}

function facadeImportOffenders(files) {
  return files
    .filter(({ repoPath }) => !ALLOWED_FACADES.has(repoPath))
    .flatMap(({ repoPath, source }) => {
      const coreImports = directCoreImports(source);
      if (coreImports.length === 0) return [];
      if (repoPath === 'src/app/reader-engine/reader-engine-session.js') {
        const extraImports = coreImports.filter((specifier) => !SIDE_PANEL_SESSION_CORE_IMPORT_SET.has(specifier));
        const missingImports = SIDE_PANEL_SESSION_CORE_IMPORTS.filter((specifier) => !coreImports.includes(specifier));
        return [...extraImports, ...missingImports].map((specifier) => `${repoPath} -> ${specifier}`);
      }
      return [repoPath];
    });
}

describe('core facade import boundaries', () => {
  it('keeps runtime code on public lib facades except completed readerEngine core extractions', () => {
    const offenders = facadeImportOffenders(listJsFiles(SRC_DIR)
      .map((path) => ({
        path,
        repoPath: relative(ROOT, path).replace(/\\/g, '/'),
        source: readFileSync(path, 'utf8'),
      })));

    expect(offenders).toEqual([]);
  });

  it('allows only the two migrated reader-engine-session core imports', () => {
    const source = SIDE_PANEL_SESSION_CORE_IMPORTS
      .map((specifier) => `import {} from '${specifier}';`)
      .concat("import {} from '../../lib/core/third-core-module.js';")
      .join('\n');

    expect(facadeImportOffenders([{
      repoPath: 'src/app/reader-engine/reader-engine-session.js',
      source,
    }])).toEqual([
      'src/app/reader-engine/reader-engine-session.js -> ../../lib/core/third-core-module.js',
    ]);
  });

  it('keeps migrated shared-core implementations in core and legacy modules as thin facades', () => {
    for (const moduleName of CORE_OWNED_MODULES) {
      const corePath = join(ROOT, 'src', 'lib', 'core', `${moduleName}.js`);
      const facadePath = join(ROOT, 'src', 'lib', `${moduleName}.js`);
      const coreSource = readFileSync(corePath, 'utf8').trim();
      const facadeSource = readFileSync(facadePath, 'utf8').trim();

      expect(coreSource, `${moduleName} core implementation`).not.toMatch(/^export\s+\*\s+from\s+['"]\.\.\//);
      expect(facadeSource, `${moduleName} legacy facade`).toBe(`export * from './core/${moduleName}.js';`);
    }
  });

  it('removes completed readerEngine migration shims', () => {
    for (const removedShim of [
      'src/lib/reader-engine-message-router.js',
      'src/lib/reader-engine-read-orchestrator.js',
    ]) {
      expect(existsSync(join(ROOT, removedShim)), removedShim).toBe(false);
    }
  });

  it('keeps core modules from routing through migrated legacy facades', () => {
    const migratedLegacyImportPattern = /from\s+['"]\.\.\/(?:reading-model|speech-audio|speech-playback)\.js['"]/;
    const offenders = listJsFiles(join(ROOT, 'src', 'lib', 'core'))
      .map((path) => ({
        repoPath: relative(ROOT, path).replace(/\\/g, '/'),
        source: readFileSync(path, 'utf8'),
      }))
      .filter(({ source }) => migratedLegacyImportPattern.test(source))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });
});
