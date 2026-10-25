import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = [
  'dist',
  'dist-preview',
  'test-results',
  '.chrome-preview',
];

const rootLogTarget = 'website-*.log';
const wildcardTargets = [
  /^dist-preview-.+/,
  globTargetToRegExp(rootLogTarget),
];

const resolvedTargets = new Set(targets.map((target) => resolve(root, target)));
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (wildcardTargets.some((pattern) => pattern.test(entry.name))) {
    resolvedTargets.add(resolve(root, entry.name));
  }
}

for (const target of resolvedTargets) {
  assertInsideRoot(target);
  await rm(target, { recursive: true, force: true });
}

console.log(`Removed ${[...resolvedTargets].map((target) => target.slice(root.length + 1)).join(', ')}`);

function assertInsideRoot(path) {
  const normalized = resolve(path);
  if (normalized !== root && !normalized.startsWith(`${root}\\`) && !normalized.startsWith(`${root}/`)) {
    throw new Error(`Refusing to clean path outside repo root: ${path}`);
  }
}

function globTargetToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}
