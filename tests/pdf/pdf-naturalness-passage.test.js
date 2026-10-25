import { describe, expect, it } from 'vitest';
import {
  evaluateReadingOrder,
  selectPdfNaturalnessPassage,
  validateNaturalnessRatings,
} from '../../scripts/run-pdf-acceptance.mjs';

// Authored unit metadata only; these reviewer constants are never release evidence.
const humanReviews = (hash, count = 2) => Array.from({ length: count }, (_, i) => ({
  kind: 'human', reviewerId: `unit-reviewer-${i + 1}`, reviewedAt: '2026-01-01T00:00:00.000Z', transcriptSha256: hash,
}));

describe('PDF naturalness passage selection', () => {
  it('freezes one sentence-bounded production chunk instead of an entire page', () => {
    const pageSpeech = Array.from({ length: 40 }, (_value, index) => (
      `Sentence ${index + 1} explains a representative narration behavior with enough detail to score.`
    )).join(' ');

    const passage = selectPdfNaturalnessPassage(pageSpeech);

    expect(passage.length).toBeGreaterThanOrEqual(650);
    expect(passage.length).toBeLessThanOrEqual(900);
    expect(passage).toMatch(/[.!?]$/u);
    expect(pageSpeech.startsWith(passage)).toBe(true);
    expect(passage).not.toBe(pageSpeech);
  });

  it('keeps a short adversarial passage intact', () => {
    const speech = 'A short passage repairs an international split word.';
    expect(selectPdfNaturalnessPassage(speech)).toBe(speech);
  });

  it('scores checkpoint order against production narration rather than raw anchors', () => {
    const result = evaluateReadingOrder({
      anchorText: 'First spoken idea. Second spoken idea.',
      speech: 'Second spoken idea. First spoken idea.',
    }, ['First spoken idea', 'Second spoken idea']);

    expect(result).toEqual({ passed: false, failedCheckpoint: 'Second spoken idea' });
  });

  it('validates the raw ratings fixture before report generation', () => {
    const samples = [
      { id: 'naturalness-01', pdfId: 'pdf-1', pageNumber: 1, categories: ['title', 'ltr'] },
      { id: 'naturalness-02', pdfId: 'pdf-2', pageNumber: 2, categories: ['columns'] },
    ];
    const ratings = samples.map((sample) => ({
      passageId: sample.id,
      transcriptSha256: 'a'.repeat(64),
      reviews: humanReviews('a'.repeat(64)),
      ratings: [4, 5],
      median: 4.5,
      categories: [...sample.categories],
    }));

    expect(() => validateNaturalnessRatings(ratings, samples)).not.toThrow();
    expect(() => validateNaturalnessRatings([...ratings, ratings[0]], samples))
      .toThrow(/ratings fixture/iu);
    expect(() => validateNaturalnessRatings([
      { ...ratings[0], median: 5 },
      ratings[1],
    ], samples)).toThrow(/median/iu);
    expect(() => validateNaturalnessRatings([
      { ...ratings[0], categories: ['rtl'] },
      ratings[1],
    ], samples)).toThrow(/categories/iu);
    expect(() => validateNaturalnessRatings([
      { ...ratings[0], ratings: [4, 5, 5], median: 5 },
      ratings[1],
    ], samples)).toThrow(/adjudication/iu);
    expect(() => validateNaturalnessRatings([
      { ...ratings[0], ratings: [4, 4, 1], median: 4 },
      ratings[1],
    ], samples)).toThrow(/adjudication/iu);
  });
  it.each([
    ['legacy score pair', record => { delete record.reviews; }],
    ['model-generated score', record => { record.reviews[0].kind = 'model'; }],
    ['duplicate reviewer', record => { record.reviews[1].reviewerId = ' UNIT-REVIEWER-1 '; }],
    ['missing reviewer', record => { record.reviews[0].reviewerId = ' '; }],
    ['missing review date', record => { delete record.reviews[0].reviewedAt; }],
    ['invalid review date', record => { record.reviews[0].reviewedAt = '2026-02-30T00:00:00.000Z'; }],
    ['wrong reviewed transcript', record => { record.reviews[0].transcriptSha256 = 'b'.repeat(64); }],
    ['unbound score', record => { record.reviews.pop(); }],
  ])('refuses %s as human naturalness evidence', (_name, mutate) => {
    const sample = { id: 'unit-passage', categories: ['ltr'] };
    const record = { passageId: sample.id, categories: ['ltr'], transcriptSha256: 'a'.repeat(64), ratings: [4, 4], median: 4, reviews: humanReviews('a'.repeat(64)) };
    mutate(record);
    expect(() => validateNaturalnessRatings([record], [sample])).toThrow(/human review/iu);
  });
  it('requires a separate bound human review for the conditional third score', () => {
    const sample = { id: 'unit-passage', categories: ['ltr'] };
    const record = { passageId: sample.id, categories: ['ltr'], transcriptSha256: 'a'.repeat(64), ratings: [2, 4, 4], median: 4, reviews: humanReviews('a'.repeat(64), 3) };
    expect(() => validateNaturalnessRatings([record], [sample])).not.toThrow();
    record.reviews[2].reviewerId = record.reviews[0].reviewerId;
    expect(() => validateNaturalnessRatings([record], [sample])).toThrow(/distinct human reviewers/iu);
  });

});
