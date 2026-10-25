// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only official conformance and independent Python scalar control.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePdfUnicode32, pdfStringprepContains } from '../src/pdf/saslprep.js';

const source = process.env.PN_PDF_UNICODE_SOURCE_DIR;
if (!source) throw new Error('Set PN_PDF_UNICODE_SOURCE_DIR to the pinned official Unicode3.2 source directory.');
const sha = value => createHash('sha256').update(value).digest('hex');
const normalizationBytes = await readFile(path.join(source, 'NormalizationTest-3.2.0.txt'));
if (sha(normalizationBytes) !== 'c4513869bb7098d19838be4a1fd5d760843c5804bfe03bd6bbb20623ceb6e57d') throw new Error('Official Unicode3.2 conformance data differs from the frozen source.');
const oracleBytes = await readFile(new URL('../tests/pdf-engine/fixtures/saslprep-python.json', import.meta.url)), oracle = JSON.parse(oracleBytes);
const pins = ['src/pdf/saslprep.js', 'vendor/pdf-unicode/saslprep.json', 'vendor/pdf-unicode/manifest.json', 'tests/pdf-engine/fixtures/saslprep-python.json'];
async function pin() { return await Promise.all(pins.map(async file => ({ path: file, sha256: sha(await readFile(new URL(`../${file}`, import.meta.url))) }))); }
const before = await pin(), started = performance.now(), failures = []; let officialCases = 0, assertions = 0;
const scalarString = value => String.fromCodePoint(...value.trim().split(' ').filter(Boolean).map(code => parseInt(code, 16)));
for (const line of normalizationBytes.toString('utf8').split(/\r?\n/)) {
  const data = line.split('#')[0].trim(); if (!data || data.startsWith('@')) continue;
  const columns = data.split(';').slice(0, 5).map(scalarString); if (columns.length !== 5) throw new Error('Invalid official normalization control.');
  officialCases++;
  for (const value of columns) { assertions++; if (normalizePdfUnicode32(value) !== columns[3] && failures.length < 20) failures.push({ kind: 'official_nfkc', input: [...value].map(c => c.codePointAt(0)), expected: [...columns[3]].map(c => c.codePointAt(0)) }); }
}
const normalized = createHash('sha256'), membership = createHash('sha256'), word = Buffer.alloc(4), flagsBytes = Buffer.alloc(0x110000 * 2);
const tables = ['A.1', 'B.1', 'C.1.2', 'C.2.1', 'C.2.2', 'C.3', 'C.4', 'C.5', 'C.6', 'C.7', 'C.8', 'C.9', 'D.1', 'D.2'];
for (let code = 0; code < 0x110000; code++) {
  for (const character of normalizePdfUnicode32(String.fromCodePoint(code))) { word.writeUInt32LE(character.codePointAt(0)); normalized.update(word); }
  word.writeUInt32LE(0xffffffff); normalized.update(word);
  let flags = 0; for (const [index, table] of tables.entries()) if (pdfStringprepContains(table, code)) flags |= 1 << index;
  flagsBytes.writeUInt16LE(flags, code * 2);
}
membership.update(flagsBytes);
const normalizationScalarSha256 = normalized.digest('hex'), stringprepScalarSha256 = membership.digest('hex');
if (normalizationScalarSha256 !== oracle.normalizationScalarSha256) failures.push({ kind: 'python_all_scalar_nfkc', expected: oracle.normalizationScalarSha256, actual: normalizationScalarSha256 });
if (stringprepScalarSha256 !== oracle.stringprepScalarSha256) failures.push({ kind: 'python_all_scalar_stringprep_tables', expected: oracle.stringprepScalarSha256, actual: stringprepScalarSha256 });
const after = await pin(), unchanged = JSON.stringify(before) === JSON.stringify(after);
if (!unchanged) failures.push({ kind: 'implementation_changed' });
const report = { schemaVersion: 1, productionSwitched: false, scope: 'PDF revision6 password preparation only; no renderer or release acceptance.',
  officialSource: { url: 'https://www.unicode.org/Public/3.2-Update/NormalizationTest-3.2.0.txt', bytes: normalizationBytes.length, sha256: sha(normalizationBytes) },
  python: oracle.python, unicodeVersion: oracle.unicodeVersion, oracleSha256: sha(oracleBytes), officialCases, officialAssertions: assertions,
  scalarCount: 0x110000, normalizationScalarSha256, stringprepScalarSha256, implementationPins: before, implementationUnchanged: unchanged,
  elapsedMs: performance.now() - started, failures, passed: failures.length === 0 };
const destination = new URL('../artifacts/engines/pdf-saslprep.json', import.meta.url); await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
try { await copyFile(destination, new URL(`../artifacts/engines/pdf-saslprep-${Date.now()}.json`, import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify({ officialCases, assertions, scalarCount: report.scalarCount, elapsedMs: report.elapsedMs, failures, passed: report.passed }, null, 2));
if (!report.passed) process.exitCode = 1;
