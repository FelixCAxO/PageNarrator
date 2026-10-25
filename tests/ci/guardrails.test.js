import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

function readRepoFile(path) {
  return readFileSync(join(ROOT_DIR, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readRepoFile(path));
}

function strictIncludeCovers(includePattern, repoPath) {
  if (includePattern === repoPath) return true;
  const escaped = includePattern.replace(/\*\*/g, '\0')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`).test(repoPath);
}

describe('repository guardrails', () => {
  it('merges legacy meta-test files into this guardrails suite', () => {
    for (const legacyFile of [
      'tests/ci/tooling-hygiene.test.js',
      'tests/ci/typecheck-coverage.test.js',
      'tests/ci/ci-playwright-config.test.js',
    ]) {
      expect(existsSync(join(ROOT_DIR, legacyFile)), legacyFile).toBe(false);
    }
  });

  it('uses one Node preview entry point with a shell wrapper', () => {
    const packageJson = readJson('package.json');
    const shellWrapper = readRepoFile('preview.sh');

    expect(existsSync(join(ROOT_DIR, 'scripts/preview.mjs'))).toBe(true);
    expect(shellWrapper).toContain('exec node scripts/preview.mjs "$@"');
    expect(existsSync(join(ROOT_DIR, 'scripts/preview.ps1'))).toBe(false);
    expect(packageJson.scripts.preview).toBe('node scripts/preview.mjs');
    expect(packageJson.scripts['preview:pro']).toBeUndefined();
    expect(packageJson.devDependencies['cross-spawn']).toBe('^7.0.6');
  });

  it('keeps tsconfig lineage rooted in a shared base and runs the project file in typecheck', () => {
    const packageJson = readJson('package.json');
    const tsconfig = readJson('tsconfig.json');
    const strict = readJson('tsconfig.strict.json');
    const eslint = readJson('tsconfig.eslint.json');
    const base = readJson('tsconfig.base.json');
    const boundaries = readJson('tsconfig.boundaries.json');

    expect(existsSync(join(ROOT_DIR, 'tsconfig.base.json'))).toBe(true);
    expect(tsconfig.extends).toBe('./tsconfig.base.json');
    expect(strict.extends).toBe('./tsconfig.base.json');
    expect(eslint.extends).toBe('./tsconfig.base.json');
    expect(packageJson.scripts.typecheck).toBe('tsc -p tsconfig.strict.json');
    expect(packageJson.scripts['typecheck:boundaries']).toBe('tsc -p tsconfig.boundaries.json');
    expect(boundaries.extends).toBe('./tsconfig.base.json');
    expect(base.compilerOptions.checkJs).toBe(true);
    expect(boundaries.compilerOptions.checkJs ?? base.compilerOptions.checkJs).toBe(true);
    expect(boundaries.compilerOptions.strict).toBe(true);
    expect(boundaries.compilerOptions.noImplicitAny).toBe(true);
    expect(boundaries.include).toEqual(expect.arrayContaining([
      'src/reader/**/*.js', 'src/tts/**/*.js', 'src/platform/**/*.js',
      'src/ui/**/*.js', 'src/lib/core/**/*.js', 'src/types/**/*.d.ts',
    ]));
  });

  it('keeps a strict config for the existing checked JavaScript moat', () => {
    const strictConfig = readJson('tsconfig.strict.json');

    expect(strictConfig.extends).toBe('./tsconfig.base.json');
    expect(strictConfig.compilerOptions.strict).toBe(true);
    expect(strictConfig.include).toEqual(expect.arrayContaining([
      'src/content.js',
      'src/lib/message-types.js',
      'src/lib/playback-session.js',
      'src/lib/runtime-message-handlers.js',
      'src/lib/storage-keys.js',
    ]));
  });

  it('strict-checks every extracted readerEngine controller imported by the session', () => {
    const session = readRepoFile('src/app/reader-engine/reader-engine-session.js');
    const strictConfig = readJson('tsconfig.strict.json');
    const controllerImports = [...session.matchAll(/from '\.\.\/\.\.\/lib\/(reader-engine-[^']+-controller\.js)'/g)]
      .map((match) => `src/lib/${match[1]}`);

    expect(controllerImports.length).toBeGreaterThan(0);
    for (const repoPath of controllerImports) {
      expect(
        strictConfig.include.some((includePattern) => strictIncludeCovers(includePattern, repoPath)),
        `${repoPath} is imported by reader-engine-session.js but not covered by tsconfig.strict.json`,
      ).toBe(true);
    }
  });

  it('widens the base JavaScript typecheck to core and high-risk modules', () => {
    const config = readJson('tsconfig.base.json');

    expect(config.include).toEqual(expect.arrayContaining([
      'src/lib/reading-model.js',
      'src/lib/speech-audio.js',
      'src/lib/speech-playback.js',
      'src/lib/page-highlighter.js',
      'src/lib/dom-selectors.js',
      'src/lib/number-validation.js',
      'src/lib/timing-config.js',
      'src/lib/reading-cursor.js',
      'src/lib/playback-settings.js',
      'src/lib/highlight-search.js',
      'src/lib/language-detection.js',
      'src/lib/reader-engine-settings-manager.js',
      'src/lib/reader-engine-storage-adapter.js',
      'src/lib/playback-session.js',
      'src/lib/pdf-viewer-message-handler.js',
      'src/lib/runtime-message-handlers.js',
    ]));
  });

  it('declares browser runtime modules that otherwise collapse to any', () => {
    const globals = readRepoFile('src/types/globals.d.ts');

    expect(globals).not.toContain("declare module 'pdfjs-dist/legacy/build/pdf.mjs'");
    expect(globals).not.toContain("declare module 'kokoro-js'");
    expect(readRepoFile('src/engines/browser-inference.d.ts')).toContain('export class Tensor');
    expect(globals).not.toContain("declare module 'piper-tts-web'");
  });

  it('keeps unit, profile, PDF corpus, build, and Playwright checks runnable locally', () => {
    const packageJson = readJson('package.json');
    const gates = readJson('config/verification-gates.json');

    expect(packageJson.scripts['test:ci']).toBe('vitest run');
    expect(packageJson.scripts['test:reader']).toBe('vitest run tests/reader');
    expect(packageJson.scripts['test:platform']).toBe('vitest run tests/platform');
    expect(packageJson.scripts['test:build']).toBe('vitest run tests/build');
    expect(packageJson.scripts['test:core']).toBe('vitest run tests/ci');
    expect(packageJson.scripts['verify:fast']).toBe('node scripts/run-verification-gate.mjs fast');
    for (const command of ['npm run test:ci', 'npm run test:profiles', 'npm run test:pdf-corpus', 'npm run build']) {
      expect(gates.fast).toContain(command);
    }
    expect(gates.fast).toContain('npm run typecheck');
    expect(gates.release).toContain('npm run test:e2e');
    expect(packageJson.scripts.typecheck).toBe('tsc -p tsconfig.strict.json');
    expect(packageJson.scripts.clean).toBe('node scripts/clean.mjs');
    expect(packageJson.scripts.build).toBe('vite build');
    expect(packageJson.scripts.package).toContain('assert-release-package.mjs dist');
    expect(packageJson.scripts.package).toContain('package-release.mjs dist');
    expect(gates.release).toContain('npm run audit:runtime');
    const playwright = readRepoFile('playwright.config.js');
    expect(playwright).toContain("PN_E2E_EXTENSION_DIR || 'dist'");
    expect(`${JSON.stringify(gates)}\n${playwright}`).not.toMatch(/dist\/(standard|pro)|extension-(standard|pro)/i);
    expect(packageJson.engines.node).toBe('^22.13.0 || >=24.0.0');
    expect(readJson('package-lock.json').packages[''].engines.node).toBe(packageJson.engines.node);
    expect(readRepoFile('.nvmrc').trim()).toBe('22');
    expect(existsSync(join(ROOT_DIR, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(ROOT_DIR, 'tsconfig.base.json'))).toBe(true);
  });

  it('keeps Playwright extension tests separate from Vitest unit tests', () => {
    const playwrightConfig = readRepoFile('playwright.config.js');
    const viteConfig = readRepoFile('vite.config.js');

    expect(playwrightConfig).toContain('--load-extension');
    expect(playwrightConfig).toContain('tests/e2e');
    expect(viteConfig).toContain('tests/e2e/**');
    expect(viteConfig).toContain('tests/live/**');
    expect(viteConfig).toContain('tests/profiles/**');
    expect(playwrightConfig).toContain('PN_E2E_WORKERS');
    expect(playwrightConfig).toContain("process.env.PN_E2E_WORKERS || '2'");
    expect(playwrightConfig).toContain('workers: e2eWorkers');
    expect(playwrightConfig).toContain('PN_E2E_HEADED');
    expect(playwrightConfig).toContain("channel: 'chromium'");
    expect(playwrightConfig).toContain('headless: !e2eHeaded');
  });

  it('collects all profile tuning and memory budget tests in the profile lane', () => {
    const profileConfig = readRepoFile('vitest.profiles.config.js');

    expect(profileConfig).toContain('tests/profiles/tuning-config.test.js');
    expect(profileConfig).toContain('tests/profiles/lowpower-corpus-memory.test.js');
  });

  it('keeps live browser journeys in the local manual-live gate', () => {
    expect(readJson('config/verification-gates.json')['manual-live']).toContain('npm run test:live:no-build');
  });

  it('cleans generated output and keeps model weights out of source control', () => {
    const cleanScript = readRepoFile('scripts/clean.mjs');
    const gitignore = readRepoFile('.gitignore');

    expect(cleanScript).toContain('website-*.log');
    expect(cleanScript).not.toContain('archiveOldReleases');
    expect(gitignore).toContain('.cache/');
    expect(gitignore).toContain('public/voice-packs/*');
    expect(gitignore).toContain('!public/voice-packs/selected-manifest.json');
  });

  it('ships deterministic PDF fixtures and synchronized sprint docs', () => {
    expect(existsSync(join(ROOT_DIR, 'tests/fixtures/pdfs/single-column.pdf'))).toBe(true);
    expect(existsSync(join(ROOT_DIR, 'tests/fixtures/pdfs/two-column-citations.pdf'))).toBe(true);
    expect(readRepoFile('docs/regression-hardening.md')).toContain('mismatch between speech and webpage or PDF highlights');
    expect(readRepoFile('docs/regression-hardening.md')).toContain('test:live');
    expect(readRepoFile('docs/regression-hardening.md')).toContain('probe:tts');
    expect(readRepoFile('docs/regression-hardening.md')).toContain('npm run verify:release');
  });

});
