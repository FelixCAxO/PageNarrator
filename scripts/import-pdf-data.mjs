// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Imports licensed inert data only. Never copies PDF.js engines or codec code.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retainedStandard14Entries } from './lib/pdf-standard14-data.mjs';

const require = createRequire(import.meta.url);
const destination = fileURLToPath(new URL('../vendor/pdf-data/', import.meta.url));
const retainedMetrics = await retainedStandard14Entries(destination);
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.executableCode !== false || !Array.isArray(manifest.files)) throw new Error('Invalid PDF data manifest.');
  const expected = new Set(['manifest.json', 'README.md']);
  for (const file of manifest.files) {
    if (!/^(?:standard_fonts\/[^/]+\.(?:pfb|ttf)|iccs\/CGATS001Compat-v2-micro\.icc|iccs\/LICENSE|standard_fonts\/LICENSE_(?:FOXIT|LIBERATION)|standard14_metrics\/(?:Helvetica(?:-Bold|-Oblique|-BoldOblique)?\.afm|LICENSE_ADOBE_AFM\.txt|SOURCE\.json))$/.test(file.path)) throw new Error(`Unexpected PDF data path: ${file.path}`);
    const bytes = await readFile(path.join(destination, file.path));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`PDF data hash mismatch: ${file.path}`);
    if (expected.has(file.path)) throw new Error(`Duplicate PDF data path: ${file.path}`);
    expected.add(file.path);
  }
  for (const retained of retainedMetrics) {
    const declared = manifest.files.find(file => file.path === retained.path);
    if (!declared || Object.keys(retained).some(key => declared[key] !== retained[key])) throw new Error(`Canonical metric manifest differs: ${retained.path}`);
  }
  async function walk(folder, prefix = '') {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const relative = `${prefix}${item.name}`;
      if (item.isDirectory()) await walk(path.join(folder, item.name), `${relative}/`);
      else if (!item.isFile() || !expected.has(relative)) throw new Error(`Unexpected PDF data artifact: ${relative}`);
    }
  }
  await walk(destination); console.log(`Verified ${manifest.files.length} PDF data and notice hashes independently of PDF.js.`); process.exit(0);
}
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const entries = [];
for (const [directory, role, allowed] of [
  ['standard_fonts', 'font', /^(?:[^/]+\.(?:pfb|ttf)|LICENSE_FOXIT|LICENSE_LIBERATION)$/],
  ['iccs', 'color-profile', /^(?:CGATS001Compat-v2-micro\.icc|LICENSE)$/],
]) {
  for (const name of (await readdir(path.join(root, directory))).sort()) {
    if (!allowed.test(name)) throw new Error(`Unexpected PDF data file: ${directory}/${name}`);
    const sourcePath = path.join(root, directory, name), relative = `${directory}/${name}`;
    const bytes = await readFile(sourcePath), target = path.join(destination, directory, name);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(sourcePath, target);
    entries.push({ path: relative, role: name.startsWith('LICENSE') ? 'license' : role, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), source: `pdfjs-dist@${packageInfo.version}/${relative}`,
      license: directory === 'iccs' ? 'iccs/LICENSE'
        : name.startsWith('Liberation') || name === 'LICENSE_LIBERATION' ? 'standard_fonts/LICENSE_LIBERATION' : 'standard_fonts/LICENSE_FOXIT' });
  }
}
const manifest = `${JSON.stringify({ schemaVersion: 1, executableCode: false, files: [...entries, ...retainedMetrics] }, null, 2)}\n`;
await writeFile(path.join(destination, 'manifest.json'), manifest);
console.log(`Verified ${entries.length + retainedMetrics.length} licensed PDF data and notice files; no executable codecs.`);
