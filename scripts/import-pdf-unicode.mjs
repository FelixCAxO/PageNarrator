// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded-data transcription for PDF password preparation; no upstream code.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://www.unicode.org/Public/3.2-Update/';
const sources = [
  { path: 'UnicodeData-3.2.0.txt', bytes: 836989, sha256: '5e444028b6e76d96f9dc509609c5e3222bf609056f35e5fcde7e6fb8a58cd446', url: `${origin}UnicodeData-3.2.0.txt` },
  { path: 'CompositionExclusions-3.2.0.txt', bytes: 7457, sha256: '1d3a450d0f39902710df4972ac4a60ec31fbcb54ffd4d53cd812fc1200c732cb', url: `${origin}CompositionExclusions-3.2.0.txt` },
  { path: 'rfc3454.txt', bytes: 138684, sha256: 'eb722fa698fb7e8823b835d9fd263e4cdb8f1c7b0d234edf7f0e3bd2ccbb2c79', url: 'https://www.rfc-editor.org/rfc/rfc3454.txt' },
  { path: 'LICENSE.txt', bytes: 1995, sha256: 'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96', url: 'https://www.unicode.org/license.txt' },
];
const files = [
  { path: 'saslprep.json', bytes: 115875, sha256: 'd754f4e5c16dc99208ef528164b81cc9346bccbf7d3d57a65102ed2edd8660e6', role: 'unicode-normalization-and-stringprep-data', license: ['LICENSE.txt', 'RFC3454-NOTICE.txt'] },
  { path: 'LICENSE.txt', bytes: 1995, sha256: sources[3].sha256, role: 'notice', license: 'Unicode-3.0' },
  { path: 'RFC3454-NOTICE.txt', bytes: 1476, sha256: '475ba3686069755d12800946f4b1e426d711e4573ad86813d5f03ce038c2e1da', role: 'notice', license: 'LicenseRef-IETF-Stringprep-Notice' },
];
const target = fileURLToPath(new URL('../vendor/pdf-unicode/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (bytes, pin) => { if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw new Error(`Pinned Unicode data differs: ${pin.path}; actual ${bytes.length} bytes, SHA ${sha(bytes)}.`); };
const tableNames = ['A.1', 'B.1', 'C.1.2', 'C.2.1', 'C.2.2', 'C.3', 'C.4', 'C.5', 'C.6', 'C.7', 'C.8', 'C.9', 'D.1', 'D.2'];
const manifest = { schemaVersion: 1, executableCode: false, unicodeVersion: '3.2.0',
  scope: 'Only PDF revision6 password preparation. Original normalization and stringprep code consumes reformatted normative data; no upstream implementation is retained.',
  normalization: 'Unicode3.2 decomposition/composition facts, with canonical blocking clarified by Unicode PR29; no later character mappings.',
  profile: 'RFC4013, using only the required RFC3454 scalar-range tables.', sources, files };
if (!process.argv.includes('--check')) {
  const at = process.argv.indexOf('--source-dir'), local = at < 0 ? null : process.argv[at + 1];
  if (!local && !process.argv.includes('--download')) throw new Error('Use --check, --download, or --source-dir with the pinned Unicode and RFC files.');
  const loaded = [];
  for (const source of sources) {
    let bytes;
    if (local) bytes = await readFile(path.join(local, source.path));
    else { const response = await fetch(source.url); if (!response.ok) throw new Error(`Unicode source request failed: ${response.status}.`); bytes = new Uint8Array(await response.arrayBuffer()); }
    check(bytes, source); loaded.push(bytes);
  }
  const decode = value => new TextDecoder('utf-8', { fatal: true }).decode(value), decomposition = {}, combiningClass = {}, canonicalPairs = [];
  const excluded = new Set(decode(loaded[1]).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean).map(value => parseInt(value, 16)));
  for (const line of decode(loaded[0]).split(/\r?\n/)) {
    if (!line) continue; const fields = line.split(';'); if (fields.length !== 15) throw new Error('Invalid UnicodeData record.');
    const code = parseInt(fields[0], 16), ccc = Number(fields[3]);
    if (ccc) combiningClass[code] = ccc;
    if (fields[5]) {
      const parts = fields[5].replace(/^<[^>]+> /u, '').split(' ').map(value => parseInt(value, 16)); decomposition[code] = parts;
      if (!fields[5].startsWith('<') && parts.length === 2 && !excluded.has(code)) canonicalPairs.push([code, ...parts]);
    }
  }
  const composition = {};
  for (const [code, first, second] of canonicalPairs) if (!combiningClass[first]) composition[`${first},${second}`] = code;
  const rfc = decode(loaded[2]), tables = {};
  for (const name of tableNames) {
    const start = rfc.indexOf(`----- Start Table ${name} -----`), end = rfc.indexOf(`----- End Table ${name} -----`, start);
    if (start < 0 || end < start) throw new Error(`Missing normative stringprep table ${name}.`);
    tables[name] = [...rfc.slice(start, end).matchAll(/^   ([0-9A-F]{4,6})(?:-([0-9A-F]{4,6}))?(?:;[^\r\n]*)?\s*$/gmu)].map(match => [parseInt(match[1], 16), parseInt(match[2] || match[1], 16)]);
    if (!tables[name].length || tables[name].some(([first, last], index, ranges) => first > last || last > 0x10ffff || index && first <= ranges[index - 1][1])) throw new Error(`Invalid stringprep scalar ranges ${name}.`);
  }
  const notice = rfc.slice(rfc.lastIndexOf('Full Copyright Statement'), rfc.lastIndexOf('Acknowledgement')).trim();
  const outputs = [new TextEncoder().encode(`${JSON.stringify({ decomposition, combiningClass, composition, tables })}\n`), loaded[3], new TextEncoder().encode(`${notice}\n`)];
  for (const [index, file] of files.entries()) check(outputs[index], file);
  await mkdir(target, { recursive: true });
  for (const [index, file] of files.entries()) await writeFile(path.join(target, file.path), outputs[index]);
  await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(target, 'README.md'), '# Unicode3.2 password preparation data\n\nOnly normative Unicode decomposition/combining/composition facts and RFC3454 scalar ranges needed by RFC4013 are retained. Runtime uses our original bounded algorithm for PDF revision6 passwords. No third-party implementation code is included. Source files and derived bytes are pinned in manifest.json; retain both notices. Reimport with scripts/import-pdf-unicode.mjs.\n');
}
if (JSON.stringify(JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Unicode manifest differs from pinned sources and outputs.');
const allow = new Set([...files.map(file => file.path), 'manifest.json', 'README.md']);
if ((await readdir(target)).some(name => !allow.has(name))) throw new Error('Unexpected retained Unicode data file.');
for (const file of files) check(await readFile(path.join(target, file.path)), file);
console.log(`Verified original Unicode3.2 password data: ${files.reduce((sum, file) => sum + file.bytes, 0)} data/notice bytes, no upstream executable code.`);
