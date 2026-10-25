import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSourceArchive, packageRelease } from '../../scripts/package-release.mjs';

function zipEntries(zip) {
  const entries = {};
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    const nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    const size = zip.readUInt32LE(offset + 18), start = offset + 30 + nameLength + extraLength;
    entries[zip.subarray(offset + 30, offset + 30 + nameLength).toString()] = inflateRawSync(zip.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

describe('release ZIP', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('is byte-identical when the same files are packaged again after a rebuild', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pn-release-zip-'));
    roots.push(root);
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'src'), { recursive: true });
    writeFileSync(join(dist, 'manifest.json'), '{"name":"PageNarrator"}\n');
    writeFileSync(join(dist, 'src', 'background.js'), 'export {};\n');

    const first = await packageRelease(dist, { skipPreflight: true, outputDir: join(root, 'first') });
    // A rebuild rewrites identical files with new modification times.
    for (const file of ['manifest.json', 'src/background.js']) {
      utimesSync(join(dist, file), new Date(2030, 5, 1, 12), new Date(2030, 5, 1, 12));
    }
    const second = await packageRelease(dist, { skipPreflight: true, outputDir: join(root, 'second') });
    writeFileSync(join(dist, 'src', 'background.js'), 'export const changed = true;\n');
    const changed = await packageRelease(dist, { skipPreflight: true, outputDir: join(root, 'changed') });

    expect(readFileSync(second.outputPath).equals(readFileSync(first.outputPath))).toBe(true);
    expect(readFileSync(changed.outputPath).equals(readFileSync(first.outputPath))).toBe(false);
  });

  it('exports only committed source and verifies distributed source before repackaging', () => {
    const root = mkdtempSync(join(tmpdir(), 'pn-source-files-'));
    roots.push(root);
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init']);
    git(['config', 'user.name', 'Release test']);
    git(['config', 'user.email', 'test@example.invalid']);
    for (const [path, contents] of Object.entries({ 'src/worker.js': 'committed source',
      '.gitignore': 'docs/cws-listing/debug-*.png\n.cache/\n', 'package.json': '{"version":"1.0.1"}',
      'public/index.html': 'committed page', '.eslintrc.json': '{}' })) {
      const target = join(root, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    git(['add', '.']); git(['commit', '-m', 'Fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    for (const path of ['docs/cws-listing/debug-audit.png', 'website/credentials.json', 'tests/customer-data.csv',
      'website/.env', '.cache/manifest.private.json', 'node_modules/library.js']) {
      mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'local private sentinel');
    }
    const binary = { name: 'extension.zip', sha256: 'a'.repeat(64) };
    const archive = createSourceArchive(root, binary, commit), entries = zipEntries(archive);
    expect(Object.keys(entries).sort()).toEqual(['.eslintrc.json', '.gitignore', 'SOURCE-MANIFEST.json', 'SOURCE-README.txt',
      'package.json', 'public/index.html', 'src/worker.js']);
    const manifest = JSON.parse(entries['SOURCE-MANIFEST.json']);
    expect(manifest.candidateId).toBe(commit); expect(manifest.binary).toEqual(binary);
    for (const row of manifest.files) expect(row.sha256).toBe(createHash('sha256').update(entries[row.path]).digest('hex'));
    expect(createSourceArchive(root, binary, commit).equals(archive)).toBe(true);
    expect(() => createSourceArchive(root, binary, 'b'.repeat(40))).toThrow('differs from HEAD');
    writeFileSync(join(root, 'src/worker.js'), 'unfinished tracked change');
    expect(() => createSourceArchive(root, binary, commit)).toThrow('Commit source changes');
    git(['add', 'website/credentials.json']);
    expect(() => createSourceArchive(root, binary, commit)).toThrow('Commit source changes');

    const exported = mkdtempSync(join(tmpdir(), 'pn-exported-source-')); roots.push(exported);
    for (const [path, bytes] of Object.entries(entries)) {
      mkdirSync(join(exported, path, '..'), { recursive: true }); writeFileSync(join(exported, path), bytes);
    }
    writeFileSync(join(exported, 'public/credentials.json'), 'unlisted private sentinel');
    expect(createSourceArchive(exported, binary, commit).equals(archive)).toBe(true);
    writeFileSync(join(exported, 'src/worker.js'), 'changed source export');
    expect(() => createSourceArchive(exported, binary, commit)).toThrow('differs from its manifest');
  });
});
