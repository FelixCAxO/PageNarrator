// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scorePdfAcceptance, validateNaturalnessRatingPanel, validateNaturalnessReviews } from '../../scripts/pdf-acceptance-metrics.mjs';

const current = 'a'.repeat(64), historical = 'b'.repeat(64);
const diagnostic = { reportIncompleteNaturalness: true };
// Authored unit metadata only; these reviewer constants are never release evidence.
const humanReviews = (hash, count = 2) => Array.from({ length: count }, (_, i) => ({
  kind: 'human', reviewerId: `unit-reviewer-${i + 1}`, reviewedAt: '2026-01-01T00:00:00.000Z', transcriptSha256: hash,
}));

function input() {
  return {
    pages: Array.from({ length: 100 }, (_, i) => ({ id: `page-${i}`, readingOrder: i < 95, narrationErrors: i < 10 ? 1 : 0 })),
    passages: Array.from({ length: 50 }, (_, i) => ({ id: `passage-${i}`, transcriptHashMatches: true,
      currentTranscriptSha256: current, ratedTranscriptSha256: current, ratingRecordCount: 1, ratings: [4, 4],
      transcriptSha256: current, reviews: humanReviews(current) })),
    chunks: Array.from({ length: 100 }, (_, i) => ({ grounded: i < 98 })),
    words: Array.from({ length: 100 }, (_, i) => ({ aligned: i < 95 })),
    imageOnly: [{ expectedImageOnly: true, code: 'scanned_pdf_unsupported' }, { expectedImageOnly: false, code: 'empty_pdf' }],
  };
}
function machineScores(result) {
  return Object.fromEntries(['readingOrder', 'narration', 'grounding', 'alignment', 'imageOnly'].map(key => [key, result[key]]));
}
const driver = readFileSync(new URL('../../scripts/run-pdf-acceptance.mjs', import.meta.url), 'utf8');
// Execute only these existing pure metadata statements with authored objects, never runPdfAcceptance or any import in that file.
function driverRatingMetadata(samples, ratings, reportIncompleteNaturalness) {
  const validation = driver.slice(driver.indexOf('export function validateNaturalnessRatings('), driver.indexOf('\nfunction countBenchmarkCategories'))
    .replace('export function ', 'function ');
  const validate = new Function('validateNaturalnessRatingPanel', 'validateNaturalnessReviews', `${validation}; return validateNaturalnessRatings;`)(validateNaturalnessRatingPanel, validateNaturalnessReviews);
  const start = driver.includes('  let ratingFixtureError = null;') ? driver.indexOf('  let ratingFixtureError = null;')
    : driver.indexOf('  validateNaturalnessRatings(ratingRecords, PDF_NATURALNESS_SAMPLE);');
  const end = driver.indexOf('  const evaluatedPages = [];', start);
  const prepare = new Function('validateNaturalnessRatings', 'ratingRecords', 'PDF_NATURALNESS_SAMPLE', 'reportIncompleteNaturalness',
    `${driver.slice(start, end)}; return { ratingFixtureError: typeof ratingFixtureError === 'undefined' ? null : ratingFixtureError,
      ratingRows: typeof ratingRows === 'undefined' ? ratingRecords : ratingRows, ratingsByPassageId };`);
  return prepare(validate, ratings, samples, reportIncompleteNaturalness);
}
function driverPassages(samples, ratings, hashes) {
  const metadata = driverRatingMetadata(samples, ratings, true);
  const body = driver.slice(driver.indexOf('  const passages = PDF_NATURALNESS_SAMPLE.map('), driver.indexOf('  const imageOnly = await evaluateImageOnlyFixtures'));
  const select = new Function('PDF_NATURALNESS_SAMPLE', 'ratingsByPassageId', 'pagesById', 'ratingRows', 'reportIncompleteNaturalness', `${body}; return passages;`);
  const passages = select(samples, metadata.ratingsByPassageId,
    new Map(samples.map(sample => [sample.pdfId, { naturalnessTranscriptHash: hashes.get(sample.id) }])), metadata.ratingRows, true);
  return { ...metadata, passages };
}

describe('explicit incomplete-human-evidence PDF reporting', () => {
  it('keeps the existing strict API shape and stale-evidence throw', () => {
    const value = input(), strict = scorePdfAcceptance(value);
    expect(strict.naturalness).toEqual({ passages: 50, average: 4 }); expect(strict.passed).toBe(true);
    value.passages[4].transcriptHashMatches = false;
    expect(() => scorePdfAcceptance(value)).toThrow('stale transcript hash for passage-4');
  });
  it('retains every machine score and all50 human slots, but no aggregate or pass for stale ratings', () => {
    const value = input(), expected = machineScores(scorePdfAcceptance(value)), before = structuredClone(value);
    value.passages[4].transcriptHashMatches = false; value.passages[4].ratedTranscriptSha256 = historical;
    const frozen = structuredClone(value), result = scorePdfAcceptance(value, diagnostic);
    expect(machineScores(result)).toEqual(expected); expect(result.passed).toBe(false);
    expect(result.naturalness).toMatchObject({ passages: 50, average: null, evidence: { complete: false, total: 50, qualifiedPassages: 49 } });
    expect(result.naturalness.evidence.records[4]).toMatchObject({ id: 'passage-4', status: 'NOT_QUALIFIED', currentTranscriptSha256: current, ratedTranscriptSha256: historical });
    expect(value).toEqual(frozen); expect(before.passages[4].ratings).toEqual(value.passages[4].ratings);
  });
  it('records every stale/missing passage instead of stopping at the first', () => {
    const value = input();
    value.passages[0].ratedTranscriptSha256 = historical;
    value.passages[1].ratingRecordCount = 0; value.passages[1].ratings = []; value.passages[1].ratedTranscriptSha256 = null;
    const result = scorePdfAcceptance(value, diagnostic);
    expect(result.passed).toBe(false); expect(result.naturalness.average).toBeNull();
    expect(result.naturalness.evidence.records.filter(row => !row.qualified).map(row => row.id)).toEqual(['passage-0', 'passage-1']);
  });
  it.each([
    ['bad panel', value => { value.passages[0].ratings = [2, 4]; }],
    ['missing current hash', value => { value.passages[0].currentTranscriptSha256 = null; }],
    ['duplicate rating', value => { value.passages[0].ratingRecordCount = 2; }],
  ])('refuses %s without discarding machine scores', (_name, mutate) => {
    const value = input(); mutate(value); const result = scorePdfAcceptance(value, diagnostic);
    expect(result.passed).toBe(false); expect(result.naturalness.average).toBeNull(); expect(result.readingOrder.accuracy).toBe(.95);
  });
  it('does not trust a true hashMatches flag when actual hash bindings differ', () => {
    const value = input(); value.passages[0].ratedTranscriptSha256 = historical;
    expect(scorePdfAcceptance(value, diagnostic).naturalness.evidence.records[0].issues.some(issue => issue.code === 'stale-transcript')).toBe(true);
  });
  it('still rejects broken source/evidence denominators and duplicate passage identities', () => {
    const short = input(); short.pages.pop(); expect(() => scorePdfAcceptance(short, diagnostic)).toThrow('Expected 100');
    const duplicate = input(); duplicate.passages[1].id = duplicate.passages[0].id;
    expect(() => scorePdfAcceptance(duplicate, diagnostic)).toThrow('50 unique');
  });
  it('preserves all thresholds for complete matching human evidence', () => {
    expect(scorePdfAcceptance(input(), diagnostic).passed).toBe(true);
    const value = input(); value.passages[0].ratings = [3, 3];
    expect(scorePdfAcceptance(value, diagnostic).naturalness.average).toBe(3.98);
    expect(scorePdfAcceptance(value, diagnostic).passed).toBe(false);
    value.passages[0].ratings = [4, 4]; value.pages[10].narrationErrors = 1;
    expect(scorePdfAcceptance(value, diagnostic).narration.errors).toBe(11); expect(scorePdfAcceptance(value, diagnostic).passed).toBe(false);
  });
  it('keeps malformed historical fixture evidence unqualified even when per-passage hashes match', () => {
    const result = scorePdfAcceptance(input(), { ...diagnostic, ratingFixtureError: 'Original fixture median mismatch.' });
    expect(result.passed).toBe(false); expect(result.naturalness.average).toBeNull();
    expect(result.naturalness.evidence.fixtureError).toBe('Original fixture median mismatch.');
  });
  it('binds actual driver metadata to the current and original hashes without replacing old ratings', () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ id: `passage-${i}`, pdfId: `source-${i}`, pageNumber: 1, categories: ['ltr'] }));
    const ratings = samples.map(sample => ({ passageId: sample.id, transcriptSha256: historical, ratings: [4, 5], median: 4.5, categories: ['ltr'], reviews: humanReviews(historical) }));
    const before = structuredClone(ratings), hashes = new Map(samples.map(sample => [sample.id, current]));
    const prepared = driverPassages(samples, ratings, hashes), value = input(); value.passages = prepared.passages;
    const result = scorePdfAcceptance(value, { ...diagnostic, ratingFixtureError: prepared.ratingFixtureError });
    expect(prepared.passages[0]).toMatchObject({ currentTranscriptSha256: current, ratedTranscriptSha256: historical, ratingRecordCount: 1, ratings: [4, 5] });
    expect(result.naturalness.evidence.qualifiedPassages).toBe(0); expect(result.passed).toBe(false); expect(ratings).toEqual(before);
  });
  it('keeps default driver fixture validation strict while opt-in records a missing human row', () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ id: `passage-${i}`, pdfId: `source-${i}`, pageNumber: 1, categories: ['ltr'] }));
    const ratings = samples.slice(1).map(sample => ({ passageId: sample.id, transcriptSha256: current, ratings: [4, 4], median: 4, categories: ['ltr'], reviews: humanReviews(current) }));
    expect(() => driverRatingMetadata(samples, ratings, false)).toThrow('exactly 50');
    const prepared = driverPassages(samples, ratings, new Map(samples.map(sample => [sample.id, current])));
    expect(prepared.ratingFixtureError).toMatch(/exactly 50/); expect(prepared.passages[0].ratingRecordCount).toBe(0);
    const value = input(); value.passages = prepared.passages;
    expect(scorePdfAcceptance(value, { ...diagnostic, ratingFixtureError: prepared.ratingFixtureError }).passed).toBe(false);
  });
  it('reports all50 missing reviews for an empty human collection without changing machine counts', () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ id: `passage-${i}`, pdfId: `source-${i}`, pageNumber: 1, categories: ['ltr'] }));
    expect(() => driverRatingMetadata(samples, [], false)).toThrow('exactly 50');
    const prepared = driverPassages(samples, [], new Map(samples.map(sample => [sample.id, current])));
    const expected = machineScores(scorePdfAcceptance(input())), value = input(); value.passages = prepared.passages;
    const result = scorePdfAcceptance(value, { ...diagnostic, ratingFixtureError: prepared.ratingFixtureError });
    expect(result.naturalness).toMatchObject({ passages: 50, average: null, evidence: { complete: false, total: 50, qualifiedPassages: 0 } });
    expect(result.naturalness.evidence.records).toHaveLength(50);
    expect(result.naturalness.evidence.records.every(row => !row.qualified && row.issues.some(issue => issue.code === 'missing-rating'))).toBe(true);
    expect(machineScores(result)).toEqual(expected); expect(result.passed).toBe(false);
  });
  it.each(['legacy scores', 'model scores'])('refuses %s even with matching transcripts and a valid numeric panel', kind => {
    const value = input(), expected = machineScores(scorePdfAcceptance(value));
    if (kind === 'legacy scores') delete value.passages[0].reviews;
    else value.passages[0].reviews[0].kind = 'model';
    expect(() => scorePdfAcceptance(value)).toThrow(/human review/iu);
    const result = scorePdfAcceptance(value, diagnostic);
    expect(result.naturalness.average).toBeNull(); expect(result.naturalness.evidence.qualifiedPassages).toBe(49);
    expect(result.naturalness.evidence.records[0].issues.some(issue => issue.code === 'invalid-human-review')).toBe(true);
    expect(machineScores(result)).toEqual(expected); expect(result.passed).toBe(false);
  });

});
