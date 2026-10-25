import { expect, it } from 'vitest';
import { BytePairTokenizer } from '../../src/engines/bytepair-tokenizer.js';

function fixture(vocab, merges, addedTokens = []) {
  return { normalizer: { type: 'NFC' }, padding: null, truncation: null,
    pre_tokenizer: { type: 'Sequence', pretokenizers: [
      { type: 'Split', behavior: 'Isolated', invert: false, pattern: { Regex: String.raw`(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+` } },
      { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
    ] }, post_processor: { type: 'ByteLevel' }, added_tokens: addedTokens,
    model: { type: 'BPE', dropout: null, unk_token: null, continuing_subword_prefix: '', end_of_word_suffix: '', vocab, merges } };
}

it('chooses the globally lowest merge rank rather than the first adjacent pair', () => {
  const tokenizer = new BytePairTokenizer(fixture({ a: 0, b: 1, c: 2, ab: 3, bc: 4, abc: 5 }, [['b', 'c'], ['a', 'b'], ['a', 'bc']]));
  expect(tokenizer.encode('abc')).toEqual([5]);
});
it('resolves overlapping equal-rank pairs from the left and discards stale heap entries', () => {
  const tokenizer = new BytePairTokenizer(fixture({ a: 0, aa: 1, aaa: 2 }, [['a', 'a'], ['aa', 'a']]));
  expect(tokenizer.encode('aaaa')).toEqual([1, 1]);
  expect(tokenizer.encode('aaaaa')).toEqual([1, 2]);
});
it('normalizes ordinary text before UTF-8 encoding and preserves added-token boundaries', () => {
  const token = { content: '<|text_start|>', id: 100, special: true, single_word: false, lstrip: false, rstrip: false, normalized: false };
  const tokenizer = new BytePairTokenizer(fixture({ 'Ã': 0, '©': 1, 'Ã©': 2 }, [['Ã', '©']], [token]));
  expect(tokenizer.encode('e\u0301<|text_start|>é')).toEqual([2, 100, 2]);
  expect(tokenizer.encode('')).toEqual([]);
});
it('keeps cached encodings private and bounds retained words', () => {
  const tokenizer = new BytePairTokenizer(fixture({ a: 0, b: 1 }, []));
  const output = tokenizer.encode('ab'); output[0] = 99;
  expect(tokenizer.encode('ab')).toEqual([0, 1]);
  for (let i = 0; i < 2200; i++) tokenizer.encode(i.toString(2).replace(/0/g, 'a').replace(/1/g, 'b'));
  expect(tokenizer.cache.size).toBe(2048);
});
it('rejects executable pattern changes and unsupported or ambiguous model settings', () => {
  const data = () => fixture({ a: 0, aa: 1 }, [['a', 'a']]);
  const pattern = data(); pattern.pre_tokenizer.pretokenizers[0].pattern.Regex = '.*';
  expect(() => new BytePairTokenizer(pattern)).toThrow(/Unsupported/);
  const dropout = data(); dropout.model.dropout = .1;
  expect(() => new BytePairTokenizer(dropout)).toThrow(/Unsupported/);
  const duplicate = data(); duplicate.model.merges.push(['a', 'a']);
  expect(() => new BytePairTokenizer(duplicate)).toThrow(/merge/);
  const wrongRank = fixture({ a: 0, aa: 1, aaa: 2 }, [['aa', 'a'], ['a', 'a']]);
  expect(() => new BytePairTokenizer(wrongRank)).toThrow(/merge/);
});
it('fails explicitly on missing vocabulary bytes, oversized text and automatic token insertion', () => {
  const tokenizer = new BytePairTokenizer(fixture({ a: 0 }, []));
  expect(() => tokenizer.encode('b')).toThrow(/missing/);
  expect(() => tokenizer.encode('a'.repeat(262145))).toThrow(/limit/);
  expect(() => tokenizer.encode(2)).toThrow(/string/);
  expect(() => tokenizer.encode('a', { add_special_tokens: true })).toThrow(/insertion/);
});
