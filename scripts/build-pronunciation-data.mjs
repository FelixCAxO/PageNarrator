// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KOKORO_PHONEMES } from '../src/tts/kokoro/phoneme-vocabulary.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = JSON.parse(readFileSync(resolve(root, 'vendor/pronunciation/sources.json'), 'utf8'));
const arpa = { AA: 'ɑː', AE: 'æ', AH: 'ʌ', AO: 'ɔː', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð',
  EH: 'ɛ', ER: 'ɜːɹ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'iː', JH: 'dʒ', K: 'k', L: 'l', M: 'm',
  N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ', UH: 'ʊ', UW: 'uː',
  V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ' };

export function arpaToPhones(tokens) {
  return tokens.map(token => {
    const match = /^([A-Z]+)([012])?$/.exec(token);
    if (!match || !arpa[match[1]]) throw new Error(`Unknown ARPABET phone: ${token}`);
    const [, phone, stress] = match;
    const value = stress === '0' && phone === 'AH' ? 'ə' : stress === '0' && phone === 'ER' ? 'ɚ'
      : stress === '0' && phone === 'IY' ? 'i' : arpa[phone];
    return `${stress === '1' ? 'ˈ' : stress === '2' ? 'ˌ' : ''}${value}`;
  }).join('');
}

export function phoneIds(phones) {
  const ids = [...phones].map(phone => KOKORO_PHONEMES[phone]);
  if (ids.some(id => !Number.isInteger(id) || id === 0)) throw new Error(`Unsupported Kokoro phone in ${phones}`);
  return Uint8Array.from(ids);
}

export function compilePronunciations(usText, ukText) {
  const us = new Map(), uk = new Map(), excluded = [];
  function add(target, word, phones, source) {
    const sourceWord = word;
    word = word.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) {
      const reason = word.startsWith("'") ? 'leading apostrophe contraction' : /\d/.test(word) ? 'contains digits'
        : /[^\x00-\x7f]/.test(word) ? 'unsupported non-ASCII letters' : 'punctuation or non-word record';
      excluded.push({ source, word: sourceWord, reason }); return;
    }
    let ids;
    try { ids = phoneIds(phones); } catch { excluded.push({ source, word, phones, reason: 'outside Kokoro phoneme vocabulary' }); return; }
    if (!ids.length || ids.length > 512 || word.length > 255) throw new Error(`Pronunciation record exceeds bounds: ${word}`);
    const variants = target.get(word) ?? [];
    if (!variants.some(value => value.length === ids.length && value.every((item, index) => item === ids[index]))) variants.push(ids);
    target.set(word, variants);
  }
  for (const line of usText.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!fields[0]) continue;
    const word = fields.shift().replace(/\(\d+\)$/, '');
    const comment = fields.indexOf('#');
    add(us, word, arpaToPhones(comment < 0 ? fields : fields.slice(0, comment)), 'cmudict');
  }
  for (const line of ukText.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length !== 2 || !/^\/[^/]+\/(?:, \/[^/]+\/)*$/.test(fields[1])) throw new Error('Invalid UK lexical record.');
    for (const variant of fields[1].split(/,\s*/)) {
      // Some upstream alternatives share one pair of slash delimiters.
      add(uk, fields[0], variant.replace(/^\/|\/$/g, '').trim(), 'ipa-dict UK');
    }
  }
  const groups = [us, uk].map(group => [...group].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const records = groups.flat(), words = [], pronunciations = [];
  const tableEnd = 32 + records.length * 16;
  let wordBytes = 0, pronunciationBytes = 0;
  for (const [word, variants] of records) {
    const encoded = Buffer.from(word);
    words.push(encoded); wordBytes += encoded.length;
    const variantsBuffer = Buffer.alloc(variants.reduce((sum, ids) => sum + 2 + ids.length, 0));
    let offset = 0;
    for (const ids of variants) { variantsBuffer.writeUInt16LE(ids.length, offset); variantsBuffer.set(ids, offset + 2); offset += ids.length + 2; }
    pronunciations.push(variantsBuffer); pronunciationBytes += variantsBuffer.length;
  }
  const result = Buffer.alloc(tableEnd + wordBytes + pronunciationBytes);
  result.write('PNPRON01', 0, 'ascii');
  [result.length, groups[0].length, groups[1].length, 32, tableEnd, tableEnd + wordBytes].forEach((value, index) => result.writeUInt32LE(value, 8 + index * 4));
  let wordOffset = tableEnd, phoneOffset = tableEnd + wordBytes;
  records.forEach(([, variants], index) => {
    const offset = 32 + index * 16;
    result.writeUInt32LE(wordOffset, offset); result.writeUInt16LE(words[index].length, offset + 4);
    result.writeUInt16LE(variants.length, offset + 6); result.writeUInt32LE(phoneOffset, offset + 8);
    result.writeUInt32LE(pronunciations[index].length, offset + 12);
    result.set(words[index], wordOffset); wordOffset += words[index].length;
    result.set(pronunciations[index], phoneOffset); phoneOffset += pronunciations[index].length;
  });
  return { bytes: result, counts: { us: groups[0].length, uk: groups[1].length, variants: records.reduce((sum, [, variants]) => sum + variants.length, 0) }, excluded };
}

async function build() {
  const sourceBytes = new Map();
  for (const source of sources.sources) for (const file of source.files) {
    const path = resolve(root, 'vendor/pronunciation', source.id, file.path);
    if (process.argv.includes('--download')) {
      const response = await fetch(`${source.baseUrl}${file.path}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Pronunciation data download failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Unverified pronunciation source: ${file.path}`);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    }
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Pronunciation source hash mismatch: ${file.path}`);
    sourceBytes.set(`${source.id}/${file.path}`, bytes.toString('utf8'));
  }
  const compiled = compilePronunciations(sourceBytes.get('cmudict/cmudict.dict'), sourceBytes.get('ipa-dict/data/en_UK.txt'));
  const output = resolve(root, 'public/assets/phonemizer/pronunciations.bin');
  const metadata = resolve(root, 'public/assets/phonemizer/pronunciations.json');
  const manifest = { schema: 1, format: 'PNPRON01', sha256: hash(compiled.bytes), bytes: compiled.bytes.length, counts: compiled.counts,
    converterSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sources,
    exclusions: Object.fromEntries([...new Set(compiled.excluded.map(item => `${item.source}: ${item.reason}`))].map(key => [key, compiled.excluded.filter(item => `${item.source}: ${item.reason}` === key).length])) };
  if (process.argv.includes('--check')) {
    if (!readFileSync(output).equals(compiled.bytes) || JSON.stringify(JSON.parse(readFileSync(metadata, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Pronunciation source/binary mismatch.');
  } else {
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, compiled.bytes);
    writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resolve(root, 'vendor/pronunciation/excluded.json'), `${JSON.stringify(compiled.excluded, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...compiled.counts, excluded: compiled.excluded.length, bytes: compiled.bytes.length, sha256: manifest.sha256 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
