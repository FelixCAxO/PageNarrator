// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Imports Adobe's licensed static mapping records, never an upstream parser/runtime.
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREDEFINED_CMAP_NAMES } from '../src/pdf/cmap-names.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), destination = resolve(root, 'vendor/pdf-cmaps');
const repositories = [
  { repo: 'adobe-type-tools/cmap-resources', revision: 'f5cf3bca7fdfeaceb77aa82847e974f2306c20b4', notice: 'LICENSE.md', localNotice: 'LICENSE.cmap-resources.md' },
  { repo: 'adobe-type-tools/mapping-resources-pdf', revision: '2dd5e53fb74a01718b9dfd448a0d1cce6fff2aa5', notice: 'LICENSE.txt', localNotice: 'LICENSE.mapping-resources-pdf.txt' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const namesModule = files => `// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later\n// Static resource names, generated from the independently pinned Adobe data manifest.\nexport const PREDEFINED_CMAP_NAMES = Object.freeze(${JSON.stringify(files.filter(file => file.role === 'character-map').map(file => file.path).sort(), null, 2)});\n`;
if (process.argv.includes('--download')) {
  const names = [...PREDEFINED_CMAP_NAMES].sort();
  if (names.length !== 168 || new Set(names).size !== 168) throw new Error('Expected the exact existing 168 CMap data names.');
  const available = new Map(), work = [];
  for (const repository of repositories) {
    const response = await fetch(`https://api.github.com/repos/${repository.repo}/git/trees/${repository.revision}?recursive=1`);
    if (!response.ok) throw new Error(`Adobe data tree failed (${response.status}).`);
    const tree = await response.json(); if (tree.truncated) throw new Error('Adobe data tree is truncated.');
    for (const file of tree.tree.filter(file => file.type === 'blob' && (/\/CMap\//.test(file.path) || /^pdf2unicode\//.test(file.path)))) {
      const name = file.path.split('/').at(-1); if (!names.includes(name)) continue;
      if (available.has(name)) throw new Error(`Ambiguous Adobe data resource: ${name}.`);
      available.set(name, { ...repository, ...file });
    }
    const notice = tree.tree.find(file => file.path === repository.notice && file.type === 'blob');
    if (!notice) throw new Error('Missing Adobe redistribution notice.');
    work.push({ ...repository, ...notice, localPath: repository.localNotice, role: 'license' });
  }
  for (const name of names) {
    if (!available.has(name)) throw new Error(`Missing Adobe data resource ${name}.`);
    work.push({ ...available.get(name), localPath: name, role: 'character-map' });
  }
  await mkdir(destination, { recursive: true }); const files = []; let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < work.length) {
      const file = work[cursor++], source = `https://raw.githubusercontent.com/${file.repo}/${file.revision}/${file.path}`;
      const response = await fetch(source); if (!response.ok) throw new Error(`Adobe data download failed (${response.status}): ${file.path}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== file.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.sha) throw new Error(`Immutable Adobe tree/blob mismatch: ${file.path}.`);
      await writeFile(resolve(destination, file.localPath), bytes);
      files.push({ path: file.localPath, role: file.role, bytes: bytes.length, sha256: hash(bytes), source, gitBlob: file.sha, license: file.localNotice });
    }
  }));
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, executableCode: false, repositories, files }, null, 2)}\n`);
  await writeFile(resolve(root, 'src/pdf/cmap-names.js'), namesModule(files));
}
const manifest = JSON.parse(await readFile(resolve(destination, 'manifest.json')));
if (manifest.schemaVersion !== 1 || manifest.executableCode !== false || manifest.files.filter(file => file.role === 'character-map').length !== 168) throw new Error('Invalid Adobe CMap data manifest.');
const expected = new Set(['manifest.json', 'README.md']);
for (const file of manifest.files) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,96}$/.test(file.path) || expected.has(file.path)) throw new Error('Invalid or duplicate Adobe data path.');
  const bytes = await readFile(resolve(destination, file.path));
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256 || !manifest.files.some(notice => notice.path === file.license && notice.role === 'license')) throw new Error(`Adobe CMap data hash/license mismatch: ${file.path}.`);
  expected.add(file.path);
}
for (const file of await readdir(destination, { withFileTypes: true })) if (!file.isFile() || !expected.has(file.name)) throw new Error(`Unexpected Adobe CMap data artifact: ${file.name}.`);
if (await readFile(resolve(root, 'src/pdf/cmap-names.js'), 'utf8') !== namesModule(manifest.files)) throw new Error('Adobe CMap runtime allowlist differs from manifest.');
console.log(`Verified ${manifest.files.length} Adobe textual CMap/notice files (${manifest.files.filter(file => file.role === 'character-map').reduce((sum, file) => sum + file.bytes, 0)} mapping bytes); no upstream executable runtime.`);
