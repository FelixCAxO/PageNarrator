// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { downloadTestModels } from './download-test-models.mjs';
import { englishCandidateAlphabet } from '../src/engines/ocr-candidate-alphabet.js';

const latin = process.argv.includes('--latin-candidate'), kind = latin ? 'latin' : 'english';
const manifest = JSON.parse(await readFile(new URL(`../tests/fixtures/ocr/${kind}-rec-candidate.json`, import.meta.url), 'utf8'));
const result = await downloadTestModels({ fixtures: manifest, root: process.env.PN_OCR_CANDIDATE_DIR || `.cache/ocr-${kind}-candidate` });
const source = await readFile(resolve(result.directory, 'inference.yml'), 'utf8');
const alphabet = Buffer.from(`${JSON.stringify(englishCandidateAlphabet(source, { latin }))}\n`);
if (createHash('sha256').update(alphabet).digest('hex') !== manifest.derivedAlphabet.sha256 || alphabet.length !== manifest.derivedAlphabet.bytes) {
  throw new Error('Derived English candidate alphabet differs from its frozen pin.');
}
await writeFile(resolve(result.directory, manifest.derivedAlphabet.path), alphabet);
console.log(`Verified ${result.files} candidate data files and derived${latin ? 838 : 438}-symbol alphabet. Production OCR is unchanged.`);
