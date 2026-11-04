import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Unique, sortable run identifier: 20261005T081500Z-a1b2c3.
 * @param {{ now?: Date, random?: (size: number) => Buffer }} [options]
 */
export function createRunId({ now = new Date(), random = randomBytes } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${random(3).toString('hex')}`;
}

/**
 * Git revision of the checkout that produced the build. A dirty tree is
 * recorded, never hidden; the extension hash identifies the exact build.
 * @param {{ root: string, run?: typeof spawnSync }} options
 */
export function resolveRevision({ root, run = spawnSync }) {
  const git = (args) => {
    const result = run('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? String(result.stdout || '') : null;
  };
  const commitSha = (git(['rev-parse', 'HEAD']) || '').trim();
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  const statusLines = status === null ? null : status.split(/\r?\n/).filter(Boolean);
  return {
    commitSha: /^[a-f0-9]{40}$/i.test(commitSha) ? commitSha : null,
    shortSha: /^[a-f0-9]{40}$/i.test(commitSha) ? commitSha.slice(0, 12) : null,
    dirty: statusLines === null ? null : statusLines.length > 0,
    dirtyPathCount: statusLines === null ? null : statusLines.length,
    statusDigest: statusLines === null ? null : sha256(statusLines.join('\n')),
  };
}

/**
 * Content hash of a directory: sorted relative paths plus each file's SHA-256.
 * @param {string} directory
 */
export async function hashDirectory(directory) {
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await walk(directory);
  const records = [];
  let bytes = 0;
  for (const filePath of files) {
    const content = await readFile(filePath);
    bytes += content.length;
    records.push(`${path.relative(directory, filePath).split(path.sep).join('/')}\0${sha256(content)}`);
  }
  records.sort();
  return { sha256: sha256(records.join('\n')), fileCount: records.length, bytes };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Artifact directory for one run. Repeated runs never overwrite each other.
 * @param {{ root: string, revision?: { shortSha?: string|null, dirty?: boolean|null }, runId: string }} options
 */
export function resolveRunOutputDir({ root, revision = {}, runId }) {
  if (!/^[0-9TZ-]+-[a-f0-9]{6}$/i.test(String(runId || ''))) throw new Error(`Invalid run id: ${runId}`);
  const revisionPart = `${revision.shortSha || 'unknown-revision'}${revision.dirty ? '-dirty' : ''}`;
  return path.join(root, 'artifacts', 'weak-hardware', revisionPart, runId);
}

/**
 * Launch description with the per-run temporary profile path redacted.
 * @param {{ executable: string, args: string[], userDataDir?: string|null, supervisor: string }} options
 */
export function describeLaunch({ executable, args, userDataDir = null, supervisor }) {
  const redact = (value) => (userDataDir ? String(value).split(userDataDir).join('<user-data-dir>') : String(value));
  return {
    executable,
    supervisor,
    args: args.map(redact),
    flags: args.filter((arg) => String(arg).startsWith('--')).map((arg) => redact(String(arg).split('=')[0])),
  };
}
