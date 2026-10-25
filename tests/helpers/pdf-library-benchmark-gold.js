// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = new URL('../fixtures/pdf-library-acceptance-manifest.json', import.meta.url);
const DEFAULT_GOLD = path.join(ROOT, '.cache/pdf-library-v1-20261024-reference-05/gold.json');
const HASH = /^[a-f0-9]{64}$/u;
const ID = 'private-library-v1-20261024';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new Error('Invalid independent PDF library gold: ' + message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function loadPdfLibraryBenchmarkGold({ goldPath = process.env.PN_PDF_LIBRARY_BENCHMARK_GOLD ?? DEFAULT_GOLD,
  manifestPath = MANIFEST } = {}) {
  if (typeof goldPath !== 'string' || !goldPath.trim()) invalid('explicit gold path is empty.');
  const publicBytes = readFileSync(manifestPath);
  const publicManifest = JSON.parse(publicBytes);
  if (publicManifest.schemaVersion !== 2 || publicManifest.benchmarkId !== ID
    || !plain(publicManifest.privateManifest) || !HASH.test(publicManifest.privateManifest.sha256)
    || !Number.isSafeInteger(publicManifest.privateManifest.bytes) || publicManifest.privateManifest.bytes < 1
    || publicManifest.privateManifest.bytes > 1024 * 1024) invalid('public identity/count/pin contract.');
  const privateBytes = readFileSync(path.join(path.dirname(goldPath), 'manifest.private.json'));
  if (privateBytes.length !== publicManifest.privateManifest.bytes
    || hash(privateBytes) !== publicManifest.privateManifest.sha256) invalid('private manifest pin drifted.');
  const manifest = JSON.parse(privateBytes);
  if (!equal(publicManifest.gold, manifest.gold)) invalid('public gold pin drifted.');
  if (manifest.schemaVersion !== 1 || manifest.benchmarkId !== ID || !HASH.test(manifest.sourceInventorySha256)
    || !plain(manifest.gold) || !HASH.test(manifest.gold.sha256) || !Number.isSafeInteger(manifest.gold.bytes)
    || manifest.gold.bytes < 1 || manifest.gold.bytes > 8 * 1024 * 1024
    || !Array.isArray(manifest.records) || manifest.records.length !== 90) invalid('public identity/count/pin contract.');
  const publicRouting = manifest.routingControls ?? [];
  if (manifest.routingControls !== undefined && (!Array.isArray(publicRouting) || publicRouting.length !== 2)) invalid('public native routing-control count.');
  if (!Array.isArray(publicManifest.records) || publicManifest.records.length !== 90
    || !Array.isArray(publicManifest.routingControls ?? [])
    || (publicManifest.routingControls ?? []).length !== publicRouting.length) invalid('public opaque roster count.');
  const publicRows = [...publicManifest.records, ...(publicManifest.routingControls ?? [])], publicIds = new Set();
  for (const [index, row] of publicRows.entries()) {
    const expected = [...manifest.records, ...publicRouting][index];
    if (!plain(row) || typeof row.id !== 'string' || !/^library-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.id)
      || publicIds.has(row.id) || Object.keys(row).some(key => !['id', 'categories', 'expectedCode'].includes(key))
      || !equal(row.categories, expected.categories) || row.expectedCode !== expected.expectedCode) invalid('public opaque page identity.');
    publicIds.add(row.id);
  }
  const info = statSync(goldPath);
  if (!info.isFile() || info.size !== manifest.gold.bytes) invalid('gold byte count drifted.');
  const bytes = readFileSync(goldPath);
  if (hash(bytes) !== manifest.gold.sha256) invalid('gold SHA-256 drifted.');
  const gold = JSON.parse(bytes);
  if (gold.schemaVersion !== 1 || gold.benchmarkId !== ID || gold.sourceInventorySha256 !== manifest.sourceInventorySha256
    || typeof gold.sourceRoot !== 'string' || !path.isAbsolute(gold.sourceRoot)
    || !(typeof gold.referenceMethod === 'string' && gold.referenceMethod.trim() || plain(gold.referenceMethod))
    || !Array.isArray(gold.records) || gold.records.length !== 90) invalid('private schema/source/reference contract.');
  const privateRouting = gold.routingControls ?? [];
  if (gold.routingControls !== undefined && (!Array.isArray(privateRouting) || privateRouting.length !== 2)
    || privateRouting.length !== publicRouting.length) invalid('private native routing-control count.');
  const privateRows = [...gold.records, ...privateRouting];
  const privateRoot = realpathSync(gold.sourceRoot), ids = new Set(), pages = new Set(), referencePins = new Map();
  const mapped = [...manifest.records, ...publicRouting].map((expected, index) => {
    const routing = index >= 90;
    if (!plain(expected) || typeof expected.id !== 'string' || !/^library-[a-z0-9-]+$/u.test(expected.id)
      || Object.keys(expected).some(key => !['id', 'source', 'sha256', 'pageNumber', 'categories', 'narrationStartPage', ...(routing ? ['expectedCode'] : [])].includes(key))
      || ids.has(expected.id) || !HASH.test(expected.sha256) || expected.source !== `private-library:${expected.sha256}`
      || !Number.isSafeInteger(expected.pageNumber) || expected.pageNumber < 1
      || !Array.isArray(expected.categories) || !expected.categories.length || expected.categories.some(c => typeof c !== 'string' || !c)
      || new Set(expected.categories).size !== expected.categories.length) invalid('public page identity at ' + index + '.');
    if (routing && (!['scanned_pdf_unsupported', 'pdf_corrupt'].includes(expected.expectedCode)
      || !equal(expected.categories, ['native-routing-control']))) invalid('public native routing-control contract.');
    const startPage = Math.max(1, expected.pageNumber - 3);
    if ((routing || expected.narrationStartPage !== undefined) && expected.narrationStartPage !== startPage) invalid('public narration context.');
    const pageId = `${expected.sha256}:${expected.pageNumber}`;
    if (pages.has(pageId)) invalid('duplicate source page.');
    pages.add(pageId); ids.add(expected.id);
    const record = privateRows[index];
    for (const key of ['id', 'source', 'sha256', 'pageNumber', 'categories', ...(routing ? ['expectedCode'] : [])]) {
      if (!equal(record?.[key], expected[key])) invalid('private source/order mismatch: ' + expected.id + '.');
    }
    if (record.narrationStartPage !== undefined && record.narrationStartPage !== startPage) invalid('private narration context.');
    if (expected.narrationStartPage !== record.narrationStartPage) invalid('public/private context mismatch.');
    if (typeof record.privateFilePath !== 'string' || !path.isAbsolute(record.privateFilePath)) invalid('private source location.');
    const location = realpathSync(record.privateFilePath), relative = path.relative(privateRoot, location);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !statSync(location).isFile()) invalid('source outside the frozen private root.');
    if ((!routing && (!Array.isArray(record.orderedCheckpoints) || record.orderedCheckpoints.length < 3 || record.orderedCheckpoints.length > 6
      || record.orderedCheckpoints.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)
      || new Set(record.orderedCheckpoints).size !== record.orderedCheckpoints.length
      || !Array.isArray(record.forbiddenNarration)
      || record.forbiddenNarration.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)))
      || !Array.isArray(record.referencePins) || !record.referencePins.length) invalid('independent checkpoint/reference contract: ' + expected.id + '.');
    for (const reference of record.referencePins) {
      if (!plain(reference) || typeof reference.path !== 'string' || !reference.path.trim() || !HASH.test(reference.sha256)
        || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1) invalid('reference pin shape.');
      const filename = path.resolve(path.dirname(goldPath), reference.path);
      const previous = referencePins.get(filename);
      if (previous) {
        if (previous.bytes !== reference.bytes || previous.sha256 !== reference.sha256) invalid('conflicting reference pins.');
      } else {
        if (!statSync(filename).isFile() || statSync(filename).size !== reference.bytes) invalid('reference bytes drifted.');
        if (hash(readFileSync(filename)) !== reference.sha256) invalid('reference SHA-256 drifted.');
        referencePins.set(filename, { path: filename, bytes: reference.bytes, sha256: reference.sha256 });
      }
    }
    return Object.freeze({ ...expected, id: publicRows[index].id, source: `private-library:${publicRows[index].id}`,
      narrationStartPage: startPage, privateFilePath: location,
      categories: Object.freeze([...expected.categories]), ...(!routing ? { orderedCheckpoints: Object.freeze([...record.orderedCheckpoints]),
        forbiddenNarration: Object.freeze([...record.forbiddenNarration]) } : {}) });
  });
  const generated = PDF_ACCEPTANCE_BENCHMARK.filter(record => !record.goldData);
  if (generated.length !== 10) invalid('authored fixture count drifted.');
  return { benchmarkId: ID, records: Object.freeze([...mapped.slice(0, 90), ...generated]), routingControls: Object.freeze(mapped.slice(90)),
    goldEvidence: Object.freeze({ kind: 'independent-private-library-v1', benchmarkId: ID,
      path: path.resolve(goldPath), bytes: bytes.length, sha256: hash(bytes),
      manifestSha256: hash(publicBytes), sourceInventorySha256: manifest.sourceInventorySha256,
      privateRecords: 90, generatedRecords: 10, routingControls: publicRouting.length, independentReferencePins: [...referencePins.values()],
      referenceMethod: gold.referenceMethod,
      scope: 'New independent reference-derived library-page benchmark; not the historical arXiv gold or human text-quality approval.' }) };
}
