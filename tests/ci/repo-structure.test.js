import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

describe('repository structure guard', () => {
  it('runs the repo-structure guard from npm', () => {
    const packageJson = readJson('package.json');
    const result = spawnSync(process.execPath, ['scripts/check-repo-structure.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(packageJson.scripts['check:repo-structure']).toBe('node scripts/check-repo-structure.mjs');
    expect(existsSync(new URL('../../scripts/check-repo-structure.mjs', import.meta.url))).toBe(true);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('keeps the repo-structure guard in verify:fast', () => {
    const packageJson = readJson('package.json');
    const gates = readJson('config/verification-gates.json');

    expect(packageJson.scripts['verify:fast']).toBe('node scripts/run-verification-gate.mjs fast');
    expect(gates.fast).toContain('npm run check:repo-structure');
    expect(gates.fast.indexOf('npm run check:repo-structure')).toBeLessThan(gates.fast.indexOf('npm run lint'));
  });

  it('does not keep legacy-tree exclusions after removing the legacy tree', () => {
    const viteConfig = read('vite.config.js');
    const eslintConfig = readJson('.eslintrc.json');

    expect(viteConfig).not.toContain('PageNarrator_Old');
    expect(eslintConfig.ignorePatterns).not.toContain('PageNarrator_Old/');
  });

  it('keeps verification local without test or nightly Actions', () => {
    expect(existsSync(new URL('../../.github/workflows/test.yml', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../.github/workflows/nightly-real-sites.yml', import.meta.url))).toBe(false);
  });

  it('keeps literal TypeScript include and exclude paths tied to existing files', () => {
    for (const config of ['tsconfig.base.json', 'tsconfig.strict.json', 'tsconfig.boundaries.json']) {
      const { include = [], exclude = [] } = readJson(config);
      for (const path of [...include, ...exclude].filter((entry) => !/[?*]/.test(entry))) {
        expect(existsSync(new URL(`../../${path}`, import.meta.url)), `${config}: ${path}`).toBe(true);
      }
    }
  });

  it('documents the repo-structure guard in the regression gate', () => {
    const gates = JSON.parse(read('config/verification-gates.json'));
    expect(gates.fast).toContain('npm run check:repo-structure');
  });
});
