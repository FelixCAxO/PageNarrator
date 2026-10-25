import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleasePackage, DEFAULT_RELEASE_ARTIFACT_BUDGETS } from './assert-release-package.mjs';

export async function packageRelease(packageDir, options = {}) {
  const sourceDir = resolve(packageDir);
  const preflight = options.skipPreflight ? null : await assertReleasePackage(sourceDir, options);

  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const outputDir = resolve(options.outputDir || 'releases');
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, `pagenarrator-${packageJson.version}.zip`);
  const extractedDir = join(outputDir, `pagenarrator-${packageJson.version}`);
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
  writeFileSync(outputPath, createZip(sourceDir, files));
  assertZipBudget(outputPath, options.budgets);
  const rawBuildBytes = totalFileBytes(sourceDir, files);
  const zipBytes = statSync(outputPath).size;
  // Convey matching source alongside the binary without loading or duplicating it in the extension.
  const sourcePath = options.skipPreflight ? null : join(outputDir, `pagenarrator-${packageJson.version}-source.zip`);
  if (sourcePath) {
    const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
    writeFileSync(sourcePath, createSourceArchive(sourceRoot, {
      name: `pagenarrator-${packageJson.version}.zip`, sha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
    }));
  }

  if (existsSync(extractedDir)) {
    const parent = realpathSync(outputDir), target = realpathSync(extractedDir);
    if (!target.startsWith(`${parent}${sep}`) || target === realpathSync(sourceDir)) throw new Error('Refusing to replace an extracted package outside its output directory or over the source.');
    rmSync(target, { recursive: true, force: true });
  }
  cpSync(sourceDir, extractedDir, { recursive: true });

  return {
    outputPath,
    sourcePath,
    sourceSha256: sourcePath ? createHash('sha256').update(readFileSync(sourcePath)).digest('hex') : null,
    extractedDir,
    fileCount: files.length,
    rawBuildBytes: preflight?.metrics?.rawBuildBytes ?? rawBuildBytes,
    zipBytes,
  };
}

const SOURCE_PATHS = ['src', 'build', 'scripts', 'native', 'vendor', 'public', 'config', 'icons', '_locales', 'tests', 'docs', 'website',
  'package.json', 'package-lock.json', 'manifest.json', 'vite.config.js', 'tsconfig.base.json', 'tsconfig.strict.json',
  'tsconfig.boundaries.json', 'tsconfig.eslint.json', '.eslintrc.json', 'LICENSE', 'README.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'SECURITY.md', '.gitignore', '.gitattributes', '.nvmrc', 'playwright.config.js',
  'vitest.profiles.config.js', 'vitest.live.config.js', 'tsconfig.json', 'preview.sh', 'preview-website.bat'];

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
      if (git(['status', '--porcelain', '--untracked-files=no', '--', ...paths])) {
        throw new Error('Commit source changes before release packaging.');
      }
      const archive = join(staging, 'source.tar');
      root = join(staging, 'source');
      mkdirSync(root);
      execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit, '--', ...paths], { cwd: sourceRoot });
      execFileSync('tar', ['-xf', archive, '-C', root]);
      files = listFiles(root).filter(path => !path.startsWith('public/voice-packs/kokoro/'));
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
      'SOURCE-README.txt': Buffer.from('Matching PageNarrator source for the accompanying extension ZIP.\nDistribute both ZIPs together.\nPageNarrator own code is GPL-3.0-or-later. Retained UK pronunciation data is GPL-3.0-only; the combined distribution is conveyed under GPL version 3. Other data retain their individual notices.\nWith Node 22.13+ (22.x) or 24+ installed: npm ci; npm run build. See docs/browser-engine.md for pinned native rebuilds.\nSet PN_CANDIDATE_ID to SOURCE-MANIFEST.json candidateId to reproduce the diagnostic identifier.\nKokoro and OmniVoice model data are downloaded on demand and are not included.\nUpstream runtime packages in devDependencies are development comparison oracles, never browser executable dependencies.\n'),
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertZipBudget(outputPath, budgets = {}) {
  const budget = {
    ...DEFAULT_RELEASE_ARTIFACT_BUDGETS,
    ...(budgets || {}),
  }.zipBytes;
  const zipBytes = statSync(outputPath).size;
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
    throw new Error('Usage: node scripts/package-release.mjs <package-dir> [--dry-run]');
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
