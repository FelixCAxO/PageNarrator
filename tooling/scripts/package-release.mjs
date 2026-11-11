import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleasePackage, DEFAULT_RELEASE_ARTIFACT_BUDGETS } from './assert-release-package.mjs';

export async function packageRelease(packageDir, options = {}) {
  const sourceDir = resolve(packageDir);
  const preflight = options.skipPreflight ? null : await assertReleasePackage(sourceDir, options);

  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const outputDir = resolve(options.outputDir || 'releases');
  const canonicalDir = resolve('releases');
  if (options.skipPreflight && !options.dryRun && (!options.outputDir || outputDir === canonicalDir
    || existsSync(outputDir) && existsSync(canonicalDir) && realpathSync(outputDir) === realpathSync(canonicalDir))) {
    throw new Error('Test packaging requires an explicit output directory outside the canonical releases directory.');
  }
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, `pagenarrator-${packageJson.version}.zip`);
  const extractedDir = join(outputDir, `pagenarrator-${packageJson.version}`);
  if (options.skipPreflight && !options.dryRun && existsSync(join(outputDir, `pagenarrator-${packageJson.version}-source.zip`))) {
    throw new Error('Test packaging cannot replace a source-bound release; choose a separate output directory.');
  }
  const files = listFiles(sourceDir);
  if (options.dryRun) {
    return {
      outputPath,
      extractedDir,
      fileCount: files.length,
      dryRun: true,
      files: files.map((filePath) => ({
        path: filePath,
        sha256: createHash('sha256').update(readFileSync(resolve(sourceDir, filePath))).digest('hex'),
      })),
    };
  }
  const binary = createZip(sourceDir, files);
  assertZipBudget(binary.length, options.budgets);
  const rawBuildBytes = totalFileBytes(sourceDir, files);
  const zipBytes = binary.length;
  // Convey matching source alongside the binary without loading or duplicating it in the extension.
  const sourcePath = options.skipPreflight ? null : join(outputDir, `pagenarrator-${packageJson.version}-source.zip`);
  const source = sourcePath ? createSourceArchive(fileURLToPath(new URL('../..', import.meta.url)), {
    name: `pagenarrator-${packageJson.version}.zip`, sha256: createHash('sha256').update(binary).digest('hex'),
  }) : null;

  for (const path of [outputPath, sourcePath].filter(Boolean)) {
    if (existsSync(path) && !statSync(path).isFile()) throw new Error(`Package archive destination is not a file: ${path}`);
  }
  if (existsSync(extractedDir)) {
    if (!statSync(extractedDir).isDirectory()) throw new Error('Extracted package destination is not a directory.');
    const parent = realpathSync(outputDir), target = realpathSync(extractedDir);
    const input = realpathSync(sourceDir);
    if (!target.startsWith(`${parent}${sep}`) || target === input || input.startsWith(`${target}${sep}`)) throw new Error('Refusing to replace an extracted package outside its output directory or over the source.');
  }
  const staging = mkdtempSync(join(outputDir, '.pn-package-'));
  const entries = [outputPath, ...(sourcePath ? [sourcePath] : []), extractedDir].map((target, i) => ({
    target, staged: join(staging, `new-${i}`), backup: join(staging, `old-${basename(target)}`), saved: false, installed: false,
  }));
  let preserveBackups = false;
  try {
    writeFileSync(entries[0].staged, binary);
    if (source) writeFileSync(entries[1].staged, source);
    cpSync(sourceDir, entries.at(-1).staged, { recursive: true });
    // Replace only fully prepared output; restore the previous set if any rename fails.
    try {
      for (const entry of entries) {
        if (existsSync(entry.target)) { renameSync(entry.target, entry.backup); entry.saved = true; }
        renameSync(entry.staged, entry.target); entry.installed = true;
      }
    } catch (error) {
      const errors = [error];
      for (const entry of [...entries].reverse()) {
        try {
          if (entry.installed) rmSync(entry.target, { recursive: true, force: true });
          if (entry.saved) renameSync(entry.backup, entry.target);
        } catch (rollbackError) { errors.push(rollbackError); }
      }
      if (errors.length > 1) {
        preserveBackups = true;
        throw new AggregateError(errors, `Package replacement could not be restored; recover previous files from ${staging}.`);
      }
      throw error;
    }
  } finally {
    if (!preserveBackups) rmSync(staging, { recursive: true, force: true });
  }

  return {
    outputPath,
    sourcePath,
    sourceSha256: source ? createHash('sha256').update(source).digest('hex') : null,
    extractedDir,
    fileCount: files.length,
    rawBuildBytes: preflight?.metrics?.rawBuildBytes ?? rawBuildBytes,
    zipBytes,
  };
}

const SOURCE_PATHS = ['src', 'extension', 'engines', 'tooling', 'tests', 'website', 'docs',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc', '.gitignore', '.gitattributes'];

export function createSourceArchive(sourceRoot, binary, candidateId = process.env.PN_CANDIDATE_ID || process.env.GITHUB_SHA) {
  const staging = mkdtempSync(join(tmpdir(), 'pn-source-export-'));
  try {
    let root = sourceRoot, files;
    if (existsSync(join(sourceRoot, '.git'))) {
      const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
      const commit = git(['rev-parse', 'HEAD']);
      if (candidateId && candidateId !== commit) throw new Error('Source candidate ID differs from HEAD.');
      candidateId = commit;
      const paths = git(['ls-tree', '--name-only', commit]).split('\n').filter(name => SOURCE_PATHS.includes(name));
      if (!paths.length) throw new Error('No committed source paths.');
      if (git(['status', '--porcelain', '--untracked-files=all', '--', ...SOURCE_PATHS])) {
        throw new Error('Commit source changes before release packaging.');
      }
      const archive = join(staging, 'source.tar');
      root = join(staging, 'source');
      mkdirSync(root);
      execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit, '--', ...paths], { cwd: sourceRoot });
      execFileSync('tar', ['-xf', archive, '-C', root]);
      files = listFiles(root).filter(path => !path.startsWith('extension/public/voice-packs/kokoro/'));
    } else {
      // A distributed source ZIP can be rebuilt using only its verified, declared files.
      const manifest = JSON.parse(readFileSync(join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
      if (candidateId && candidateId !== manifest.candidateId) throw new Error('Source candidate ID differs from its manifest.');
      candidateId = manifest.candidateId;
      if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Missing source file manifest.');
      files = manifest.files.map(({ path, sha256 }) => {
        if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
          || !SOURCE_PATHS.includes(path.split('/')[0]) || !realpathSync(resolve(root, path)).startsWith(`${realpathSync(root)}${sep}`)
          || createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex') !== sha256) {
          throw new Error('Source file differs from its manifest.');
        }
        return path;
      });
    }
    if (!/^[a-f0-9]{40}$/u.test(candidateId || '')) throw new Error('Source requires a full candidate commit ID.');
    const manifest = { candidateId, binary, files: files.sort().map(path => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') })) };
    return createZip(root, files, {
      'SOURCE-MANIFEST.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      'SOURCE-README.txt': Buffer.from([
        'Matching PageNarrator source for the accompanying extension ZIP.',
        'Distribute both ZIPs together and retain the third-party notices.',
        "PageNarrator's own code is GPL-3.0-or-later. Convey the GPL-covered work that incorporates the retained UK pronunciation records under GPL version 3.",
        'Upstream OmniVoice source code is Apache-2.0. OmniVoice pretrained weights are CC BY-NC (https://huggingface.co/k2-fsa/OmniVoice#license).',
        'Downloaded speech models stay outside both ZIPs. See docs/third-party-voice-licenses.md and extension/public/legal/THIRD_PARTY_NOTICES.txt for the applicable terms, including speaker-source terms.',
        'Use Node 26.12.1 with npm 12.2.1. Run npm ci followed by npm run build. Compatible LTS ranges are listed in README.md. See docs/browser-engine.md for pinned native rebuilds.',
        'Set PN_CANDIDATE_ID to SOURCE-MANIFEST.json candidateId to reproduce the diagnostic identifier.',
        'Upstream runtime packages in devDependencies are development comparison oracles, never browser executable dependencies.',
        '',
      ].join('\n')),
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertZipBudget(zipBytes, budgets = {}) {
  const budget = {
    ...DEFAULT_RELEASE_ARTIFACT_BUDGETS,
    ...(budgets || {}),
  }.zipBytes;
  if (Number.isFinite(Number(budget)) && zipBytes > Number(budget)) {
    throw new Error(`zip size ${zipBytes} exceeds budget ${budget}`);
  }
}

function totalFileBytes(root, files) {
  return files.reduce((total, filePath) => total + statSync(resolve(root, filePath)).size, 0);
}

export function listFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Package directory does not exist: ${root}`);
  }

  const files = [];
  walk(root, files, root);
  return files.sort((a, b) => a.localeCompare(b));
}

function walk(directory, files, root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, files, root);
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join('/'));
    }
  }
}

const ZIP_ENTRY_DATE = new Date(1980, 0, 1);

function createZip(root, files, extra = {}) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  const entries = [...files, ...Object.keys(extra)];
  for (const filePath of entries) {
    const name = Buffer.from(filePath, 'utf8');
    const source = extra[filePath] || readFileSync(resolve(root, filePath));
    const compressed = deflateRawSync(source, { level: 9 });
    const crc = crc32(source);
    // A fixed entry time makes the ZIP a function of file contents only, so repackaging
    // an identical build keeps the recorded SHA-256 valid. Chrome ignores entry times.
    const { time, date } = getDosTimestamp(ZIP_ENTRY_DATE);

    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(source.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);

    localRecords.push(localHeader, compressed);
    centralRecords.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(centralStart, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, ...centralRecords, endRecord]);
}

function getDosTimestamp(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

let crcTable;

function crc32(buffer) {
  if (!crcTable) crcTable = createCrcTable();

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  const packageDir = args[0];
  if (!packageDir) {
    throw new Error('Usage: node tooling/scripts/package-release.mjs <package-dir> [--dry-run]');
  }

  const result = await packageRelease(packageDir, { dryRun });
  if (result.dryRun) {
    console.log(JSON.stringify(result.files, null, 2));
    return;
  }
  console.log(`Created ${result.outputPath} (${result.fileCount} files)`);
  console.log(`Matching Corresponding Source: ${result.sourcePath} (SHA-256 ${result.sourceSha256})`);
  console.log(`Extracted to ${result.extractedDir}`);
  console.log(`Raw build size: ${result.rawBuildBytes} bytes`);
  console.log(`Zip size: ${result.zipBytes} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
