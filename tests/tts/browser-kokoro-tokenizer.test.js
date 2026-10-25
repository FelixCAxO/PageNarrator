import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { KOKORO_PHONEMES } from '../../src/tts/kokoro/phoneme-vocabulary.js';
import { createKokoroTokenizer } from '../../src/tts/kokoro/tokenizer.js';

// Model data schema, no imported tokenizer implementation.
const model = JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer.json'));
const config = JSON.parse(readFileSync('vendor/pronunciation/kokoro-tokenizer_config.json'));

it('maps exact phoneme character IDs with both boundaries and no downloaded regex execution', () => {
  const tokenizer = createKokoroTokenizer(model, config);
  expect(tokenizer('wˈʌn').input_ids).toEqual(BigInt64Array.of(0n, 65n, 156n, 138n, 56n, 0n));
  expect(tokenizer.encode('🙂w')).toEqual(BigInt64Array.of(0n, 65n, 0n));
  expect(() => tokenizer.encode('🙂', { strict: true })).toThrow('phoneme');
  expect(tokenizer.encode('')).toEqual(BigInt64Array.of(0n, 0n));
});
it('preserves the final boundary under explicit truncation and refuses implicit data loss', () => {
  const tokenizer = createKokoroTokenizer(model, config);
  expect(() => tokenizer('w'.repeat(511))).toThrow('512');
  const ids = tokenizer('w'.repeat(511), { truncation: true }).input_ids;
  expect(ids.length).toBe(512); expect(ids.at(-1)).toBe(0n);
  expect(() => createKokoroTokenizer(model, { ...config, model_max_length: 1024 })).toThrow('Unsupported');
  expect(() => createKokoroTokenizer({ ...model, model: { vocab: { ...KOKORO_PHONEMES, w: 66 } } }, config)).toThrow('Unsupported');
  expect(() => createKokoroTokenizer({ ...model, normalizer: { ...model.normalizer, pattern: { Regex: '.*' } } }, config)).toThrow('Unsupported');
});
it('checks the pinned vocabulary data rather than assuming contiguous token IDs', () => {
  const sources = JSON.parse(readFileSync('vendor/pronunciation/sources.json'));
  expect(sources.sources.map(source => source.id)).toEqual(['cmudict', 'ipa-dict']);
  expect(KOKORO_PHONEMES.ɡ).toBe(92); expect(Object.values(KOKORO_PHONEMES)).not.toContain(49);
});
