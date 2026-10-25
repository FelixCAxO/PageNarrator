import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

function createDom(text) {
  const dom = new JSDOM(`<main><p>${escapeHtml(text)}</p></main>`, {
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  document.querySelector('p').getBoundingClientRect = () => ({
    width: 120,
    height: 20,
    top: 0,
    left: 0,
    right: 120,
    bottom: 20,
  });
  return dom;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u00df/g, 'ss')
    .replace(/[^\p{L}\p{N}'-]/gu, '');
}

function latestCurrentWord(highlighted) {
  return [...highlighted].reverse().find((entry) => entry.name === 'pagenarrator-word-0') || null;
}

describe('spoken word equals marked word invariant', () => {
  it('selects a DOM range with the same normalized token as every spoken index', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const generatedWord = fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 8 })
      .map((chars) => chars.join(''));
    const generatedCompound = fc.tuple(generatedWord, generatedWord)
      .map(([left, right]) => `${left}-${right}`);
    const generatedContraction = fc.tuple(generatedWord)
      .map(([word]) => `${word}'s`);
    const adversarialToken = fc.oneof(
      generatedWord,
      generatedCompound,
      generatedContraction,
      fc.constantFrom(
        "don't",
        'Dr.',
        'U.S.A.',
        'co-operation',
        'cafe\u0301',
        'M\u00e4rta',
        '\u300c\u65e5\u672c\u300d',
        'soft\u00ADhyphen',
        '\uFB01le',
      ),
    );
    const phrases = [
      "don't stop",
      'Dr. Smith visited the U.S.A.',
      'co-operation restarted',
      'cafe cafe\u0301 Märta',
      '\u300c日本\u300d opens',
      'soft\u00ADhyphen and \uFB01le ligature',
      'alpha - beta',
    ];

    fc.assert(fc.property(
      fc.array(fc.oneof(
        fc.constantFrom(...phrases),
        fc.array(adversarialToken, { minLength: 1, maxLength: 8 }).map((tokens) => tokens.join(' ')),
      ), { minLength: 1, maxLength: 5 }),
      (parts) => {
        const text = parts.join(' ');
        const dom = createDom(text);
        const highlighted = [];
        globalThis.CSS = {
          highlights: {
            set(name, highlight) {
              const ranges = [...highlight.values()];
              highlighted.push({
                name,
                text: ranges.map((range) => range.toString()).join(''),
              });
            },
            delete() {},
          },
        };
        globalThis.Highlight = class Highlight {
          constructor(...ranges) {
            this.ranges = ranges;
          }

          values() {
            return this.ranges.values();
          }
        };

        const highlighter = createPageHighlighter(dom.window.document);
        expect(highlighter.highlightChunk(text)).toEqual({ ok: true });

        const tokens = tokenizeSpokenWords(text);
        for (let index = 0; index < tokens.length; index += 1) {
          expect(highlighter.highlightWord(index)).toEqual({ ok: true });
          const current = latestCurrentWord(highlighted);
          expect(normalizeToken(current?.text)).toBe(normalizeToken(tokens[index].text));
        }
      },
    ), { numRuns: 50 });
  });

  it('throws in test mode when a word plan points outside DOM word ranges', () => {
    const dom = createDom('one two');
    const highlighter = createPageHighlighter(dom.window.document, { strictWordPlan: true });
    expect(highlighter.highlightChunk('one two')).toEqual({ ok: true });

    expect(() => highlighter.highlightWordPlan([
      { index: 4, start: 0, end: 0.1 },
    ], {
      currentTime: 0,
      setTimer() {
        return 1;
      },
    })).toThrow(/Word highlight index 4 is outside 2 DOM word ranges/);
  });
});
