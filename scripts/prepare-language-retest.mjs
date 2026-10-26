// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const revision = '699beb854ab40a8a38bd48285e67e22697fc6e63';
const sourceUrl = `https://huggingface.co/datasets/k2-fsa/TTS_eval_datasets/blob/${revision}/fleurs_multilingual_102.jsonl`;
export const DEFAULT_RETEST_DIRECTORY = 'artifacts/omnivoice-language-retest';

export function buildRetestCorpus(rollout, previous, rows, sourceSha256) {
  const languages = rollout.languages.flatMap(language => {
    const original = previous.languages.find(item => item.code === language.code);
    if (!original?.nativeText) throw new Error(`Missing original native control: ${language.code}`);
    const seen = new Set([original.text.normalize('NFC')]);
    const available = rows.filter(row => row.language_id === language.code && row.id !== original.sourceId && row.text.length >= 30
      && row.text.length <= 240 && !/[<>\[\]]/u.test(row.text))
      .sort((left, right) => hash(left.id).localeCompare(hash(right.id)));
    const selected = [{ ...original, control: true }];
    const buckets = [available.filter(row => row.text.length <= 90), available.filter(row => row.text.length > 90 && row.text.length <= 150),
      available.filter(row => row.text.length > 150)];
    for (let index = 1; index < rollout.samplesPerLanguage; index += 1) {
      const bucket = buckets[(index - 1) % 3];
      const row = [...bucket, ...available].find(row => !seen.has(row.text.normalize('NFC')));
      if (!row) throw new Error(`Insufficient distinct native inputs: ${language.code}`);
      seen.add(row.text.normalize('NFC'));
      selected.push({ ...original, text: row.text, sourceId: row.id, source: 'k2-fsa/TTS_eval_datasets/FLEURS', sourceUrl,
        sourceRevision: revision, sourceFileSha256: sourceSha256, textSha256: hash(row.text), control: false });
    }
    return selected.map((item, index) => ({ ...item, id: `${language.code}-${String(index + 1).padStart(2, '0')}`,
      omniVoice: { gender: index % 2 ? 'male' : 'female', variation: index % 4 < 2 ? 1 : 2, whisper: false } }));
  });
  return { scope: 'Eight distinct native inputs per language, including the frozen original control; four female and four male samples, variations 1 and 2. Automatic screening only.',
    sourceUrl, sourceRevision: revision, sourceFileSha256: sourceSha256, samplesPerLanguage: rollout.samplesPerLanguage,
    languageCount: rollout.languages.length, languages };
}

async function main() {
  const directory = path.resolve(process.argv[2] || DEFAULT_RETEST_DIRECTORY);
  const [rollout, previous, data] = await Promise.all([
    readFile('config/language-rollout.json', 'utf8').then(JSON.parse),
    readFile('artifacts/omnivoice-language-audit/corpus.json', 'utf8').then(JSON.parse),
    readFile('.cache/omnivoice-language-audit/fleurs_multilingual_102.jsonl', 'utf8'),
  ]);
  const corpus = buildRetestCorpus(rollout, previous, data.trim().split(/\r?\n/u).map(JSON.parse), hash(data));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(JSON.stringify({ directory, languages: corpus.languageCount, samples: corpus.languages.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
