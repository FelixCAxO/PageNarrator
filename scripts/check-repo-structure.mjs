#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
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

walk(root);

if (findings.length > 0) {
  console.error('Repository structure guard failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Repository structure guard passed.');
