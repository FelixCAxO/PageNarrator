// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Reuse only pinned independent captures; never read product extraction or scores.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { referenceCheckpoints } from './build-pdf-library-gold.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const option = name => process.argv[process.argv.indexOf(name) + 1];
assert(process.argv.includes('--gold') && process.argv.includes('--output'), 'Pass original --gold and a fresh --output directory.');
const original = path.resolve(option('--gold')), output = path.resolve(option('--output'));
assert.notEqual(path.dirname(original), output, 'Never overwrite the original reference directory.');
const publicPath = path.resolve(process.argv.includes('--manifest') ? option('--manifest') : 'tests/fixtures/pdf-library-acceptance-manifest.json');
const publicManifest = JSON.parse(await readFile(publicPath));
const privateBytes = await readFile(path.join(path.dirname(original), 'manifest.private.json'));
assert.equal(hash(privateBytes), publicManifest.privateManifest.sha256);
const manifest = JSON.parse(privateBytes), oldBytes = await readFile(original);
assert.equal(hash(oldBytes), manifest.gold.sha256); assert.equal(oldBytes.length, manifest.gold.bytes);
const gold = JSON.parse(oldBytes), protocol = JSON.parse(await readFile('tooling/config/pdf-library-reference-protocol.json'));
assert.equal(protocol.referenceProtocolRevision, 6); assert.equal(gold.records.length, 90);
const changes = [], checked = new Map();
async function pinned(pin) {
  const filename = path.resolve(path.dirname(original), pin.path);
  if (!checked.has(filename)) {
    const bytes = await readFile(filename);
    assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
    checked.set(filename, bytes);
  }
  return checked.get(filename);
}
for (const record of gold.records) {
  for (const pin of record.referencePins) await pinned(pin);
  const reference = JSON.parse(await pinned(record.referencePins.find(pin => pin.path.endsWith('-pdfminer.json'))));
  const forward = JSON.parse(await pinned(record.referencePins.find(pin => pin.path.endsWith('-pdfminer-forward.json'))));
  const raw = JSON.parse(await pinned(record.referencePins.find(pin => pin.path.endsWith('-pdfjs.json'))));
  const selection = JSON.parse(await pinned(record.referencePins.find(pin => pin.path.endsWith('-selection.json'))));
  assert.equal(reference.input.sha256Before, record.sha256); assert(reference.input.unchanged);
  assert.equal(forward.input.sha256Before, record.sha256); assert(forward.input.unchanged);
  assert.equal(raw.pageNumber, record.pageNumber);
  const page = reference.pages.find(page => page.pageNumber === record.pageNumber);
  assert.equal(page.status, 'ok');
  const checkpoints = referenceCheckpoints(page.layoutText, raw.items.map(item => item.str || '').join(' '), protocol,
    [...selection.furniture.forbidden, ...(selection.furniture.anchorExclusions || [])], page);
  assert(checkpoints?.length === protocol.checkpoints, `Insufficient independent body anchors: ${record.id}; keep the page and investigate.`);
  if (JSON.stringify(checkpoints) !== JSON.stringify(record.orderedCheckpoints)) changes.push({ id: record.id,
    before: record.orderedCheckpoints, after: checkpoints });
  record.orderedCheckpoints = checkpoints;
}
const pins = await Promise.all(['tooling/config/pdf-library-reference-protocol.json', 'tooling/scripts/build-pdf-library-gold.mjs',
  'tooling/scripts/revise-pdf-library-checkpoints.mjs'].map(async filename => {
  const bytes = await readFile(filename); return { path: path.resolve(filename), bytes: bytes.length, sha256: hash(bytes) };
}));
gold.referenceMethod.checkpointRevision = { revision: 6, originalGold: { path: original, bytes: oldBytes.length, sha256: hash(oldBytes) },
  policy: protocol.mainFlowPolicy, pins,
  scope: 'Same 90 source pages, five independent main-flow checkpoints each, unchanged negative assertions and thresholds. No product output read.' };
await mkdir(output); // Intentionally fail if evidence already exists.
const json = value => JSON.stringify(value, null, 2) + '\n';
const goldBytes = Buffer.from(json(gold)); manifest.gold = { bytes: goldBytes.length, sha256: hash(goldBytes) };
const nextPrivate = Buffer.from(json(manifest));
publicManifest.gold = manifest.gold;
publicManifest.privateManifest = { bytes: nextPrivate.length, sha256: hash(nextPrivate) };
for (const [filename, bytes] of Object.entries({ 'gold.json': goldBytes, 'manifest.private.json': nextPrivate,
  'manifest.public.json': json(publicManifest), 'checkpoint-changes.json': json({ revision: 6, pages: 90,
    changedPages: changes.length, originalGoldSha256: hash(oldBytes), independentCaptureFiles: checked.size, changes }) })) {
  await writeFile(path.join(output, filename), bytes, { flag: 'wx' });
}
console.log(JSON.stringify({ output, pages: 90, changedPages: changes.length, independentCaptureFiles: checked.size,
  publicManifest: path.join(output, 'manifest.public.json') }));
