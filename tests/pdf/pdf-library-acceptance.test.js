import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { scorePdfAcceptance } from '../../scripts/pdf-acceptance-metrics.mjs';
import { releaseGateWaiver } from '../../scripts/lib/release-policy.mjs';
import { bindPdfNaturalnessRatings, runPdfAcceptance } from '../../scripts/run-pdf-acceptance.mjs';
import { PDF_LIBRARY_NATURALNESS_SAMPLE } from '../fixtures/pdf-library-naturalness-sample.js';

const waiver = releaseGateWaiver('human-listening-reviews', '1.0.0');

it('accepts only explicitly authorized versioned human-review waivers', () => {
  const approved = releaseGateWaiver('human-listening-reviews', '1.0.1');
  expect(scorePdfAcceptance(evidence(), { naturalnessWaiver: approved }).naturalness).toMatchObject({ status: 'waived', verified: false });
  expect(() => scorePdfAcceptance(evidence(), { naturalnessWaiver: { ...approved, version: '1.0.2' } })).toThrow('Invalid PDF naturalness release waiver');
  expect(() => scorePdfAcceptance(evidence(), { naturalnessWaiver: { ...approved, authorizedOn: '2026-10-24' } })).toThrow('Invalid PDF naturalness release waiver');
});
function evidence() {
  return { pages: Array.from({ length: 100 }, (_, i) => ({ id: `owned-${i}`, evaluated: true, readingOrder: i < 95, narrationErrors: i < 10 ? 1 : 0 })),
    passages: [], chunks: Array.from({ length: 100 }, (_, i) => ({ grounded: i < 98 })),
    words: Array.from({ length: 100 }, (_, i) => ({ aligned: i < 95 })),
    imageOnly: [{ expectedImageOnly: true, code: 'scanned_pdf_unsupported' }, { expectedImageOnly: false, code: null }] };
}

it('qualifies bound human panels without a waiver and rejects stale, missing and ambiguous receipts', () => {
  const input = evidence(), samples = PDF_LIBRARY_NATURALNESS_SAMPLE, transcriptSha256 = 'a'.repeat(64);
  samples.forEach((sample, index) => Object.assign(input.pages[index], { id: sample.pdfId, naturalnessTranscriptHash: transcriptSha256 }));
  const records = samples.map(sample => ({ passageId: sample.id, transcriptSha256, ratings: [4, 5], median: 4.5,
    categories: [...sample.categories], reviews: ['test-panel-a', 'test-panel-b'].map(reviewerId => ({ kind: 'human', reviewerId,
      reviewedAt: '2026-10-26T12:00:00.000Z', transcriptSha256 })) }));
  const evaluate = rows => scorePdfAcceptance({ ...input, passages: bindPdfNaturalnessRatings(samples, input.pages, rows) }, { reportIncompleteNaturalness: true });
  expect(evaluate(records)).toMatchObject({ passed: true, naturalness: { average: 4.5, evidence: { qualifiedPassages: 50 } } });
  input.pages[0].naturalnessTranscriptHash = 'b'.repeat(64);
  expect(evaluate(records)).toMatchObject({ passed: false, naturalness: { evidence: { qualifiedPassages: 49 } } });
  expect(() => scorePdfAcceptance({ ...input, passages: bindPdfNaturalnessRatings(samples, input.pages, records) })).toThrow('stale transcript');
  input.pages[0].naturalnessTranscriptHash = transcriptSha256;
  expect(evaluate(records.slice(1)).naturalness.evidence.records[0].issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-rating' })]));
  expect(evaluate([...records, records[0]]).naturalness.evidence.records[0].issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ambiguous-rating' })]));
});
const driver = readFileSync(new URL('../../scripts/run-pdf-acceptance.mjs', import.meta.url), 'utf8');
function contextualReader(iteratePdfSpeechChunks) {
  const start = driver.indexOf('async function getLibraryProductionPageText(');
  const end = driver.indexOf('\nexport function evaluateReadingOrder(', start);
  return new Function('iteratePdfSpeechChunks', `${driver.slice(start, end)}; return getLibraryProductionPageText;`)(iteratePdfSpeechChunks);
}
function routingReader(iteratePdfSpeechChunks) {
  const start = driver.indexOf('async function evaluateNativeRoutingControl(');
  const end = driver.indexOf('\nasync function getLibraryProductionPageText(', start);
  return new Function('iteratePdfSpeechChunks', `${driver.slice(start, end)}; return evaluateNativeRoutingControl;`)(iteratePdfSpeechChunks);
}

describe('library automatic metrics with the explicit user review waiver', () => {
  it('retains every numeric boundary and reports waived, never a fabricated human score', () => {
    const result = scorePdfAcceptance(evidence(), { naturalnessWaiver: waiver });
    expect(result.passed).toBe(true);
    expect(result.naturalness).toMatchObject({ status: 'waived', verified: false, passages: 0, average: null });
    expect(result.readingOrder.accuracy).toBe(.95); expect(result.narration.errors).toBe(10);
    expect(result.grounding.accuracy).toBe(.98); expect(result.alignment.accuracy).toBe(.95);
    expect(result.imageOnly.accuracy).toBe(1);
    expect(() => scorePdfAcceptance(evidence())).toThrow('Expected 50 naturalness passages');
  });
  it.each([
    ['reading order', input => { input.pages[94].readingOrder = false; }],
    ['narration', input => { input.pages[10].narrationErrors = 1; }],
    ['grounding', input => { input.chunks[97].grounded = false; }],
    ['alignment', input => { input.words[94].aligned = false; }],
    ['image routing', input => { input.imageOnly[0].code = 'unexpected_error'; }],
    ['empty readable page', input => { input.pages[0].emptyOutput = true; input.pages[0].evaluated = false; }],
    ['page exception', input => { input.pages[0].error = { code: 'pdf_corrupt' }; }],
  ])('still fails %s', (_name, mutate) => {
    const input = evidence(); mutate(input);
    expect(scorePdfAcceptance(input, { naturalnessWaiver: waiver }).passed).toBe(false);
  });
  it('refuses invented waiver metadata or silently discarded reviews', () => {
    expect(() => scorePdfAcceptance(evidence(), { naturalnessWaiver: { ...waiver, status: 'passed' } })).toThrow('Invalid PDF naturalness release waiver');
    const input = evidence(); input.passages.push({ ratings: [5, 5] });
    expect(() => scorePdfAcceptance(input, { naturalnessWaiver: waiver })).toThrow('Expected 0 naturalness passages');
  });
});

describe('library narration uses real contextual production metadata', () => {
  it('keeps the complete target-page speech and closes the stream before visiting later pages', async () => {
    let returned = 0;
    const metadata = { speech: 'First original clause. Complete target page ending.', narratedItemOrders: [2, 3] };
    const iterate = vi.fn(async function* () {
      try {
        yield { pageNumber: 5, speech: 'Context page.' };
        yield { pageNumber: 8, speech: 'First original clause.', anchorText: 'Original selectable target.', pdfNarration: metadata };
        throw new Error('Must not parse later pages');
      } finally { returned++; }
    });
    const destroy = vi.fn(), getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 20 }), destroy }));
    const result = await contextualReader(iterate)(new Uint8Array([1]), { pageNumber: 8, narrationStartPage: 5 }, { getDocument });
    expect(iterate.mock.calls[0][1].startPage).toBe(5);
    expect(result.speech).toBe(metadata.speech); expect(result.pdfNarration).toBe(metadata);
    expect(returned).toBe(1); expect(destroy).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'empty', 'exception'])('retains failure/cleanup for %s target output', async mode => {
    let closed = false;
    const iterate = async function* () {
      try {
        if (mode === 'exception') throw new Error('original extraction failed');
        if (mode === 'missing') yield { pageNumber: 8, speech: 'Not a full-page contract.' };
      } finally { closed = true; }
    };
    const destroy = vi.fn(), pdfjs = { getDocument: () => ({ promise: Promise.resolve({}), destroy }) };
    const result = contextualReader(iterate)(new Uint8Array([1]), { pageNumber: 8, narrationStartPage: 5 }, pdfjs);
    if (mode === 'empty') expect((await result).speech).toBe(''); else await expect(result).rejects.toThrow();
    expect(closed).toBe(true); expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('native routing controls require the exact target and contextual refusal', () => {
  const record = { pageNumber: 10, narrationStartPage: 7, expectedCode: 'scanned_pdf_unsupported' };
  const backend = destroy => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 20, getPage: vi.fn() }), destroy: destroy ?? vi.fn() }) });
  const refusing = code => async function* () { throw Object.assign(new Error('Original native refusal.'), { code }); };
  it('accepts both exact typed refusals and preserves their actual diagnostics', async () => {
    const reader = vi.fn(refusing(record.expectedCode)), destroy = vi.fn();
    const result = await routingReader(reader)(new Uint8Array([1]), record, backend(destroy));
    expect(result.passed).toBe(true);
    expect(reader.mock.calls.map(call => call[1].startPage)).toEqual([10, 7]);
    expect(result.probes.map(probe => probe.code)).toEqual([record.expectedCode, record.expectedCode]);
    expect(result.probes[0].error.message).toBe('Original native refusal.');
    expect(destroy).toHaveBeenCalledTimes(2);
  });
  it.each(['pdf_corrupt', 'pdf_unsupported', null])('rejects an incorrect or missing error code: %s', async code => {
    expect((await routingReader(refusing(code))(new Uint8Array([1]), record, backend())).passed).toBe(false);
  });
  it.each(['Partial native text.', ''])('rejects successful partial/empty output instead of treating it as OCR success', async speech => {
    const reader = async function* () { yield { pageNumber: 10, speech }; };
    const result = await routingReader(reader)(new Uint8Array([1]), record, backend());
    expect(result.passed).toBe(false);
    expect(result.probes.every(probe => probe.returnedOutput && probe.code === null)).toBe(true);
  });
  it('does not substitute an earlier contextual refusal for an incorrect target-page route', async () => {
    const reader = vi.fn().mockImplementationOnce(refusing('pdf_corrupt')).mockImplementationOnce(refusing(record.expectedCode));
    const result = await routingReader(reader)(new Uint8Array([1]), record, backend());
    expect(result.passed).toBe(false); expect(reader).toHaveBeenCalledTimes(2);
  });
  it('does not count a cleanup refusal as the required stream failure', async () => {
    const destroy = vi.fn().mockRejectedValue(Object.assign(new Error('Cleanup failed.'), { code: record.expectedCode }));
    const reader = async function* () { yield { pageNumber: 10, speech: 'Partial native text.' }; };
    const result = await routingReader(reader)(new Uint8Array([1]), record, backend(destroy));
    expect(result.passed).toBe(false);
    expect(result.probes.every(probe => probe.returnedOutput && probe.code === null && probe.cleanupErrors.length === 1)).toBe(true);
  });
  it('retains an exact stream refusal but fails if subsequent cleanup also fails', async () => {
    const destroy = vi.fn().mockRejectedValue(new Error('Real destruction failure.'));
    const result = await routingReader(refusing(record.expectedCode))(new Uint8Array([1]), record, backend(destroy));
    expect(result.passed).toBe(false);
    expect(result.probes.every(probe => probe.code === record.expectedCode && probe.cleanupErrors.length === 1)).toBe(true);
  });
  it('cannot attribute a later page refusal to a blank target', async () => {
    const visited = [];
    const pdfjs = { getDocument: () => ({ promise: Promise.resolve({ numPages: 20,
      getPage: async pageNumber => {
        visited.push(pageNumber);
        if (pageNumber > 10) throw Object.assign(new Error('Later-page refusal.'), { code: record.expectedCode });
        return {};
      } }), destroy: vi.fn() }) };
    const reader = async function* (document, { startPage }) {
      for (let pageNumber = startPage; pageNumber <= document.numPages; pageNumber++) await document.getPage(pageNumber);
    };
    const result = await routingReader(reader)(new Uint8Array([1]), record, pdfjs);
    expect(result.passed).toBe(false);
    expect(result.probes[0]).toMatchObject({ returnedOutput: true, targetObserved: false, code: null, sourcePageCount: 20, lastAllowedPage: 10 });
    expect(result.probes[1].code).toBe(record.expectedCode);
    expect(visited.filter(page => page > 10)).toEqual([11]); // Context retains the real document; target-only never reaches11.
  });
});

const acceptance = process.env.PN_PDF_LIBRARY_ACCEPTANCE === '1' ? it : it.skip;
acceptance('measures all100 library/authored pages under the unchanged automatic gates', async () => {
  const report = await runPdfAcceptance({ benchmark: 'library-v1', writeReport: true,
    outputFile: process.env.PN_PDF_LIBRARY_ACCEPTANCE_OUTPUT });
  expect(report.benchmarkId).toBe('private-library-v1-20261024');
  expect(report.pages).toHaveLength(100); expect(report.goldEvidence.privateRecords).toBe(90);
  expect(report.nativeRoutingControls).toHaveLength(2);
  expect(report.nativeRoutingControlCounts).toEqual({ expected: 2, evaluated: 2, passed: 2 });
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  if (report.naturalness.status === 'waived') {
    expect(releaseGateWaiver('human-listening-reviews', version)).not.toBeNull();
    expect(report.naturalness).toMatchObject({ verified: false, average: null });
  } else {
    expect(report.naturalness.passages).toBe(50);
    expect(report.naturalness.average).toBeGreaterThanOrEqual(4);
  }
  expect(report.passed, JSON.stringify(report.failureDetails)).toBe(true);
}, 10 * 60_000);
