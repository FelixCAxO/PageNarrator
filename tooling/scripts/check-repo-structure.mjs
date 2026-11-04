#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ignoredDirs = new Set([
  '.git',
  '.agents',
  '.cache',
  '.claude',
  '.codex',
  '.superpowers',
  '.wrangler',
  'artifacts',
  'dist',
  'node_modules',
  'releases',
  'test-results',
  'tmp',
]);
const findings = [];

function toRepoPath(path) {
  return relative(root, path).split(sep).join('/');
}

function isTempArtifact(name) {
  return /^TEMP/i.test(name) || /^[^\w.~-]+TEMP/i.test(name);
}

function addFinding(repoPath, reason) {
  findings.push(`${repoPath}: ${reason}`);
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const repoPath = toRepoPath(fullPath);

    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    if (repoPath === 'PageNarrator_Old' || repoPath.startsWith('PageNarrator_Old/')) {
      addFinding(repoPath, 'legacy shadow tree must stay out of the active repo');
      continue;
    }
    if (isTempArtifact(entry.name)) {
      addFinding(repoPath, 'root TEMP artifacts must not be tracked or kept in the active repo');
    }
    if (entry.isFile() && entry.name === 'package.json' && repoPath !== 'package.json') {
      addFinding(repoPath, 'duplicate active package root');
    }
    if (entry.isDirectory()) walk(fullPath);
  }
}

const requiredFolders = ['docs', 'engines', 'extension', 'src', 'tests', 'tooling', 'website'];
const requiredFiles = ['.gitattributes', '.gitignore', '.nvmrc', 'LICENSE', 'README.md', 'package-lock.json', 'package.json', 'tsconfig.json'];
const trackedPaths = existsSync(join(root, '.git'))
  ? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  : JSON.parse(readFileSync(join(root, 'SOURCE-MANIFEST.json'), 'utf8')).files.map(file => file.path);
const folders = new Set();
const files = new Set();
for (const path of trackedPaths) {
  const [top, ...rest] = path.split('/');
  const expected = rest.length ? requiredFolders : requiredFiles;
  if (!expected.includes(top)) addFinding(path, 'unexpected tracked root entry');
  (rest.length ? folders : files).add(top);
}
for (const folder of requiredFolders) {
  if (!folders.has(folder)) addFinding(folder, 'required top-level folder missing');
}
for (const file of requiredFiles) {
  if (!files.has(file)) addFinding(file, 'required root file missing');
}
walk(root);

if (findings.length > 0) {
  console.error('Repository structure guard failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Repository structure guard passed.');
