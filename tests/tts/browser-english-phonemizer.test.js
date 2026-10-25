import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';
import { normalizeEnglishText, englishInteger } from '../../src/tts/kokoro/normalizer.js';
import { KOKORO_PHONEMES } from '../../src/tts/kokoro/phoneme-vocabulary.js';
import { arpaToPhones, compilePronunciations } from '../../scripts/build-pronunciation-data.mjs';

const bytes = readFileSync('public/assets/phonemizer/english.wasm');
const dictionary = readFileSync('public/assets/phonemizer/pronunciations.bin');
const create = (data = dictionary) => createEnglishPhonemizer({ wasmBinary: bytes, pronunciationData: data });

describe('original English normalizer', () => {
  it('expands dates, money, ordinals, decimals and initialisms without punctuation ambiguity', () => {
    expect(normalizeEnglishText('Dr. Smith paid $12.50 on 2026-10-16; the 21st PDF is 3.14%.')[0]).toEqual({
      words: ['doctor', 'smith', 'paid', 'twelve', 'dollars', 'and', 'fifty', 'cents', 'on', 'october', 'sixteenth', 'two', 'thousand', 'twenty', 'six'], punctuation: ';',
    });
    expect(normalizeEnglishText('the 21st PDF is 3.14%.')[0].words).toEqual(['the', 'twenty', 'first', 'pee', 'dee', 'ef', 'is', 'three', 'point', 'one', 'four', 'percent']);
    expect(englishInteger(101, 'en-gb')).toBe('one hundred and one');
    expect(englishInteger(101)).toBe('one hundred one');
    expect(normalizeEnglishText("I'm reading café, α and β. It's quiet.")[0].words).toEqual(['i', 'am', 'reading', 'cafe']);
    expect(normalizeEnglishText('WebGPU v1.0 uses B2B data.')[0].words).toEqual(['web', 'gee', 'pee', 'you', 'v', 'one', 'point', 'zero', 'uses', 'b', 'two', 'b', 'data']);
    expect(normalizeEnglishText('PageNarrator reads.')[0].words).toEqual(['page', 'narrator', 'reads']);
    expect(normalizeEnglishText('WELCOME, NASA uses GPU_data.')[0].words).toEqual(['welcome']);
    expect(normalizeEnglishText('WELCOME, NASA uses GPU_data.')[1].words).toEqual(['nasa', 'uses', 'gee', 'pee', 'you', 'data']);
    expect(normalizeEnglishText("PDFs and GPU's memory.")[0].words).toEqual(['pee', 'dee', 'efs', 'and', 'gee', 'pee', "you's", 'memory']);
    expect(normalizeEnglishText('OCR and OCRs.')[0].words).toEqual(['oh', 'see', 'are', 'and', 'oh', 'see', 'ares']);
  });
  it('bounds trust inputs and rejects invalid dates rather than producing partial text', () => {
    for (const [text, lang] of [['bad\0text', 'en'], ['text', 'sv'], ['2026-02-30', 'en'], ['x'.repeat(16385), 'en'], ['日本語', 'en']]) {
      expect(() => normalizeEnglishText(text, lang)).toThrow();
    }
    expect(normalizeEnglishText('')).toEqual([]);
    expect(() => englishInteger('9999999999999999')).toThrow();
  });
  it('distinguishes numeric references and typographic intervals from ordinary words, dates and minus signs', () => {
    const words = text => normalizeEnglishText(text).flatMap(clause => clause.words);
    expect(words('Figs. 8–10 and pp. 22 – 24; p. 6 and Fig. 9.')).toEqual([
      'figures', 'eight', 'to', 'ten', 'and', 'pages', 'twenty', 'two', 'to', 'twenty', 'four', 'page', 'six', 'and', 'figure', 'nine',
    ]);
    expect(words('Read 1,200–1,750 entries, or 2.5–3.75 seconds.')).toEqual([
      'read', 'one', 'thousand', 'two', 'hundred', 'to', 'one', 'thousand', 'seven', 'hundred', 'fifty', 'entries', 'or',
      'two', 'point', 'five', 'to', 'three', 'point', 'seven', 'five', 'seconds',
    ]);
    expect(words('-8–-3; 4−2; 6-1.')).toEqual(['minus', 'eight', 'to', 'minus', 'three', 'four', 'minus', 'two', 'six', 'minus', 'one']);
    expect(words('I picked a fig. The pp. suffix stays literal.')).toEqual(['i', 'picked', 'a', 'fig', 'the', 'pp', 'suffix', 'stays', 'literal']);
    expect(words('2027-05-14 remains a date; well–read remains a compound.')).toEqual([
      'may', 'fourteenth', 'two', 'thousand', 'twenty', 'seven', 'remains', 'a', 'date', 'well-read', 'remains', 'a', 'compound',
    ]);
  });
  it('spells technical initialisms without changing word acronyms or their plural/possessive source', () => {
    expect(normalizeEnglishText("JSON and JSON's schema use CSS, SQL and USB.")[0].words).toEqual([
      'jay', 'ess', 'oh', 'en', 'and', 'jay', 'ess', 'oh', "en's", 'schema', 'use', 'see', 'ess', 'ess',
    ]);
    expect(normalizeEnglishText('NASA uses JSON.')[0].words).toEqual(['nasa', 'uses', 'jay', 'ess', 'oh', 'en']);
  });
});

describe('licensed static dictionaries and independent native code', () => {
  it('distinguishes stressed US vowels and rejects incompatible lexical phones', () => {
    expect(arpaToPhones(['W', 'AH1', 'N'])).toBe('wˈʌn');
    expect(arpaToPhones(['AH0', 'ER0'])).toBe('əɚ');
    expect(() => arpaToPhones(['INVALID'])).toThrow();
    const result = compilePronunciations('one W AH1 N\n', 'one\t/wˈɒn/\nbad\t/ɬ/\n');
    expect(result.counts).toEqual({ us: 1, uk: 1, variants: 2 });
    expect(result.excluded).toHaveLength(1);
  });
  it('uses actual retained US and UK records and returns only model-supported phone IDs', async () => {
    const engine = await create();
    expect(engine.pronounceWord('one')).toBe('wˈʌn');
    expect(engine.pronounceWord('one', 'en-gb')).toBe('wˈɒn');
    expect(engine.pronounceWord('i', 'en-gb')).toBe('ˈaɪ');
    expect(engine.pronounceWord('four')).toBe('fˈoːɹ');
    expect(engine.pronounceWord('four', 'en-gb')).toBe('fˈɔː');
    expect((await engine.phonemize('Hello, world!'))).toHaveLength(2);
    expect(await engine.phonemizeText('One; four.', 'en-gb')).toBe('wˈɒn; fˈɔː.');
    const phoneText = await engine.phonemizeText("Dr. Smith's café reads PDFs at 10:30.");
    expect([...phoneText].every(phone => Object.hasOwn(KOKORO_PHONEMES, phone))).toBe(true);
    expect(await engine.phonemize('has read')).toEqual(['hˈæz ɹˈɛd']);
    engine.dispose();
    await expect(engine.phonemize('one')).rejects.toThrow('disposed');
  });
  it('covers unseen inflections, compounds and rule fallback with bounded cache/memory', async () => {
    const engine = await create();
    const before = engine.diagnostics().nativeMemoryBytes;
    for (const word of ["pagenarrator's", 'reader-reader', 'webgputable', 'cobaltifying']) {
      expect(engine.pronounceWord(word)).not.toBe('');
    }
    expect(engine.diagnostics().rule).toBeGreaterThan(0);
    expect(engine.diagnostics().compound).toBeGreaterThan(0);
    for (let i = 0; i < 2100; i++) engine.pronounceWord(`q${i.toString(26).replace(/\d/g, 'a')}`);
    expect(engine.diagnostics().cachedWords).toBeLessThanOrEqual(2048);
    expect(engine.diagnostics().nativeMemoryBytes).toBe(before);
    expect(() => engine.pronounceWord('a'.repeat(256))).toThrow();
    engine.dispose();
  });
  it('uses the standard S letter name in both dialects before suffix morphology', async () => {
    const engine = await create();
    try {
      for (const dialect of ['en-us', 'en-gb']) {
        expect(engine.pronounceWord('ess', dialect)).toBe('ˈɛs');
        expect(engine.pronounceWord("ess's", dialect)).toBe('ˈɛsɪz');
        expect(await engine.phonemizeText('CSS.', dialect)).toBe('sˈiː ˈɛs ˈɛs.');
        expect(await engine.phonemizeText('JSON.', dialect)).toContain('dʒˈeɪ ˈɛs');
      }
    } finally { engine.dispose(); }
  });
  it('keeps original OOV voicing and consonant-le syllables across dialects', async () => {
    const engine = await create();
    for (const dialect of ['en-us', 'en-gb']) {
      expect(engine.pronounceWord('wugs', dialect)).toBe('wˈʌɡz');
      expect(engine.pronounceWord('tazzle', dialect)).toBe('tˈæzəl');
      expect(engine.pronounceWord('snarps', dialect)).toBe(dialect === 'en-us' ? 'snˈɑːɹps' : 'snˈɑːps');
      expect(engine.pronounceWord('nusters', dialect)).toBe(dialect === 'en-us' ? 'nˈʌstɚz' : 'nˈʌstəz');
    }
    engine.dispose();
  });
  it('keeps tense and noun/verb cues clause-local and context-sensitive across cached repeats', async () => {
    const engine = await create();
    for (const dialect of ['en-us', 'en-gb']) {
      const past = await engine.phonemizeText('I read this yesterday; I will read this.', dialect);
      expect(past).toContain('ɹˈɛd'); expect(past).toContain('ɹˈiːd');
      expect(await engine.phonemizeText('I did not read this yesterday.', dialect)).toContain('ɹˈiːd');
      expect(await engine.phonemizeText('They read this.', dialect)).toContain('ɹˈiːd');
      expect(await engine.phonemizeText('Please record the record.', dialect)).toContain(dialect === 'en-us' ? 'ɹɪkˈɔːɹd ðə ɹˈɛkɚd' : 'ɹɪkˈɔːd ðə ɹˈɛkɔːd');
      expect(await engine.phonemizeText('Close the lid; it is close to me.', dialect)).toContain(dialect === 'en-us' ? 'klˈoʊz' : 'klˈəʊz');
      expect(await engine.phonemizeText('Close the lid; it is close to me.', dialect)).toContain(dialect === 'en-us' ? 'klˈoʊs' : 'klˈəʊs');
    }
    engine.dispose();
  });
  it.each([
    ['en-gb', 'wednesday', 'wˈɛnzdeɪ'],
    ['en-gb', 'wednesdays', 'wˈɛnzdeɪz'],
    ['en-gb', "wednesday's", 'wˈɛnzdeɪz'],
    ['en', 'wednesday', 'wˈɛnzdeɪ'],
    ['en', 'wednesdays', 'wˈɛnzdeɪz'],
    ['en', "wednesday's", 'wˈɛnzdeɪz'],
    ['en-us', 'wednesday', 'wˈɛnzdi'],
    ['en-us', 'wednesdays', 'wˈɛnzdˌeɪz'],
    ['en-us', "wednesday's", 'wˈɛnzdiz'],
  ])('pronounces the irregular weekday and its suffixes in %s: %s', async (dialect, word, expected) => {
    const engine = await create();
    try {
      expect(engine.pronounceWord(word, dialect)).toBe(expected);
      expect(await engine.phonemizeText(`${word}.`, dialect)).toBe(`${expected}.`);
    } finally { engine.dispose(); }
  });
  it.each(['en-gb', 'en'])('keeps irregular weekdays across case, punctuation and known compounds in %s', async dialect => {
    const engine = await create();
    try {
      expect(await engine.phonemizeText('WEDNESDAY, Wednesday’s; Wednesday-Wednesday.', dialect))
        .toBe('wˈɛnzdeɪ, wˈɛnzdeɪz; wˈɛnzdeɪ wˈɛnzdeɪ.');
    } finally { engine.dispose(); }
  });
  it('keeps UK weekday overrides separate from retained US pronunciations across cached sentence repeats', async () => {
    const engine = await create();
    try {
      for (const [dialect, expected] of [['en-gb', 'wˈɛnzdeɪ'], ['en-us', 'wˈɛnzdi'],
        ['en-gb', 'wˈɛnzdeɪ'], ['en', 'wˈɛnzdeɪ'], ['en-us', 'wˈɛnzdi']]) {
        expect(engine.pronounceWord('wednesday', dialect)).toBe(expected);
        expect(await engine.phonemizeText('On Wednesday.', dialect)).toEqual(expect.stringContaining(` ${expected}.`));
      }
    } finally { engine.dispose(); }
  });
  it('validates native data once and rejects corrupted headers, ordering and phone lengths', async () => {
    for (const offset of [0, 8, 12, 24, 32, 38, 44]) {
      const corrupt = Buffer.from(dictionary); corrupt[offset] ^= 255;
      await expect(create(corrupt)).rejects.toThrow('pronunciation');
    }
    const corruptPhone = Buffer.from(dictionary); corruptPhone[corruptPhone.readUInt32LE(28) + 2] = 49;
    await expect(create(corruptPhone)).rejects.toThrow('pronunciation');
    const module = await WebAssembly.compile(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
  });
});
