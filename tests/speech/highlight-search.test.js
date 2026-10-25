import { describe, expect, it } from 'vitest';
import { findBestMatch, normalizeForSearch } from '../../src/lib/highlight-search.js';

describe('highlight search', () => {
  it('retains degree symbols so temperatures keep their spoken word boundaries', () => {
    expect(normalizeForSearch('Below 25°C, then 36°F 🙂')).toBe('below 25°c, then 36°f');
  });
  it('retains math operators that separate spoken words while omitting emoji', () => {
    expect(normalizeForSearch('error=True, lower+offset 🙂')).toBe('error=true, lower+offset');
  });
  it('continues matching forward when the same sentence appears earlier on the page', () => {
    const fullText = normalizeForSearch([
      'First repeated sentence.',
      'Middle context keeps the reader moving.',
      'First repeated sentence.',
    ].join(' '));
    const target = normalizeForSearch('First repeated sentence.');

    const first = findBestMatch(fullText, target, 0);
    const second = findBestMatch(fullText, target, first.end);

    expect(first.start).toBe(0);
    expect(second.start).toBeGreaterThan(first.end);
    expect(fullText.slice(second.start, second.end)).toBe(target);
  });

  it('does not jump back to an earlier match after the cursor has passed it', () => {
    const fullText = normalizeForSearch('Index sentence. Later unique paragraph.');
    const cursorAfterIndex = normalizeForSearch('Index sentence.').length;

    expect(findBestMatch(fullText, normalizeForSearch('Index sentence.'), cursorAfterIndex)).toBeNull();
  });

  it('does not accept short fuzzy matches that are likely to collide with page furniture', () => {
    const fullText = normalizeForSearch('sidebar repeats a common article opener before the real article begins');
    const target = normalizeForSearch('sidebar repeats a common article opener with different continuation text');

    expect(findBestMatch(fullText, target, 0)).toBeNull();
  });

  it('normalizes smart punctuation and soft PDF hyphenation before searching', () => {
    const fullText = normalizeForSearch('The article says "quoted insight" and shows a hyphenated line break.');
    const target = normalizeForSearch('The article says “quoted insight” and shows a hyphen-\nated line break.');

    expect(target).toBe(fullText);
    expect(findBestMatch(fullText, target, 0)).toEqual({ start: 0, end: fullText.length });
  });

  it('normalizes PDF text-layer soft hyphenation when line breaks became spaces', () => {
    const fullText = normalizeForSearch('Professional annotators produced verbatim tran- scripts for evaluation.');
    const target = normalizeForSearch('Professional annotators produced verbatim transcripts for evaluation.');

    expect(fullText).toBe(target);
    expect(findBestMatch(fullText, target, 0)).toEqual({ start: 0, end: fullText.length });
  });

  it('finds a bounded fuzzy token window when punctuation cleanup changes the exact text', () => {
    const fullText = normalizeForSearch([
      'Introductory text before the article.',
      'The quoted result moved quickly through the page despite punctuation changes.',
      'Closing context.',
    ].join(' '));
    const target = normalizeForSearch('The "quoted" result moved quickly through page despite punctuation changes.');

    const match = findBestMatch(fullText, target, 0);

    expect(match).toEqual(expect.objectContaining({
      start: fullText.indexOf('the quoted result'),
    }));
    expect(fullText.slice(match.start, match.end)).toContain('punctuation changes');
  });
});
