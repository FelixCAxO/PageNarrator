import { describe, expect, it } from 'vitest';
import {
  countNarrationErrors,
  matchesOrderedCheckpoints,
  scorePdfAcceptance,
} from '../../scripts/pdf-acceptance-metrics.mjs';

// Authored unit metadata only; these reviewer constants are never release evidence.
const humanReviews = (hash, count = 2) => Array.from({ length: count }, (_, i) => ({
  kind: 'human', reviewerId: `unit-reviewer-${i + 1}`, reviewedAt: '2026-01-01T00:00:00.000Z', transcriptSha256: hash,
}));

const passingInput = {
  pages: Array.from({ length: 100 }, (_, index) => ({
    id: `pdf-${index + 1}`,
    readingOrder: index < 95,
    narrationErrors: index < 10 ? 1 : 0,
  })),
  passages: Array.from({ length: 50 }, (_, index) => ({
    id: `passage-${index + 1}`,
    transcriptHashMatches: true,
    transcriptSha256: 'a'.repeat(64), reviews: humanReviews('a'.repeat(64)),
    ratings: [4, 4],
  })),
  chunks: Array.from({ length: 100 }, (_, index) => ({ grounded: index < 98 })),
  words: Array.from({ length: 100 }, (_, index) => ({ aligned: index < 95 })),
  imageOnly: [
    { id: 'scan-1', expectedImageOnly: true, code: 'scanned_pdf_unsupported' },
    { id: 'blank-control', expectedImageOnly: false, code: 'empty_pdf' },
  ],
};

describe('PDF acceptance metrics', () => {
  it('counts page-number and symbol furniture only as standalone narration', () => {
    expect(countNarrationErrors(
      'Page 5 contains meaningful body prose. A title: keeps its structural pause.',
      ['Page 5', ':'],
    )).toBe(0);
    expect(countNarrationErrors('Body prose. Page 5. :.', ['Page 5', ':'])).toBe(2);
    expect(countNarrationErrors('Page 5 Introduction.', ['Page 5'])).toBe(1);
  });

  it('matches visual checkpoints across PDF item splits without losing order', () => {
    const text = [
      'L EGAL M IDM: U SE-C ASE-D RIVEN',
      'An appli-',
      'cations example',
      'Thoughtful design connects inter-',
      'national readers',
    ].join('\n\n');

    expect(matchesOrderedCheckpoints(text, [
      'LEGALMIDM: USE-CASE-DRIVEN',
      'An applications example',
      'Thoughtful design connects inter-',
      'national readers',
    ])).toEqual({ passed: true, failedCheckpoint: null });
    expect(matchesOrderedCheckpoints(text, [
      'national readers',
      'An applications example',
    ])).toEqual({ passed: false, failedCheckpoint: 'An applications example' });
  });

  it('matches narration checkpoints after soft-wrap repair and citation suppression', () => {
    const narration = 'Thoughtful design connects international readers. Prior evidence supports the finding.';

    expect(matchesOrderedCheckpoints(narration, [
      'Thoughtful design connects inter-',
      'national readers',
      'Prior evidence [7]',
      'supports the finding',
    ])).toEqual({ passed: true, failedCheckpoint: null });
  });

  it('folds canonical Latin diacritics without fuzzy-matching unrelated words', () => {
    expect(matchesOrderedCheckpoints(
      'A Pāṇinian Foundation for Indic Language Processing.',
      ['A Paninian Foundation for Indic Language Processing'],
    )).toEqual({ passed: true, failedCheckpoint: null });
    expect(matchesOrderedCheckpoints('A planning foundation.', ['A Paninian Foundation']))
      .toEqual({ passed: false, failedCheckpoint: 'A Paninian Foundation' });
  });

  it('matches complete split words on either side, including crossed item boundaries', () => {
    for (const [actual, expected] of [
      ['Careful Engine ering remains useful.', 'Careful Engineering remains useful.'],
      ['Careful Engineering remains useful.', 'Careful Engine ering remains useful.'],
      ['The ab cde fgh result follows.', 'The a bc def gh result follows.'],
      ['The café remains open.', 'The ca fe remains open.'],
    ]) expect(matchesOrderedCheckpoints(actual, [expected])).toEqual({ passed: true, failedCheckpoint: null });
    expect(matchesOrderedCheckpoints('abcdefgh', ['a b c d e f g h']).passed).toBe(true);
    expect(matchesOrderedCheckpoints('a b c d e f g h', ['abcdefgh']).passed).toBe(true);
    expect(matchesOrderedCheckpoints('abcdefghi', ['a b c d e f g h i']).passed).toBe(false);
    expect(matchesOrderedCheckpoints('a b c d e f g h i', ['abcdefghi']).passed).toBe(false);
  });

  it.each([
    ['Engineering remains useful.', 'Engineer remains useful.'],
    ['Engineering remains useful.', 'Enginering remains useful.'],
    ['Prehistory remains useful.', 'history remains useful.'],
    ['The score is123.', 'The score is12.'],
    ['An engine remains useful.', 'Engineering remains useful.'],
  ])('does not accept a prefix, interior or omitted letter: %s', (actual, expected) => {
    expect(matchesOrderedCheckpoints(actual, [expected])).toEqual({ passed: false, failedCheckpoint: expected });
  });

  it('retains order and non-overlap when checkpoint phrases repeat', () => {
    expect(matchesOrderedCheckpoints('The first example. The final example.', ['The final example', 'The first example']).passed).toBe(false);
    expect(matchesOrderedCheckpoints('alpha beta alpha gamma', ['alpha beta', 'alpha gamma']).passed).toBe(true);
    expect(matchesOrderedCheckpoints('alpha beta gamma', ['alpha beta', 'beta gamma']).passed).toBe(false);
  });

  it('scores the existing explicit URL-suppression policy while preserving adjacent body words', () => {
    for (const url of ['https://example.test/manual', 'http://example.test/manual', 'www.example.test/manual', 'github.com/team/project', 'kaggle.com/team/data']) {
      const checkpoint = `Read the manual (${url}) and then test the result.`;
      expect(matchesOrderedCheckpoints('Read the manual and then test the result.', [checkpoint]).passed).toBe(true);
      expect(matchesOrderedCheckpoints('Read the manual then test the result.', [checkpoint]).passed).toBe(false);
      expect(matchesOrderedCheckpoints('Test the result and then read the manual.', [checkpoint]).passed).toBe(false);
      expect(matchesOrderedCheckpoints('Some unrelated body text.', [url])).toEqual({ passed: false, failedCheckpoint: url });
    }
  });

  it('does not delete unqualified domains, ordinary words or candidate narration URLs', () => {
    expect(matchesOrderedCheckpoints('The example remains.', ['The example.test remains.']).passed).toBe(false);
    expect(matchesOrderedCheckpoints('The project remains.', ['The github.com project remains.']).passed).toBe(false);
    expect(matchesOrderedCheckpoints('The www manual remains.', ['The www manual remains.']).passed).toBe(true);
    expect(matchesOrderedCheckpoints('Read https://example.test/manual and test.', ['Read and test.']).passed).toBe(false);
  });

  it.each(["'", '"'])('requires URL hostnames and parameters inside %s quoted call/assignment literals', quote => {
    for (const checkpoint of [
      `open_endpoint(${quote}www.example.test${quote}, 443, timeout=20)`,
      `client.open_endpoint(${quote}https://user@host.example.test/0000-0002-1825-0097${quote}, 443)`,
      `endpoint = ${quote}https://example.test/manual?chapter=3${quote}`,
    ]) {
      expect(matchesOrderedCheckpoints(checkpoint, [checkpoint]).passed).toBe(true);
      const omitted = checkpoint.replace(/(?:https?:\/\/|www\.)[^'"]+/u, '');
      expect(matchesOrderedCheckpoints(omitted, [checkpoint])).toEqual({ passed: false, failedCheckpoint: checkpoint });
    }
  });

  it('still suppresses quoted prose URLs and does not treat equality as assignment', () => {
    expect(matchesOrderedCheckpoints('Read the guide and then test.', ["Read the guide ('https://example.test/manual') and then test."]).passed).toBe(true);
    expect(matchesOrderedCheckpoints('The endpoint equals the recommended value.', ["The endpoint equals 'https://example.test/manual' the recommended value."]).passed).toBe(true);
    expect(matchesOrderedCheckpoints('endpoint == value', ["endpoint == 'https://example.test/manual' value"]).passed).toBe(true);
    expect(matchesOrderedCheckpoints("open_endpoint('optional label')", ["open_endpoint('https://example.test/manual optional label')"]).passed).toBe(true);
  });

  it('passes only at every exact definition-of-done boundary', () => {
    expect(scorePdfAcceptance(passingInput)).toMatchObject({
      passed: true,
      readingOrder: { passed: 95, total: 100, accuracy: 0.95 },
      narration: { errors: 10, pages: 100 },
      naturalness: { passages: 50, average: 4 },
      grounding: { accuracy: 0.98 },
      alignment: { accuracy: 0.95 },
      imageOnly: { accuracy: 1 },
    });
  });

  it.each([
    ['reading order', (input) => { input.pages[94].readingOrder = false; }],
    ['narration noise', (input) => { input.pages[10].narrationErrors = 1; }],
    ['naturalness', (input) => { input.passages[0].ratings = [3, 3]; }],
    ['grounding', (input) => { input.chunks[97].grounded = false; }],
    ['alignment', (input) => { input.words[94].aligned = false; }],
    ['image-only routing', (input) => { input.imageOnly[0].code = 'empty_pdf'; }],
  ])('fails when %s drops below its boundary', (_name, mutate) => {
    const input = structuredClone(passingInput);
    mutate(input);
    expect(scorePdfAcceptance(input).passed).toBe(false);
  });

  it.each([
    ['benchmark pages', (input) => { input.pages.pop(); }, 'Expected 100 benchmark pages, got 99.'],
    ['naturalness passages', (input) => { input.passages.pop(); }, 'Expected 50 naturalness passages, got 49.'],
    ['grounding evidence', (input) => { input.chunks = []; }, 'Grounding, word, and image-only evidence is required.'],
    ['word evidence', (input) => { input.words = []; }, 'Grounding, word, and image-only evidence is required.'],
    ['image-only evidence', (input) => { input.imageOnly = []; }, 'Grounding, word, and image-only evidence is required.'],
  ])('rejects an invalid %s denominator', (_name, mutate, message) => {
    const input = structuredClone(passingInput);
    mutate(input);
    expect(() => scorePdfAcceptance(input)).toThrow(message);
  });

  it.each([
    ['stale transcript hash', (input) => { input.passages[0].transcriptHashMatches = false; }],
    ['missing rating', (input) => { input.passages[0].ratings = [5]; }],
    ['unadjudicated disagreement', (input) => { input.passages[0].ratings = [2, 4]; }],
    ['unexpected adjudication', (input) => { input.passages[0].ratings = [4, 5, 5]; }],
    ['out-of-range rating', (input) => { input.passages[0].ratings = [5, 6]; }],
    ['duplicate passage id', (input) => { input.passages[1].id = input.passages[0].id; }],
  ])('rejects %s before aggregate naturalness scoring', (_name, mutate) => {
    const input = structuredClone(passingInput);
    input.passages.forEach((passage) => { passage.ratings = [5, 5]; });
    mutate(input);
    expect(() => scorePdfAcceptance(input)).toThrow(/naturalness evidence/iu);
  });
});
