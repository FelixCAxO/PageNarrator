import { describe, expect, it } from 'vitest';
import {
  splitTextIntoWords,
  stripNonSpokenTokens,
  tokenizeSpeechText,
  tokenizeSpokenWords,
} from '../../src/lib/speech-tokenization.js';

describe('speech tokenization', () => {
  it('keeps French elisions as single highlight units', () => {
    const tokens = tokenizeSpeechText(
      "L'intelligence artificielle est l'ensemble des systèmes d'information qu'on utilise aujourd'hui.",
    );

    expect(tokens.map((token) => token.text)).toEqual([
      "L'intelligence",
      'artificielle',
      'est',
      "l'ensemble",
      'des',
      'systèmes',
      "d'information",
      "qu'on",
      'utilise',
      "aujourd'hui.",
    ]);
  });

  it('tokenizes spoken words without boundary punctuation or non-spoken markup', () => {
    const text = 'Wait... "don\'t-stop," Artificial intelligence (AI) improves tasks[1] quickly.';
    const tokens = tokenizeSpokenWords(text);

    expect(tokens.map((token) => token.text)).toEqual([
      'Wait',
      "don't-stop",
      'Artificial',
      'intelligence',
      'AI',
      'improves',
      'tasks',
      'quickly',
    ]);
    expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual(tokens.map((token) => token.text));
  });

  it('exposes one Unicode-aware word splitter for chunking, timing, and highlighting callers', () => {
    const text = 'Emoji \uD83D\uDE42, caf\u00E9, 中文 terms, and "don\'t-stop" survive.';

    expect(splitTextIntoWords(text).map((token) => token.text)).toEqual([
      'Emoji',
      'caf\u00E9',
      '中文',
      'terms',
      'and',
      "don't-stop",
      'survive',
    ]);
    expect(splitTextIntoWords(text)).toEqual(tokenizeSpokenWords(text));
  });

  it('strips citations, standalone IPA hints and punctuation while retaining abbreviations', () => {
    expect(stripNonSpokenTokens(
      'Artificial intelligence (AI) (/\u02c8e\u026a a\u026a/) improves tasks[1] -- quickly.',
    )).toBe('Artificial intelligence (AI) improves tasks quickly.');
  });

  it('keeps short explanatory parentheticals in spoken text', () => {
    expect(stripNonSpokenTokens(
      'The result (small but useful) stays inline while citations [1-3] disappear.',
    )).toBe('The result (small but useful) stays inline while citations disappear.');
  });

  it.each(['TTS', 'LPC', 'NTT', 'LSP', 'TSI', 'GAN', 'DNN', 'ROM', 'SSML', 'JSML', 'W3C', 'WAI', 'ATAG', 'UAAG', 'R&D', 'H2O', 'U.S.'])('preserves meaningful parenthetical %s for speech and highlighting', (term) => {
    const source = `The abbreviation (${term}) remains useful[1].`;
    const speech = stripNonSpokenTokens(source);
    expect(speech).toBe(`The abbreviation (${term}) remains useful.`);
    const tokens = tokenizeSpokenWords(source);
    expect(tokens.map(token => token.text)).toEqual(tokenizeSpokenWords(speech).map(token => token.text));
    expect(tokens.map(token => source.slice(token.start, token.end))).toEqual(tokens.map(token => token.text));
  });

  it('preserves an explanatory parenthesis that contains a pronunciation example', () => {
    const source = 'Context matters (e.g. "clear out" is realized as /ˌklɪəɹˈʌʊt/), while (/ˈeɪ aɪ/) is a standalone hint.';
    expect(stripNonSpokenTokens(source)).toBe('Context matters (e.g. "clear out" is realized as /ˌklɪəɹˈʌʊt/), while is a standalone hint.');
    expect(tokenizeSpokenWords(source).map(token => token.text)).toEqual(tokenizeSpokenWords(stripNonSpokenTokens(source)).map(token => token.text));
  });

  it('keeps leading-dot names separate from the preceding word', () => {
    const source = 'from .sibling import example; corresponding .py files matter .';
    expect(stripNonSpokenTokens(source)).toBe('from .sibling import example; corresponding .py files matter');
  });

  it.each(['–', '—'])('keeps the clause boundary of a spaced %s without adding spoken words', (dash) => {
    const source = `Webb ${dash} this requires more observing time.`;
    const speech = stripNonSpokenTokens(source);
    expect(speech).toBe('Webb, this requires more observing time.');
    expect(tokenizeSpokenWords(speech).map(token => token.text)).toEqual(
      tokenizeSpokenWords(source).map(token => token.text),
    );
    expect(stripNonSpokenTokens(speech)).toBe(speech);
  });

  it('keeps short slash-bearing prose parentheticals unless they are IPA hints', () => {
    expect(stripNonSpokenTokens(
      'The setting (input/output) remains visible while the hint (/test/) is removed.',
    )).toBe('The setting (input/output) remains visible while the hint is removed.');
  });
});
