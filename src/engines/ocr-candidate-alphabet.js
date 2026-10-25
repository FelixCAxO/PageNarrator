// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Read only the pinned model's literal character list, never a general YAML program.
export function englishCandidateAlphabet(source, { latin = false } = {}) {
  const modelName = latin ? 'latin_PP-OCRv5_mobile_rec' : 'en_PP-OCRv5_mobile_rec';
  const count = latin ? 836 : 436;
  const marker = '  character_dict:\n';
  if (typeof source !== 'string' || source.length > 16384 || !source.includes(`model_name: ${modelName}`)
    || source.split(marker).length !== 2) throw new Error('Invalid pinned English OCR dictionary.');
  const characters = source.split(marker)[1].split('\n').filter(line => line.trim()).map(line => {
    if (!line.startsWith('  - ')) throw new Error('Unsupported OCR dictionary syntax.');
    let value = line.slice(4);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    if ([...value].length !== 1 || /\s/u.test(value)) throw new Error('OCR dictionary must contain literal characters.');
    return value;
  });
  // The official Latin dictionary repeats 64 characters; preserve class indices exactly.
  if (characters.length !== count || new Set(characters).size !== (latin ? 772 : count)) throw new Error('English OCR dictionary size or uniqueness differs.');
  return ['', ...characters, ' '];
}
