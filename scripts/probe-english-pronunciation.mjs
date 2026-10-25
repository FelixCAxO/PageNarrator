// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { KOKORO_PHONE_BY_ID, KOKORO_PHONEMES } from '../src/tts/kokoro/phoneme-vocabulary.js';
import { arpaToPhones } from './build-pronunciation-data.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(await readFile(resolve(root, 'vendor/pronunciation/sources.json'))), sourceBytes = new Map();
for (const source of metadata.sources) for (const file of source.files) {
  const bytes = await readFile(resolve(root, 'vendor/pronunciation', source.id, file.path));
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Source pin failed: ${source.id}/${file.path}.`);
  sourceBytes.set(`${source.id}/${file.path}`, bytes);
}
const dictionaries = [new Map(), new Map()], rawWords = [new Set(), new Set()];
function add(dialect, rawWord, phones) {
  rawWords[dialect].add(rawWord);
  const word = rawWord.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word) || ![...phones].every(phone => KOKORO_PHONEMES[phone] > 0)) return;
  if (!dictionaries[dialect].has(word)) dictionaries[dialect].set(word, new Set());
  dictionaries[dialect].get(word).add(phones);
}
for (const line of sourceBytes.get('cmudict/cmudict.dict').toString('utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [rawWord, ...phones] = line.split('#')[0].trim().split(/\s+/);
  add(0, rawWord.replace(/\(\d+\)$/, ''), arpaToPhones(phones));
}
for (const line of sourceBytes.get('ipa-dict/data/en_UK.txt').toString('utf8').split(/\r?\n/)) {
  if (!line) continue;
  const [word, rawPhones] = line.split('\t');
  for (const phones of rawPhones.split(/,\s*/)) add(1, word, phones.replace(/^\/|\/$/g, '').trim());
}
const data = await readFile(resolve(root, 'public/assets/phonemizer/pronunciations.bin')), wasm = await readFile(resolve(root, 'public/assets/phonemizer/english.wasm'));
const module = await WebAssembly.compile(wasm);
if (WebAssembly.Module.imports(module).length) throw new Error('Executable phonemizer imports are forbidden.');
const native = (await WebAssembly.instantiate(module)).exports, base = Number(native.__heap_base.value), input = (base + data.length + 15) & ~15, output = input + 256;
if (output + 2048 > native.memory.buffer.byteLength) native.memory.grow(Math.ceil((output + 2048 - native.memory.buffer.byteLength) / 65536));
new Uint8Array(native.memory.buffer, base, data.length).set(data);
if (native.pn_initialize(base, data.length) !== 1) throw new Error('Native rejected lexical data.');
const counts = [data.readUInt32LE(12), data.readUInt32LE(16)];
if (counts.some((count, dialect) => count !== dictionaries[dialect].size)) throw new Error('Source/native dialect record counts differ.');
let variantsVerified = 0;
for (let i = 0; i < counts[0] + counts[1]; i++) {
  const record = 32 + i * 16, wordOffset = data.readUInt32LE(record), wordLength = data.readUInt16LE(record + 4), variantCount = data.readUInt16LE(record + 6);
  const wordBytes = data.subarray(wordOffset, wordOffset + wordLength), word = wordBytes.toString('ascii'), dialect = i < counts[0] ? 0 : 1;
  const expected = dictionaries[dialect].get(word);
  if (!expected || expected.size !== variantCount) throw new Error(`Source association failed: ${dialect}/${word}.`);
  let position = data.readUInt32LE(record + 8);
  for (let variant = 0; variant < variantCount; variant++) {
    const length = data.readUInt16LE(position), ids = data.subarray(position + 2, position + 2 + length);
    const phones = [...ids].map(id => KOKORO_PHONE_BY_ID[String(id)]).join('');
    if (!expected.has(phones)) throw new Error(`Wrong source transcription: ${dialect}/${word}/${variant}.`);
    new Uint8Array(native.memory.buffer, input, wordLength).set(wordBytes);
    const actualLength = native.pn_lookup(input, wordLength, dialect, variant, output, 2048);
    if (actualLength !== length || !Buffer.from(native.memory.buffer, output, actualLength).equals(ids)) throw new Error(`Native lookup association failed: ${dialect}/${word}/${variant}.`);
    variantsVerified++; position += 2 + length;
  }
}
const excluded = JSON.parse(await readFile(resolve(root, 'vendor/pronunciation/excluded.json')));
for (const entry of excluded) if (!rawWords[entry.source === 'cmudict' ? 0 : 1].has(entry.word)) throw new Error(`Excluded record is not attributable to its declared source: ${entry.word}.`);
const fixtureBytes = await readFile(resolve(root, 'tests/fixtures/english-pronunciation-heldout.json'));
if (hash(fixtureBytes) !== 'c96b5dcb5aecf01ef75728a7f37755653a76d707c1815c048c45b1976049a2db') throw new Error('Frozen manual pronunciation fixture changed.');
const fixture = JSON.parse(fixtureBytes), phonemizer = await createEnglishPhonemizer({ wasmBinary: wasm, pronunciationData: data });
const report = { sourceAssociation: { status: 'pass', words: counts, variantsVerified, excludedAttributed: excluded.length, dataSha256: hash(data), wasmSha256: hash(wasm), sourcePins: metadata },
  scope: fixture.scope, fixtureStatus: process.argv.includes('--regression') ? 'Previously evaluated corpus used for OOV regression; no longer untouched held-out acceptance' : 'Initial frozen evaluation; do not tune rules against this corpus and continue calling it held-out',
  frozenFixtureSha256: hash(fixtureBytes), humanListening: 'pending', cases: [] };
try {
  for (const category of ['cases', 'oov']) for (const entry of fixture[category]) for (const [dialect, key] of [['en-us', 'us'], ['en-gb', 'uk']]) {
    const before = phonemizer.diagnostics(), actual = phonemizer.pronounceWord(entry.word, dialect), after = phonemizer.diagnostics();
    const method = ['dictionary', 'override', 'morphology', 'compound', 'rule', 'spelling'].find(name => after[name] > before[name]);
    report.cases.push({ word: entry.word, dialect, category, expected: entry[key], actual, method, retainedLexicalRecord: dictionaries[key === 'us' ? 0 : 1].has(entry.word), pass: entry[key].includes(actual) });
  }
} finally { phonemizer.dispose(); }
report.pronunciationStatus = report.cases.every(entry => entry.pass) ? 'pass' : 'fail';
report.passed = report.cases.filter(entry => entry.pass).length; report.total = report.cases.length;
await mkdir(resolve(root, 'artifacts/engines'), { recursive: true }); await writeFile(resolve(root, `artifacts/engines/english-pronunciation-${process.argv.includes('--regression') ? 'regression' : 'heldout'}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ sourceAssociation: report.sourceAssociation, pronunciationStatus: report.pronunciationStatus, passed: report.passed, total: report.total, failures: report.cases.filter(entry => !entry.pass) }));
if (report.pronunciationStatus !== 'pass') process.exitCode = 1;
