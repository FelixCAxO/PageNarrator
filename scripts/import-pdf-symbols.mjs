// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Retain declarative font-symbol facts and notices, never executable/icon-path data.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readTrueTypeMetrics } from '../src/pdf/font-metrics.js';
const base = new URL('../vendor/pdf-symbols/', import.meta.url), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const legal = new URL('../public/legal/', import.meta.url), mirrors = {
  'Font-Awesome-LICENSE.txt': 'Font-Awesome-LICENSE.txt', 'MarVoSym-OFL.txt': 'MarVoSym-OFL.txt', 'NOTICE.txt': 'PDF-Symbols-NOTICE.txt',
};
const sources = {
  fontAwesome: { url: 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/7d3d774145ac38663f6d1effc6def0334b68ab7e/metadata/icons.json', bytes: 3281347, sha256: '06418a234bf87362eefce00e655b838581661fe8866067b90205ec9a450d6cf7' },
  fontAwesomeLicense: { url: 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/7d3d774145ac38663f6d1effc6def0334b68ab7e/LICENSE.txt', bytes: 1548, sha256: 'e779748dfe75e84f974df3c7bc07f842011a100159158b0f1f49b2f2a5a515cb' },
  marvosymAfm: { url: 'https://ctan.math.illinois.edu/fonts/marvosym/fonts/afm/public/marvosym/marvosym.afm', bytes: 12602, sha256: '1ff6f66c58e247956ecd54d12cb703b955ed7f62f2ac803a8822a47bf3f01efe' },
  marvosymCmap: { url: 'https://ctan.math.illinois.edu/fonts/marvosym/fonts/truetype/public/marvosym/marvosym.ttf', bytes: 69792, sha256: 'c40cf8aa12520f38abcf36542ce3628a01b6a4f122bbd854486ddfa8f212ce96' },
  marvosymLicense: { url: 'https://ctan.math.illinois.edu/fonts/marvosym/doc/fonts/marvosym/OFL.txt', bytes: 4727, sha256: '4132e5ff3f3382dc98e5cc41f1aa254db461d1a69bfeb5bffeeaffcb7eafed6a' },
};
if (process.argv.includes('--download')) {
  const files = {};
  for (const [name, source] of Object.entries(sources)) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Symbol data download failed: ${name} (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== source.bytes || hash(bytes) !== source.sha256) throw new Error(`Symbol source pin mismatch: ${name}.`);
    files[name] = bytes;
  }
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.fontAwesome)), fontAwesome = {};
  for (const [name, entry] of Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))) {
    const point = parseInt(entry.unicode, 16);
    if (!/^[a-z0-9-]{1,100}$/.test(name) || !/^[0-9a-f]{4}$/.test(entry.unicode) || point < 0xe000 || point > 0xf8ff
      || !Array.isArray(entry.styles) || !entry.styles.length || entry.styles.some(style => !['brands', 'regular', 'solid'].includes(style))
      || typeof entry.label !== 'string' || entry.label.length > 256) throw new Error(`Invalid declarative icon record: ${name}.`);
    fontAwesome[name] = { unicode: entry.unicode, styles: entry.styles, label: entry.label };
  }
  if (Object.keys(fontAwesome).length !== 1458) throw new Error('Unexpected Font Awesome mapping count.');
  const afm = new TextDecoder().decode(files.marvosymAfm), metrics = readTrueTypeMetrics(files.marvosymCmap);
  if (!/^FontName MarVoSym$/m.test(afm) || !/^C 66 ;[^\n]* N Letter ;/m.test(afm) || metrics.platform !== 3 || metrics.encoding !== 0
    || metrics.isUnicode || metrics.glyphId(66) !== 40 || metrics.glyphId(0xf042)) throw new Error('MarVoSym source encoding facts changed.');
  const mappings = { schemaVersion: 1, fontAwesome, marvosym: { Letter: { code: 66, label: 'Letter', unicode: null } } };
  const retained = {
    'mappings.json': Buffer.from(`${JSON.stringify(mappings)}\n`),
    'Font-Awesome-LICENSE.txt': files.fontAwesomeLicense,
    'MarVoSym-OFL.txt': files.marvosymLicense,
    'NOTICE.txt': Buffer.from('Font Awesome Free 5.15.4, Copyright Fonticons, Inc. Declarative name/Unicode/style/label metadata retains the MIT terms for non-font, non-icon files; see Font-Awesome-LICENSE.txt. No SVG paths, icon artwork, font programs or executable code are retained. Brand names identify source-document symbols and imply no endorsement.\nMarVoSym 3.10 (CTAN package 2.2a): named Letter symbol and non-Unicode Microsoft symbol-cmap facts, retained under SIL OFL 1.1; see MarVoSym-OFL.txt. No MarVoSym font program is retained. U+FFFC explicitly represents its identified non-Unicode inline object, not an invented Unicode letter.\nOriginal importer and interpretation code are GPL-3.0-or-later.\n'),
  };
  await mkdir(base, { recursive: true });
  for (const [name, bytes] of Object.entries(retained)) await writeFile(new URL(name, base), bytes);
  await mkdir(legal, { recursive: true });
  for (const [name, destination] of Object.entries(mirrors)) await writeFile(new URL(destination, legal), retained[name]);
  const manifest = { schemaVersion: 1, executableCode: false, iconArtwork: false, fontPrograms: false, sources,
    counts: { fontAwesome: 1458, marvosym: 1 }, files: Object.entries(retained).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
  await writeFile(new URL('manifest.json', base), `${JSON.stringify(manifest, null, 2)}\n`);
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
if (manifest.executableCode !== false || manifest.iconArtwork !== false || manifest.fontPrograms !== false || JSON.stringify(manifest.sources) !== JSON.stringify(sources)) throw new Error('Invalid symbol-data manifest.');
if (manifest.counts?.fontAwesome !== 1458 || manifest.counts?.marvosym !== 1 || !Array.isArray(manifest.files)
  || manifest.files.length !== 4 || new Set(manifest.files.map(file => file.path)).size !== 4
  || manifest.files.some(file => !['mappings.json', ...Object.keys(mirrors)].includes(file.path))) throw new Error('Incomplete symbol-data manifest.');
for (const entry of manifest.files) {
  if (!/^[A-Za-z0-9.-]+$/.test(entry.path)) throw new Error('Invalid symbol-data filename.');
  const bytes = await readFile(new URL(entry.path, base));
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Symbol data/notice mismatch: ${entry.path}.`);
  if (mirrors[entry.path] && !(await readFile(new URL(mirrors[entry.path], legal))).equals(bytes)) throw new Error(`Packaged symbol notice differs from retained source: ${entry.path}.`);
}
console.log('PDF symbol metadata: 1458 font-scoped Font Awesome mappings and one documented MarVoSym object; no artwork, fonts or executable data.');
