// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { KOKORO_PHONE_BY_ID, KOKORO_PHONEMES } from './phoneme-vocabulary.js';
import { normalizeEnglishText, spellEnglishLetters } from './normalizer.js';
import { contextualEnglishPhones } from './english-context.js';

const ENCODER = new TextEncoder();
/** @typedef {{ memory: WebAssembly.Memory, __heap_base: WebAssembly.Global,
 * pn_abi_version: () => number, pn_initialize: (pointer: number, length: number) => number,
 * pn_lookup: (word: number, length: number, dialect: number, variant: number, output: number, capacity: number) => number,
 * pn_g2p: (word: number, length: number, dialect: number, output: number, capacity: number) => number }} PhonemizerExports */
const OUTPUT_CAPACITY = 2048;
/** @type {Record<string, Record<string, string>>} */
const OVERRIDES = {
  'en-us': { a: 'ə', the: 'ðə', to: 'tə', of: 'əv', and: 'ənd', read: 'ɹˈiːd', lead: 'lˈiːd', four: 'fˈoːɹ', fourteen: 'fˈoːɹtiːn',
    door: 'dˈoːɹ', core: 'kˈoːɹ', more: 'mˈoːɹ', forty: 'fˈɔːɹti', are: 'ɑːɹ', ess: 'ˈɛs' },
  'en-gb': { a: 'ə', the: 'ðə', to: 'tə', of: 'əv', and: 'ənd', read: 'ɹˈiːd', lead: 'lˈiːd', four: 'fˈɔː', fourteen: 'fˈɔːtiːn',
    door: 'dˈɔː', core: 'kˈɔː', more: 'mˈɔː', forty: 'fˈɔːti', are: 'ɑː', ess: 'ˈɛs', wednesday: 'wˈɛnzdeɪ' },
};
const VOICELESS = /[ptkfsθʃ]$/u;
const SIBILANT = /[szʃʒ]$/u;

/** @param {Uint8Array} ids */
function idsToPhones(ids) {
  return Array.from(ids, id => {
    const phone = KOKORO_PHONE_BY_ID[String(id)];
    if (!phone || id === 0) throw new Error(`Invalid pronunciation phone ID ${id}.`);
    return phone;
  }).join('');
}

/** @param {string} phones */
function validatePhones(phones) {
  if (![...phones].every(phone => Object.hasOwn(KOKORO_PHONEMES, phone))) throw new Error('Phonemizer emitted an unsupported Kokoro phone.');
  return phones;
}

/** Native engine is deliberately injectable so source/data validation and CPU probes need no extension.
 * @param {any} [options] */
export async function createEnglishPhonemizer({ runtime = globalThis.chrome?.runtime, fetcher = globalThis.fetch?.bind(globalThis),
  wasmBinary = null, pronunciationData = null } = {}) {
  const bytes = async (/** @type {string} */ file) => {
    if (!runtime?.getURL || !fetcher) throw new Error('English phonemizer needs packaged local assets.');
    const response = await fetcher(runtime.getURL(`assets/phonemizer/${file}`));
    if (!response.ok) throw new Error(`Could not load English phonemizer ${file} (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [wasm, data] = await Promise.all([wasmBinary ?? bytes('english.wasm'), pronunciationData ?? bytes('pronunciations.bin')]);
  const module = await WebAssembly.compile(wasm);
  if (WebAssembly.Module.imports(module).length) throw new Error('English phonemizer must not import an executable runtime.');
  const instance = await WebAssembly.instantiate(module);
  let native = /** @type {PhonemizerExports|null} */ (/** @type {unknown} */ (instance.exports));
  if (!native || native.pn_abi_version() !== 1) throw new Error('Unsupported English phonemizer ABI.');
  let memory = /** @type {WebAssembly.Memory|null} */ (native.memory);
  if (!memory) throw new Error('English phonemizer does not export memory.');
  const base = Number(native.__heap_base.value);
  const input = (base + data.byteLength + 15) & ~15;
  const output = input + 256;
  const required = output + OUTPUT_CAPACITY;
  if (required > 32 * 1024 * 1024) throw new RangeError('Pronunciation data exceeds the native memory limit.');
  if (required > memory.buffer.byteLength) memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
  new Uint8Array(memory.buffer, base, data.byteLength).set(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
  if (native.pn_initialize(base, data.byteLength) !== 1) throw new Error('Invalid pronunciation data.');
  let closed = false;
  const cache = new Map();
  /** @type {Record<string, number>} */
  const statistics = { lookups: 0, dictionary: 0, override: 0, morphology: 0, compound: 0, rule: 0, spelling: 0, cache: 0 };

  /** @param {string} word @param {string} dialect @param {boolean} [fallback] */
  function nativeWord(word, dialect, fallback = false) {
    if (!native || !memory) throw new Error('English phonemizer has been disposed.');
    const encoded = ENCODER.encode(word);
    if (!encoded.length || encoded.length > 255) throw new RangeError('English pronunciation word exceeds 255 bytes.');
    new Uint8Array(memory.buffer, input, encoded.length).set(encoded);
    const count = fallback ? native.pn_g2p(input, encoded.length, dialect === 'en-us' ? 0 : 1, output, OUTPUT_CAPACITY)
      : native.pn_lookup(input, encoded.length, dialect === 'en-us' ? 0 : 1, 0, output, OUTPUT_CAPACITY);
    if (count < 0) throw new Error(`Native English ${fallback ? 'G2P' : 'lookup'} failed (${count}).`);
    return idsToPhones(new Uint8Array(memory.buffer, output, count));
  }

  /** @param {string} word @param {string} dialect @param {string} [previous] @param {string} [contextual] @returns {string} */
  function pronounce(word, dialect, previous = '', contextual = '') {
    if (closed) throw new Error('English phonemizer has been disposed.');
    if (word.length > 255) throw new RangeError('English pronunciation word exceeds 255 characters.');
    const key = `${dialect}:${previous}:${contextual}:${word}`;
    if (cache.has(key)) { statistics.cache++; return cache.get(key); }
    statistics.lookups++;
    let result, method;
    if (contextual) { result = contextual; method = 'override'; }
    else if (word === 'read' && /^(?:had|has|have|having|already|yesterday)$/.test(previous)) { result = 'ɹˈɛd'; method = 'override'; }
    else if (Object.hasOwn(OVERRIDES[dialect], word)) { result = OVERRIDES[dialect][word]; method = 'override'; }
    else if ((result = nativeWord(word, dialect))) method = 'dictionary';
    if (!result) {
      const candidates = word.endsWith("'s") ? [[word.slice(0, -2), 's']] : word.endsWith('ies') ? [[`${word.slice(0, -3)}y`, 's']]
        : word.endsWith('es') ? [[word.slice(0, -2), 's'], [word.slice(0, -1), 's']]
        : word.endsWith('s') ? [[word.slice(0, -1), 's']]
        : word.endsWith('ied') ? [[`${word.slice(0, -3)}y`, 'ed']]
        : word.endsWith('ed') ? [[word.slice(0, -2), 'ed'], [word.slice(0, -1), 'ed']]
        : word.endsWith('ing') ? [[word.slice(0, -3), 'ing'], [`${word.slice(0, -3)}e`, 'ing'], [word.slice(0, -4), 'ing']] : [];
      for (const [stem, suffix] of candidates) {
        if (stem.length < 2) continue;
        const core = OVERRIDES[dialect][stem] || nativeWord(stem, dialect);
        if (!core) continue;
        result = `${core}${suffix === 's' ? SIBILANT.test(core) ? 'ɪz' : VOICELESS.test(core) ? 's' : 'z'
          : suffix === 'ed' ? /[td]$/.test(core) ? 'ɪd' : VOICELESS.test(core) ? 't' : 'd' : 'ɪŋ'}`;
        method = 'morphology'; break;
      }
    }
    if (!result && word.includes('-')) {
      const pieces = word.split('-').map(piece => OVERRIDES[dialect][piece] || nativeWord(piece, dialect));
      if (pieces.every(Boolean)) { result = pieces.join(' '); method = 'compound'; }
    }
    if (!result && /^[a-z]+$/.test(word) && /[aeiouy]/.test(word)) { result = nativeWord(word, dialect, true); method = 'rule'; }
    if (!result) {
      result = spellEnglishLetters(word.replaceAll("'", '').replaceAll('-', ''), dialect).split(' ').map(letter => nativeWord(letter, dialect) || nativeWord(letter, dialect, true)).join(' ');
      method = 'spelling';
    }
    if (!result || !method) throw new Error('English pronunciation produced no supported speech.');
    validatePhones(result); statistics[method]++;
    cache.set(key, result);
    while (cache.size > 2048) cache.delete(cache.keys().next().value);
    return result;
  }

  /** @param {string} text @param {string} [language] */
  function detailed(text, language = 'en-us') {
    const normalized = normalizeEnglishText(text, language);
    if (closed) throw new Error('English phonemizer has been disposed.');
    const dialect = language === 'en-us' ? 'en-us' : 'en-gb';
    return normalized.map(clause => ({ phonemes: clause.words.map((word, index) => pronounce(word, dialect, clause.words[index - 1], contextualEnglishPhones(clause.words, index, dialect))).join(' '), punctuation: clause.punctuation }));
  }
  return {
    phonemize: async (/** @type {string} */ text, language = 'en-us') => detailed(text, language).map(clause => clause.phonemes),
    phonemizeText: async (/** @type {string} */ text, language = 'en-us') => detailed(text, language).map(clause => `${clause.phonemes}${clause.punctuation}`).join(' '),
    pronounceWord: (/** @type {string} */ word, language = 'en-us') => {
      if (!['en-us', 'en-gb', 'en'].includes(language) || !/^[a-z]+(?:['-][a-z]+)*$/.test(word)) throw new Error('Invalid English pronunciation word or dialect.');
      return pronounce(word, language === 'en-us' ? 'en-us' : 'en-gb');
    },
    diagnostics: () => ({ ...statistics, cachedWords: cache.size, nativeMemoryBytes: memory?.buffer.byteLength ?? 0 }),
    dispose() { closed = true; cache.clear(); native = null; memory = null; },
  };
}
