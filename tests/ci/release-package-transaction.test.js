import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { packageRelease } from '../../tooling/scripts/package-release.mjs';

vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, cpSync: vi.fn(fs.cpSync), renameSync: vi.fn(fs.renameSync), writeFileSync: vi.fn(fs.writeFileSync) };
});
vi.mock('node:child_process', async original => {
  const child = await original();
  return { ...child, execFileSync: vi.fn(child.execFileSync) };
});
vi.mock('../../tooling/scripts/assert-release-package.mjs', async original => ({
  ...await original(), assertReleasePackage: vi.fn(async () => ({ metrics: {} })),
}));

const fs = await vi.importActual('node:fs');
const child = await vi.importActual('node:child_process');
const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
let root, dist, source, output;
beforeEach(() => {
  vi.mocked(cpSync).mockReset().mockImplementation(fs.cpSync);
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
  root = fs.mkdtempSync(join(tmpdir(), 'pn-package-transaction-'));
  dist = join(root, 'dist'); source = join(root, 'source'); output = join(root, 'output');
  fs.mkdirSync(dist); fs.mkdirSync(source);
  fs.writeFileSync(join(dist, 'entry.js'), 'old build');
  fs.writeFileSync(join(source, 'package.json'), '{"version":"1.0.3"}');
  const git = args => child.execFileSync('git', args, { cwd: source, stdio: 'ignore' });
  git(['init']); git(['config', 'user.name', 'Release test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '.']); git(['commit', '-m', 'Fixture']);
  vi.mocked(execFileSync).mockReset().mockImplementation((command, args, options) => child.execFileSync(command, args,
    command === 'git' ? { ...options, cwd: source } : options));
  vi.stubEnv('PN_CANDIDATE_ID', undefined); vi.stubEnv('GITHUB_SHA', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(fs.realpathSync(root).startsWith(fs.realpathSync(tmpdir()) + sep)).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});
const snapshot = result => ({ binary: fs.readFileSync(result.outputPath), source: fs.readFileSync(result.sourcePath),
  extracted: fs.readFileSync(join(result.extractedDir, 'entry.js'), 'utf8') });
async function previous() {
  const result = await packageRelease(dist, { outputDir: output });
  const before = snapshot(result);
  fs.writeFileSync(join(dist, 'entry.js'), 'new build');
  return { result, before };
}
function noStaging() { expect(fs.readdirSync(output).some(name => name.startsWith('.pn-package-'))).toBe(false); }

it('replaces the archives and extracted build with a source-bound matching set', async () => {
  const { result, before } = await previous();
  await packageRelease(dist, { outputDir: output });
  const after = snapshot(result);
  expect(after.binary).not.toEqual(before.binary); expect(after.source).not.toEqual(before.source);
  expect(after.extracted).toBe('new build');
  const manifest = JSON.parse(child.execFileSync('tar', ['-xOf', result.sourcePath, 'SOURCE-MANIFEST.json'], { encoding: 'utf8' }));
  expect(manifest.binary.sha256).toBe(createHash('sha256').update(after.binary).digest('hex'));
  noStaging();
});

it.each(['candidate identity', 'dirty source'])('preserves the previous package when source export rejects %s', async reason => {
  const { result, before } = await previous();
  if (reason === 'candidate identity') vi.stubEnv('PN_CANDIDATE_ID', '0'.repeat(40));
  else fs.appendFileSync(join(source, 'package.json'), '\n');
  await expect(packageRelease(dist, { outputDir: output })).rejects.toThrow(/differs from HEAD|Commit source changes/);
  expect(snapshot(result)).toEqual(before); noStaging();
});

it('preserves the previous package when the ZIP budget fails', async () => {
  const { result, before } = await previous();
  await expect(packageRelease(dist, { outputDir: output, budgets: { zipBytes: 1 } })).rejects.toThrow('exceeds budget');
  expect(snapshot(result)).toEqual(before); noStaging();
});

it.each(['write', 'copy'])('preserves the previous package when staging cannot %s', async failure => {
  const { result, before } = await previous();
  if (failure === 'write') vi.mocked(writeFileSync).mockImplementation((path, ...args) => {
    if (path.endsWith('new-1')) throw new Error('Disk full');
    return fs.writeFileSync(path, ...args);
  });
  else vi.mocked(cpSync).mockImplementation(() => { throw new Error('Copy refused'); });
  await expect(packageRelease(dist, { outputDir: output })).rejects.toThrow(/Disk full|Copy refused/);
  expect(snapshot(result)).toEqual(before); noStaging();
});

it.each(['source', 'extracted'])('restores the complete previous set if the %s replacement fails', async failure => {
  const { result, before } = await previous();
  const target = failure === 'source' ? result.sourcePath : result.extractedDir;
  let refused = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (!refused && to === target && from.includes(`${sep}new-`)) { refused = true; throw new Error('Rename refused'); }
    return fs.renameSync(from, to);
  });
  await expect(packageRelease(dist, { outputDir: output })).rejects.toThrow('Rename refused');
  expect(refused).toBe(true); expect(snapshot(result)).toEqual(before); noStaging();
});

it('retains recoverable backups and reports both errors if rollback is also refused', async () => {
  const { result, before } = await previous();
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === result.sourcePath && from.endsWith('new-1')) throw new Error('Replacement refused');
    if (to === result.outputPath && from.endsWith(`old-${basename(result.outputPath)}`)) throw new Error('Restore refused');
    return fs.renameSync(from, to);
  });
  let failure;
  try { await packageRelease(dist, { outputDir: output }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toHaveLength(2);
  const staging = join(output, fs.readdirSync(output).find(name => name.startsWith('.pn-package-')));
  expect(failure.message).toContain(staging);
  expect(fs.readFileSync(join(staging, `old-${basename(result.outputPath)}`))).toEqual(before.binary);
  expect(fs.readFileSync(result.sourcePath)).toEqual(before.source);
  expect(fs.readFileSync(join(result.extractedDir, 'entry.js'), 'utf8')).toBe(before.extracted);
});

it.each(['default', 'explicit', 'alias'])('blocks test packages from canonical release paths: %s', mode => {
  const canonical = join(source, 'releases'); fs.mkdirSync(canonical);
  const directory = mode === 'alias' ? join(root, 'release-alias') : canonical;
  if (mode === 'alias') fs.symlinkSync(canonical, directory, 'junction');
  const code = `import { packageRelease } from ${JSON.stringify(new URL('../../tooling/scripts/package-release.mjs', import.meta.url).href)};
    let failure; try { await packageRelease(process.argv[1], JSON.parse(process.argv[2])); } catch (error) { failure = error.message; }
    console.log(JSON.stringify({ failure }));`;
  const result = JSON.parse(child.execFileSync(process.execPath, ['--input-type=module', '-e', code, dist,
    JSON.stringify({ skipPreflight: true, ...(mode === 'default' ? {} : { outputDir: directory }) })], { cwd: source, encoding: 'utf8' }));
  expect(result.failure).toContain('explicit output directory');
  expect(fs.readdirSync(canonical)).toEqual([]);
});

it('blocks test packaging over an existing source-bound pair in any output directory', async () => {
  const { result, before } = await previous();
  await expect(packageRelease(dist, { skipPreflight: true, outputDir: output })).rejects.toThrow('cannot replace a source-bound release');
  expect(snapshot(result)).toEqual(before); noStaging();
});

it.each(['archive', 'extracted'])('preserves an unexpected %s destination instead of replacing it', async mode => {
  fs.mkdirSync(output);
  const destination = join(output, `pagenarrator-${version}${mode === 'archive' ? '.zip' : ''}`);
  const sentinel = mode === 'archive' ? join(destination, 'leave-this.txt') : destination;
  if (mode === 'archive') fs.mkdirSync(destination);
  fs.writeFileSync(sentinel, 'existing data');
  await expect(packageRelease(dist, { outputDir: output })).rejects.toThrow(/destination is not a file|destination is not a directory/);
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('existing data'); noStaging();
});

it('refuses to replace an extracted directory containing its input', async () => {
  const input = join(output, `pagenarrator-${version}`, 'nested');
  fs.mkdirSync(input, { recursive: true }); fs.writeFileSync(join(input, 'entry.js'), 'input data');
  await expect(packageRelease(input, { outputDir: output })).rejects.toThrow('over the source');
  expect(fs.readFileSync(join(input, 'entry.js'), 'utf8')).toBe('input data');
  expect(fs.existsSync(join(output, `pagenarrator-${version}.zip`))).toBe(false); noStaging();
});
