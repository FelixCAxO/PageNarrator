import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { PDF_NATURALNESS_SAMPLE } from '../fixtures/pdf-naturalness-sample.js';
import { combinePdfNaturalnessReviews, createPdfNaturalnessReviewHtml, runPdfNaturalnessReviewCommand } from '../../scripts/pdf-naturalness-reviews.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const packet = { backend: 'original', rubric: 'Test rubric', passages: PDF_NATURALNESS_SAMPLE.map(sample => {
  const transcript = `Test-only passage ${sample.id}: <script>alert('untrusted')</script> & punctuation.`;
  return { passageId: sample.id, transcript, transcriptSha256: hash(transcript), categories: [...sample.categories] };
}) };
const packetBytes = JSON.stringify(packet);
const packetSha256 = hash(packetBytes);
const response = (reviewerId, rating = 4) => ({ schemaVersion: 1, kind: 'human', blindedIndependentHumanReview: true,
  reviewerId, reviewedAt: '2026-10-22T13:00:00.000Z', packetSha256,
  passages: packet.passages.map(({ passageId, transcriptSha256 }) => ({ passageId, transcriptSha256, rating })) });
const combine = (responses, existingRatings = []) => combinePdfNaturalnessReviews(packet, responses, { packetSha256, existingRatings });
const folders = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('blind PDF human review collection', () => {
  it('combines independent original responses and derives the unchanged panel medians', () => {
    const first = response('test-reviewer-a'), second = response('test-reviewer-b', 5);
    const original = JSON.stringify([first, second]);
    const rows = combine([first, second]);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ passageId: packet.passages[0].passageId, transcriptSha256: packet.passages[0].transcriptSha256,
      ratings: [4, 5], reviews: [first, second].map(value => ({ kind: 'human', reviewerId: value.reviewerId,
        reviewedAt: value.reviewedAt, transcriptSha256: packet.passages[0].transcriptSha256 })),
      categories: packet.passages[0].categories, median: 4.5 });
    expect(JSON.stringify([first, second])).toBe(original);
  });

  it('requires a third independent review only for actual disagreements', () => {
    const first = response('test-reviewer-a'), second = response('test-reviewer-b');
    second.passages[0].rating = 1;
    expect(() => combine([first, second])).toThrow(/third independent human.*naturalness-01/u);
    const third = response('test-reviewer-c', 2);
    third.passages = third.passages.slice(0, 1);
    expect(combine([first, second, third])[0].median).toBe(2);
    third.passages.push({ ...third.passages[0], ...response('test-reviewer-c').passages[1] });
    expect(() => combine([first, second, third])).toThrow(/unexpected adjudication/u);
  });

  it('merges completed existing panels without replacing or duplicating them', () => {
    const first = response('test-reviewer-a'), second = response('test-reviewer-b');
    const existing = combine([first, second]).slice(0, 25);
    first.passages = first.passages.slice(25);
    second.passages = second.passages.slice(25);
    expect(combine([first, second], existing)).toHaveLength(50);
    expect(() => combine([response('test-reviewer-a')], existing)).toThrow(/Duplicate or conflicting reviewer/u);
    expect(() => combine([first, second], [...existing, existing[0]])).toThrow(/duplicate, unknown or stale/u);
    expect(() => combine([first, second], [{ ...existing[0], median: 1 }])).toThrow(/invalid median/u);
  });

  it('rejects missing human attestations, shared reviewers, invalid dates and modified transcripts', () => {
    const changes = [
      { kind: 'model' }, { blindedIndependentHumanReview: false }, { reviewerId: '' }, { packetSha256: '0'.repeat(64) },
    ];
    for (const change of changes) expect(() => combine([{ ...response('test-reviewer-a'), ...change }])).toThrow(/independent blinded human/u);
    expect(() => combine([response('test-reviewer-a'), response(' TEST-reviewer-A ')])).toThrow(/Duplicate or conflicting reviewer/u);
    expect(() => combine([{ ...response('test-reviewer-a'), reviewedAt: '2026-10-22' }])).toThrow(/UTC review dates/u);
    const stale = response('test-reviewer-a');
    stale.passages[0].transcriptSha256 = '0'.repeat(64);
    expect(() => combine([stale])).toThrow(/stale or invalid/u);
    const duplicate = response('test-reviewer-a');
    duplicate.passages.push(duplicate.passages[0]);
    expect(() => combine([duplicate])).toThrow(/duplicate, unknown/u);
    const invalid = response('test-reviewer-a');
    invalid.passages[0].rating = 6;
    expect(() => combine([invalid])).toThrow(/invalid passage/u);
    expect(() => combine([response('test-reviewer-a')])).toThrow(/Missing independent review panels/u);
  });

  it('binds the portable form to exact text and exports only scores a human supplied', () => {
    const html = createPdfNaturalnessReviewHtml(packet, packetSha256);
    expect(html).toContain(`<p>${packet.rubric}</p>`);
    expect(html).not.toContain("<script>alert('untrusted')</script>");
    expect(html).not.toContain('columns');
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    try {
      const { document } = dom.window;
      const form = document.getElementById('review');
      const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      submit();
      expect(document.getElementById('status').textContent).toContain('score at least one');
      document.getElementById('reviewer').value = 'human test export';
      document.getElementById('human').checked = true;
      document.getElementById('score-0').value = '3';
      let exported;
      dom.window.Blob = class { constructor(parts) { exported = parts.join(''); } };
      dom.window.URL.createObjectURL = () => 'blob:test';
      dom.window.URL.revokeObjectURL = () => {};
      dom.window.HTMLAnchorElement.prototype.click = function () {};
      submit();
      expect(JSON.parse(exported)).toEqual({ schemaVersion: 1, kind: 'human', blindedIndependentHumanReview: true,
        reviewerId: 'human test export', reviewedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u), packetSha256,
        passages: [{ passageId: packet.passages[0].passageId, transcriptSha256: packet.passages[0].transcriptSha256, rating: 3 }] });
    } finally { dom.window.close(); }
  });

  it('rejects packet drift before generating a form', () => {
    const changed = structuredClone(packet);
    changed.passages[0].transcript += 'changed';
    expect(() => createPdfNaturalnessReviewHtml(changed, packetSha256)).toThrow(/transcript hash/u);
    expect(() => createPdfNaturalnessReviewHtml({ ...packet, backend: 'oracle' }, packetSha256)).toThrow(/original-backend/u);
    expect(() => createPdfNaturalnessReviewHtml({ ...packet, rubric: '' }, packetSha256)).toThrow(/original-backend/u);
    expect(createPdfNaturalnessReviewHtml({ ...packet, rubric: '<script>untrusted rubric</script>' }, packetSha256))
      .toContain('&lt;script&gt;untrusted rubric&lt;/script&gt;');
    expect(() => createPdfNaturalnessReviewHtml(packet, 'bad-hash')).toThrow(/exact packet SHA-256/u);
  });

  it('writes new ratings plus source-hash provenance and refuses to overwrite either file', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'pagenarrator-human-review-test-'));
    folders.push(folder);
    const packetFile = path.join(folder, 'packet.json'), first = path.join(folder, 'first.json'), second = path.join(folder, 'second.json');
    const output = path.join(folder, 'ratings.json');
    writeFileSync(packetFile, packetBytes);
    writeFileSync(first, JSON.stringify(response('test-reviewer-a')));
    writeFileSync(second, JSON.stringify(response('test-reviewer-b')));
    const args = ['--packet', packetFile, '--review', first, '--review', second, '--output', output];
    await runPdfNaturalnessReviewCommand(args);
    const original = readFileSync(output);
    const receipt = JSON.parse(readFileSync(`${output}.provenance.json`, 'utf8'));
    expect(receipt.packet.sha256).toBe(packetSha256);
    expect(receipt.responses[0].sha256).toBe(hash(readFileSync(first)));
    expect(receipt.ratings.sha256).toBe(hash(original));
    await expect(runPdfNaturalnessReviewCommand(args)).rejects.toThrow(/Refusing to overwrite/u);
    expect(readFileSync(output)).toEqual(original);
    const otherOutput = path.join(folder, 'other.json');
    writeFileSync(`${otherOutput}.provenance.json`, 'existing receipt');
    await expect(runPdfNaturalnessReviewCommand([...args.slice(0, -1), otherOutput])).rejects.toThrow(/Refusing to overwrite/u);
    expect(readFileSync(`${otherOutput}.provenance.json`, 'utf8')).toBe('existing receipt');
    const htmlFile = path.join(folder, 'review.html');
    await runPdfNaturalnessReviewCommand(['--packet', packetFile, '--html', htmlFile]);
    await expect(runPdfNaturalnessReviewCommand(['--packet', packetFile, '--html', htmlFile])).rejects.toThrow(/EEXIST/u);
  });

  it('refuses ambiguous or incomplete CLI options', async () => {
    for (const args of [[], ['--packet', 'x', '--html', 'x', '--output', 'x'], ['--packet', 'x', '--html', 'x', '--review', 'x'], ['--packet', 'x', '--output', 'x']]) {
      await expect(runPdfNaturalnessReviewCommand(args)).rejects.toThrow(/Use --packet/u);
    }
    await expect(runPdfNaturalnessReviewCommand(['--packet', '--html', 'x'])).rejects.toThrow();
  });
});
