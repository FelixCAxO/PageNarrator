// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile as diskReadFile } from 'node:fs/promises';
import path from 'node:path';

export const STANDARD14_DATA_FILES = ['Helvetica.afm', 'Helvetica-Bold.afm', 'Helvetica-Oblique.afm', 'Helvetica-BoldOblique.afm', 'LICENSE_ADOBE_AFM.txt'];
const repository = 'https://github.com/apache/pdfbox', commit = 'e314c402afd4cac4d60d6d16dbe6525d83637ba8';
const base = `https://raw.githubusercontent.com/apache/pdfbox/${commit}/`, metricRoot = `${base}pdfbox/src/main/resources/org/apache/pdfbox/resources/afm/`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Existing committed data must validate BEFORE a fresh PDF.js data import.
// This helper has no acquisition route and does not parse or instantiate fonts.
export async function retainedStandard14Entries(destination, readFile = diskReadFile) {
  const folder = path.join(destination, 'standard14_metrics'), sourceBytes = await readFile(path.join(folder, 'SOURCE.json'));
  const source = JSON.parse(sourceBytes.toString('utf8'));
  assert.equal(source.schemaVersion, 1); assert.equal(source.executableCode, false);
  assert.equal(source.repository, repository); assert.equal(source.commit, commit);
  assert.deepEqual(source.files.map(file => file.path).sort(), [...STANDARD14_DATA_FILES].sort());
  const entries = [], bodies = new Map();
  for (const file of source.files) {
    const bytes = await readFile(path.join(folder, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256, `Canonical metric data drift: ${file.path}`);
    assert.equal(file.source, file.path.endsWith('.afm') ? metricRoot + file.path : base + 'LICENSE.txt');
    assert.equal(file.role, file.path.endsWith('.afm') ? 'font-metrics' : 'license');
    assert.equal(file.license, 'LICENSE_ADOBE_AFM.txt'); bodies.set(file.path, bytes);
    entries.push({ path: `standard14_metrics/${file.path}`, role: file.role, bytes: file.bytes, sha256: file.sha256,
      source: file.source, license: 'standard14_metrics/LICENSE_ADOBE_AFM.txt' });
  }
  const range = source.adobePermissionExcerpt;
  assert.equal(range.source, 'APACHE-PDFBOX-SOURCE-LICENSE.txt');
  assert(Number.isSafeInteger(range.startByte) && Number.isSafeInteger(range.endByte) && range.startByte >= 0 && range.endByte > range.startByte);
  // Full upstream license remains external provenance. The source seal proves
  // this notice's exact byte-range extraction; import checks its retained hash.
  assert.equal(source.upstreamLicense.source, base + 'LICENSE.txt');
  assert.equal(source.upstreamLicense.bytes, 18741);
  assert.equal(source.upstreamLicense.sha256, '1301d8415a4868d82aeeec594849cf7679f1ead4636a9603dc46875f5713157e');
  assert(range.endByte <= source.upstreamLicense.bytes);
  assert.equal(range.endByte - range.startByte, bodies.get('LICENSE_ADOBE_AFM.txt').length);
  assert.equal(range.sha256, hash(bodies.get('LICENSE_ADOBE_AFM.txt')));
  entries.push({ path: 'standard14_metrics/SOURCE.json', role: 'source-manifest', bytes: sourceBytes.length, sha256: hash(sourceBytes),
    source: `PageNarrator data provenance for ${repository}@${commit}`, license: 'standard14_metrics/LICENSE_ADOBE_AFM.txt' });
  return entries;
}
