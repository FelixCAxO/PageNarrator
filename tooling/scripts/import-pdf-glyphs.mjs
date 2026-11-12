// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Reformat official licensed mapping data; no upstream implementation is imported.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = '4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6';
const origin = `https://raw.githubusercontent.com/adobe-type-tools/agl-aglfn/${commit}/`;
const sourceCopyright = 'Copyright 2002-2019 Adobe (http://www.adobe.com/).';
const sources = [
  { path: 'glyphlist.txt', bytes: 78060, sha256: 'a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789' },
  { path: 'zapfdingbats.txt', bytes: 3879, sha256: 'f6394e3cb8a447e84a1dad75d4baaf2aa7f45dc104faf369f4720e1a774ef2dc' },
  { path: 'LICENSE.md', bytes: 1404, sha256: '58147d341e7a34aa2196862395a34d2fd95716c41d5ed26efb59ab0e12f92089' },
];
const files = [
  { path: 'mappings.json', role: 'font-character-mappings', bytes: 89435, sha256: '9153c39a2341723ab4fb965a264d348944f55aa36dfd0e7036de09fef8c6d626', license: 'LICENSE.md' },
  { path: 'LICENSE.md', role: 'notice', bytes: 1456, sha256: '62fb32ae211bc410d1cd1815a5b4ee3dfa5327bb4ec3ac224a92474bdaddbfa0', license: 'BSD-3-Clause' },
];
const manifest = { schemaVersion: 1, executableCode: false, license: 'BSD-3-Clause', sourceCommit: commit,
  sources: sources.map(source => ({ ...source, url: origin + source.path })),
  transformation: 'Original parser reformats semicolon-delimited normative name/scalar mappings as JSON. The identical copyright from both mapping headers accompanies the unchanged upstream license terms. No source implementation is retained.',
  entries: { agl: 4281, dingbats: 201 }, files };
const target = fileURLToPath(new URL('../../engines/vendor/pdf-glyphs/', import.meta.url));
const packagedNotice = fileURLToPath(new URL('../../extension/public/legal/Adobe-Glyph-List-LICENSE.txt', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checkBytes = (bytes, expected) => { if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) throw new Error(`Pinned Adobe glyph data differs: ${expected.path}.`); };
if (!process.argv.includes('--check')) {
  const sourceAt = process.argv.indexOf('--source-dir'), local = sourceAt < 0 ? null : process.argv[sourceAt + 1];
  if (!local && !process.argv.includes('--download')) throw new Error('Use --check, --download, or --source-dir with the pinned official Adobe files.');
  const loaded = [];
  for (const source of sources) {
    let bytes;
    if (local) bytes = await readFile(path.join(local, source.path));
    else { const response = await fetch(origin + source.path); if (!response.ok) throw new Error(`Adobe data request failed: ${response.status}.`); bytes = new Uint8Array(await response.arrayBuffer()); }
    checkBytes(bytes, source); loaded.push(bytes);
  }
  const mappings = {};
  for (const [index, key] of ['agl', 'dingbats'].entries()) {
    const map = {};
    const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded[index]);
    if (text.match(/^# (Copyright .+)$/m)?.[1] !== sourceCopyright) throw new Error(`Adobe ${key} copyright notice differs.`);
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const record = /^([A-Za-z0-9]+);([0-9A-F]{4}(?: [0-9A-F]{4})*)$/.exec(line);
      if (!record || Object.hasOwn(map, record[1])) throw new Error('Invalid or duplicate Adobe glyph mapping record.');
      const codes = record[2].split(' ').map(value => parseInt(value, 16));
      if (codes.some(code => code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid Adobe glyph Unicode scalar.');
      map[record[1]] = String.fromCodePoint(...codes);
    }
    if (Object.keys(map).length !== manifest.entries[key]) throw new Error('Adobe glyph record count differs.');
    mappings[key] = map;
  }
  const notice = new TextEncoder().encode(`${sourceCopyright}\n\n${new TextDecoder('utf-8', { fatal: true }).decode(loaded[2])}`);
  const output = [new TextEncoder().encode(`${JSON.stringify(mappings)}\n`), notice];
  for (const [index, file] of files.entries()) checkBytes(output[index], file);
  await mkdir(target, { recursive: true });
  for (const [index, file] of files.entries()) await writeFile(path.join(target, file.path), output[index]);
  await mkdir(path.dirname(packagedNotice), { recursive: true });
  await writeFile(packagedNotice, notice);
  await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(target, 'README.md'), '# Adobe character mappings\n\nPinned AGL and ITC Zapf Dingbats mappings are reformatted by PageNarrator\'s importer. The runtime reads `mappings.json`; no upstream executable code is included. Dingbats mappings apply only in a verified Dingbats font context.\n\n`manifest.json` records source URLs, hashes, counts, and transformations. `LICENSE.md` retains the original copyright from both mapping headers with the unchanged upstream redistribution terms. Retain this complete notice when distributing the data. The importer regenerates its packaged mirror at `extension/public/legal/Adobe-Glyph-List-LICENSE.txt`; `--check` verifies both copies.\n');
}
const recorded = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'));
if (JSON.stringify(recorded) !== JSON.stringify(manifest)) throw new Error('Adobe glyph manifest differs from its pinned sources and outputs.');
const allowed = new Set([...files.map(file => file.path), 'manifest.json', 'README.md']);
if ((await readdir(target)).some(name => !allowed.has(name))) throw new Error('Unexpected retained Adobe glyph file.');
for (const file of files) checkBytes(await readFile(path.join(target, file.path)), file);
checkBytes(await readFile(packagedNotice), files[1]);
console.log(`Verified original Adobe data import: ${manifest.entries.agl + manifest.entries.dingbats} mappings, ${files.reduce((sum, file) => sum + file.bytes, 0)} retained data/notice bytes; no executable upstream code.`);
