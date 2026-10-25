import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePdfAcceptanceCandidate } from '../../scripts/run-pdf-acceptance.mjs';

const directories = [];
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), 'pn-pdf-candidate-')); directories.push(root); return root;
}
function environment(extra = {}) {
  const env = { ...process.env }; delete env.PN_CANDIDATE_ID; delete env.GITHUB_SHA; delete env.GIT_CEILING_DIRECTORIES;
  return { ...env, ...extra };
}
function repository() {
  const root = directory(), options = { cwd: root, stdio: 'pipe', windowsHide: true };
  execFileSync('git', ['init', '--quiet'], options);
  execFileSync('git', ['-c', 'user.name=Original unit fixture', '-c', 'user.email=unit@example.test', '-c', 'commit.gpgSign=false',
    'commit', '--allow-empty', '--quiet', '-m', 'Original synthetic identity fixture'], options);
  return { root, head: execFileSync('git', ['rev-parse', 'HEAD'], { ...options, encoding: 'utf8' }).trim() };
}
afterEach(() => {
  for (const root of directories.splice(0)) {
    const relative = path.relative(realpathSync(tmpdir()), realpathSync(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe candidate fixture cleanup.');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PDF acceptance commit identity', () => {
  it('uses actual Git HEAD and verifies matching supplied IDs', async () => {
    const { root, head } = repository();
    expect(await resolvePdfAcceptanceCandidate({ rootDir: root, env: environment() }))
      .toEqual({ commitSha: head, provenance: 'git-verified', gitHead: head, gitRoot: realpathSync(root), supplied: {} });
    expect(await resolvePdfAcceptanceCandidate({ rootDir: root, env: environment({ PN_CANDIDATE_ID: head.toUpperCase(), GITHUB_SHA: head }) }))
      .toMatchObject({ commitSha: head, provenance: 'git-verified', supplied: { PN_CANDIDATE_ID: head, GITHUB_SHA: head } });
  });
  it('allows an explicit validated ID in an isolated Git-ceiling export and reports external provenance', async () => {
    const root = directory(), id = 'a'.repeat(40);
    const actual = await resolvePdfAcceptanceCandidate({ rootDir: root,
      env: environment({ PN_CANDIDATE_ID: id, GITHUB_SHA: id, GIT_CEILING_DIRECTORIES: path.dirname(root) }) });
    expect(actual).toEqual({ commitSha: id, provenance: 'externally-supplied-not-git-verified', gitHead: null, gitRoot: null,
      supplied: { PN_CANDIDATE_ID: id, GITHUB_SHA: id }, gitUnavailableReason: 'no-git-repository', gitCeilingDirectories: path.dirname(root) });
  });
  it('excludes an ancestor repository when an export omits its Git ceiling', async () => {
    const { root, head } = repository(), exported = path.join(root, 'immutable-export'); mkdirSync(exported);
    const id = head === 'd'.repeat(40) ? 'e'.repeat(40) : 'd'.repeat(40);
    await expect(resolvePdfAcceptanceCandidate({ rootDir: exported, env: environment() }))
      .rejects.toThrow('requires Git HEAD or an explicit full candidate ID');
    expect(await resolvePdfAcceptanceCandidate({ rootDir: exported, env: environment({ PN_CANDIDATE_ID: id }) }))
      .toMatchObject({ commitSha: id, provenance: 'externally-supplied-not-git-verified', gitHead: null, gitRoot: null,
        gitUnavailableReason: 'ancestor-repository-excluded', excludedAncestorRepository: { root: realpathSync(root), head } });
  });
  it('rejects different supplied IDs and a supplied ID inconsistent with available Git HEAD', async () => {
    const { root, head } = repository(), other = head === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40);
    await expect(resolvePdfAcceptanceCandidate({ rootDir: root, env: environment({ PN_CANDIDATE_ID: head, GITHUB_SHA: other }) }))
      .rejects.toThrow('Conflicting PDF acceptance candidate IDs');
    await expect(resolvePdfAcceptanceCandidate({ rootDir: root, env: environment({ PN_CANDIDATE_ID: other }) }))
      .rejects.toThrow('conflicts with Git HEAD');
  });
  it.each(['', 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(41), 12])('rejects malformed supplied ID: %s', async id => {
    await expect(resolvePdfAcceptanceCandidate({ rootDir: directory(), env: environment({ GITHUB_SHA: id }) }))
      .rejects.toThrow('Invalid PDF acceptance candidate ID');
  });
  it('refuses missing identity in a Git-free export', async () => {
    await expect(resolvePdfAcceptanceCandidate({ rootDir: directory(), env: environment() }))
      .rejects.toThrow('requires Git HEAD or an explicit full candidate ID');
  });
  it('does not hide broken existing repository metadata behind an externally supplied ID', async () => {
    const root = directory(); writeFileSync(path.join(root, '.git'), 'gitdir: missing-unit-repository\n');
    await expect(resolvePdfAcceptanceCandidate({ rootDir: root, env: environment({ PN_CANDIDATE_ID: 'a'.repeat(40) }) }))
      .rejects.toThrow('existing Git metadata');
  });
});
