import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  stripNonSpokenTokens,
  tokenizeSpokenWords,
} from '../../src/lib/speech-tokenization.js';

describe('speech tokenization invariants', () => {
  it('keeps token source ranges round-trippable across punctuation-heavy fixtures', () => {
    const fixtures = [
      "Don't split re-entered words or U.S. initials [1].",
      'Artificial intelligence (AI) (/eI/) improves tasks quickly.',
      'The hyphen-\nated line keeps a searchable token.',
      'Problem 8.11: heads-tails matrix uses 0 and 1.',
    ];

    for (const text of fixtures) {
      for (const token of tokenizeSpokenWords(text)) {
        expect(text.slice(token.start, token.end)).toBe(token.text);
      }
    }
  });

  it('is idempotent after non-spoken tokens are stripped', () => {
    fc.assert(fc.property(fc.string(), (value) => {
      const once = stripNonSpokenTokens(value);
      const twice = stripNonSpokenTokens(once);
      expect(tokenizeSpokenWords(twice).map((token) => token.text)).toEqual(
        tokenizeSpokenWords(once).map((token) => token.text),
      );
    }), { numRuns: 100 });
  });
});
