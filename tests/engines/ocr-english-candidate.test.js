import { expect, it, vi } from 'vitest';
import { englishCandidateAlphabet } from '../../src/engines/ocr-candidate-alphabet.js';
import { englishCandidateSession } from '../../src/engines/ocr-english-candidate.js';
import { Tensor } from '../../src/engines/browser-inference.js';

it('extracts literal Unicode dictionary data with quoted punctuation, without evaluating YAML tags', () => {
  const entries = ["'0'", "''''", '\\', "'\"'", ...Array.from({ length: 432 }, (_, i) => String.fromCodePoint(0x100 + i))];
  const source = `Global:\n  model_name: en_PP-OCRv5_mobile_rec\nPostProcess:\n  character_dict:\n${entries.map(value => `  - ${value}\n`).join('')}`;
  const alphabet = englishCandidateAlphabet(source);
  expect(alphabet.length).toBe(438); expect(alphabet.slice(0, 5)).toEqual(['', '0', "'", '\\', '"']); expect(alphabet.at(-1)).toBe(' ');
  expect(() => englishCandidateAlphabet(source.replace('  - \'0\'', '  - !!python/object'))).toThrow();
  expect(() => englishCandidateAlphabet(source.replace('  - \'0\'', "  - ''''"))).toThrow(/uniqueness/);
});

it.each([438, 838])('adapts %i dense candidate probabilities and its documented BGR input order', async classes => {
  const alphabet = ['', ...Array.from({ length: classes - 2 }, (_, i) => String.fromCodePoint(0x100 + i)), ' '];
  const data = new Float32Array(classes * 3); data[5] = 0.7; data[classes - 1] = 0.2; data[classes * 2 - 1] = 0.95; data[classes * 2] = 0.8;
  const session = { inputNames: ['image'], outputNames: ['text'], run: vi.fn(async () => ({ text: { dims: [1, 3, classes], data } })) };
  const adapter = englishCandidateSession(session, alphabet);
  const original = Float32Array.of(1, 2, 3, 4, 5, 6);
  const result = await adapter.run({ image: new Tensor('float32', original, [1, 3, 1, 2]) });
  expect([...session.run.mock.calls[0][0].image.data]).toEqual([5, 6, 3, 4, 1, 2]);
  expect([...original]).toEqual([1, 2, 3, 4, 5, 6]);
  expect([...result.ocr_labels.data]).toEqual([5, classes - 1, 0]);
  expect([...result.ocr_scores.data]).toEqual([data[5], data[classes * 2 - 1], data[classes * 2]]);
  expect(result.ocr_spaces.dims).toEqual([1, 3]);
});

it('preserves repeated official Latin classes rather than changing learned output indices', () => {
  const unique = Array.from({ length: 772 }, (_, i) => String.fromCodePoint(0x3000 + i));
  // Avoid the ideographic-space codepoint, which is not a dictionary glyph.
  unique[0] = 'A';
  const characters = [...unique, ...unique.slice(0, 64)];
  const source = `Global:\n  model_name: latin_PP-OCRv5_mobile_rec\nPostProcess:\n  character_dict:\n${characters.map(value => `  - ${value}\n`).join('')}`;
  const alphabet = englishCandidateAlphabet(source, { latin: true });
  expect(alphabet.length).toBe(838); expect(alphabet[1]).toBe(alphabet[773]);
  expect(() => englishCandidateAlphabet(source)).toThrow();
});

it('fails malformed candidate dictionaries and confidence arrays explicitly', async () => {
  expect(() => englishCandidateSession({}, [''])).toThrow(/alphabet/);
  const alphabet = ['', ...Array.from({ length: 436 }, (_, i) => `${i}`), ' '];
  const data = new Float32Array(438); data[12] = NaN;
  const session = { inputNames: ['image'], outputNames: ['text'], run: async () => ({ text: { dims: [1, 1, 438], data } }) };
  await expect(englishCandidateSession(session, alphabet).run({ image: new Tensor('float32', Float32Array.of(1, 2, 3), [1, 3, 1, 1]) })).rejects.toThrow(/confidence/);
});
