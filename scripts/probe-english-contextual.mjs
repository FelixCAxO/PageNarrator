// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Frozen manual sentence gold, evaluated without calling any upstream phonemizer.
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { normalizeEnglishText } from '../src/tts/kokoro/normalizer.js';
import { KOKORO_PHONEMES } from '../src/tts/kokoro/phoneme-vocabulary.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const corpusOption = process.argv.indexOf('--corpus'), version = corpusOption < 0 ? 'v2' : process.argv[corpusOption + 1];
const frozen = { v2: '5d86fbc98a074a6b7d396f5b479d51e446847ebb741ab0f5b9be00e1d4127fdc', v3: '1d003749d6bc10730b7850723cc4d71282bebcc6e0f03c852e3a70b61859d169' };
if (!Object.hasOwn(frozen, version)) throw new Error('Unknown frozen contextual corpus.');
const fixturePath = `tests/fixtures/english-pronunciation-contextual-${version}.json`, fixtureBytes = await readFile(fixturePath);
if (hash(fixtureBytes) !== frozen[version]) throw new Error('Frozen contextual pronunciation gold changed.');
const fixture = JSON.parse(fixtureBytes), output = resolve('artifacts/engines', `english-contextual-${version === 'v2' ? '' : `${version}-`}${process.argv.includes('--regression') ? 'regression' : 'heldout'}.json`);
if (!process.argv.includes('--regression')) { let exists = true; try { await access(output); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; } if (exists) throw new Error('First held-out result already exists; preserve it and use --regression.'); }
const sourceFiles = ['src/tts/kokoro/english-phonemizer.js', 'src/tts/kokoro/english-context.js', 'src/tts/kokoro/normalizer.js', 'native/phonemizer.cpp', 'public/assets/phonemizer/english.wasm', 'public/assets/phonemizer/pronunciations.bin'];
const pin = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(file))])));
const report = { scope: fixture.scope, fixturePath, fixtureSha256: hash(fixtureBytes), implementationPins: await pin(), evaluation: process.argv.includes('--regression') ? 'Previously evaluated fixed corpus; regression only' : 'First evaluation of the independently frozen sentence corpus', cases: [] };
const phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile('public/assets/phonemizer/english.wasm'), pronunciationData: await readFile('public/assets/phonemizer/pronunciations.bin') });
try {
  for (const entry of fixture.cases) for (const [dialect, key] of [['en-us', 'us'], ['en-gb', 'uk']]) {
    const record = { id: entry.id, text: entry.text, category: entry.category, dialect };
    try {
      const clauses = normalizeEnglishText(entry.text, dialect), phones = await phonemizer.phonemize(entry.text, dialect);
      const words = clauses.flatMap(clause => [...clause.words, ...(clause.punctuation ? [clause.punctuation] : [])]);
      const aligned = clauses.flatMap((clause, i) => { const tokens = phones[i].split(' '); return clause.words.map((word, j) => ({ word, phones: tokens[j], aligned: tokens.length === clause.words.length })); });
      record.normalized = clauses; record.phones = phones;
      record.phoneVocabularyPass = phones.every(value => [...value].every(char => Object.hasOwn(KOKORO_PHONEMES, char)));
      record.anchors = (entry.anchors ?? []).map(anchor => { const actual = aligned.filter(value => value.word === anchor.word)[anchor.occurrence ?? 0];
        return { word: anchor.word, occurrence: anchor.occurrence ?? 0, expected: anchor[key], actual: actual?.phones, aligned: actual?.aligned ?? false, pass: !!actual?.aligned && anchor[key].includes(actual.phones) }; });
      record.normalizationPass = !entry.words || JSON.stringify(words) === JSON.stringify(key === 'uk' && entry.wordsUk ? entry.wordsUk : entry.words);
      record.punctuationPass = !entry.punctuation || entry.punctuation.every(value => clauses.some(clause => clause.punctuation.includes(value)));
      record.pass = record.phoneVocabularyPass && record.normalizationPass && record.punctuationPass && record.anchors.every(anchor => anchor.pass);
    } catch (error) { record.failure = error.message; record.pass = false; }
    report.cases.push(record);
  }
} finally { phonemizer.dispose(); }
report.implementationUnchanged = JSON.stringify(await pin()) === JSON.stringify(report.implementationPins);
report.passed = report.cases.filter(entry => entry.pass).length; report.total = report.cases.length;
report.status = report.passed === report.total && report.implementationUnchanged ? 'pass' : 'fail';
await mkdir(resolve('artifacts/engines'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, status: report.status, passed: report.passed, total: report.total, failures: report.cases.filter(entry => !entry.pass) }));
if (report.status !== 'pass') process.exitCode = 1;
