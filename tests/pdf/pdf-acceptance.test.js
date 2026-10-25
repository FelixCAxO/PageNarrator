import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPdfBenchmarkGold } from '../helpers/pdf-benchmark-gold.js';
import { runPdfAcceptance, validateNaturalnessRatings } from '../../scripts/run-pdf-acceptance.mjs';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { PDF_NATURALNESS_SAMPLE } from '../fixtures/pdf-naturalness-sample.js';

const enabled = process.env.PN_PDF_ACCEPTANCE === '1';
const acceptanceIt = enabled ? it : it.skip;
const naturalnessRatings = JSON.parse(readFileSync(
  new URL('../fixtures/pdf-naturalness-ratings.json', import.meta.url),
  'utf8',
));

describe('fixed PDF definition-of-done benchmark', () => {
  it('freezes exactly 100 readable pages and 50 passages with required category coverage', () => {
    expect(PDF_ACCEPTANCE_BENCHMARK).toHaveLength(100);
    expect(PDF_NATURALNESS_SAMPLE).toHaveLength(50);
    expect(new Set(PDF_ACCEPTANCE_BENCHMARK.map((record) => record.id)).size).toBe(100);
    expect(new Set(PDF_NATURALNESS_SAMPLE.map((record) => record.pdfId)).size).toBe(50);

    const real = PDF_ACCEPTANCE_BENCHMARK.filter(record => record.goldData);
    const generated = PDF_ACCEPTANCE_BENCHMARK.filter(record => !record.goldData);
    expect(real).toHaveLength(90);
    expect(generated).toHaveLength(10);
    for (const record of PDF_ACCEPTANCE_BENCHMARK) {
      expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.categories)).toBe(true);
      if (record.goldData) {
        expect(Object.keys(record).sort()).toEqual(['attribution', 'categories', 'goldData', 'id', 'pageNumber', 'sha256', 'source']);
        expect(record.goldData).toBe('explicit-private-historical-benchmark');
        expect(record.attribution.versionedRecordUrl).toBe(`https://arxiv.org/abs/${record.id}`);
        expect(Object.isFrozen(record.attribution)).toBe(true);
        expect(record).not.toHaveProperty('orderedCheckpoints');
        expect(record).not.toHaveProperty('forbiddenNarration');
      } else {
        expect(Object.keys(record).sort()).toEqual(['categories', 'forbiddenNarration', 'id', 'orderedCheckpoints', 'pageNumber', 'sha256', 'source']);
        expect(record.orderedCheckpoints.length).toBeGreaterThanOrEqual(3);
        expect(record.orderedCheckpoints.length).toBeLessThanOrEqual(6);
        expect(Object.isFrozen(record.orderedCheckpoints)).toBe(true);
      }
    }

    const categories = new Set(PDF_ACCEPTANCE_BENCHMARK.flatMap((record) => record.categories));
    for (const required of ['title', 'columns', 'ltr', 'rtl', 'list', 'table', 'caption']) {
      expect(categories.has(required), required).toBe(true);
    }

    // Human reviews may be collected incrementally; strict acceptance still requires all50.
    expect(Array.isArray(naturalnessRatings)).toBe(true);
    expect(naturalnessRatings.length).toBeLessThanOrEqual(50);
    expect(new Set(naturalnessRatings.map(record => record.passageId)).size).toBe(naturalnessRatings.length);
    for (const rating of naturalnessRatings) {
      expect(Object.keys(rating).sort()).toEqual([
        'categories',
        'median',
        'passageId',
        'ratings',
        'reviews',
        'transcriptSha256',
      ]);
      expect(rating.transcriptSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(rating.ratings.length).toBeGreaterThanOrEqual(2);
      expect(rating.ratings.every((value) => Number.isInteger(value) && value >= 1 && value <= 5)).toBe(true);
      const sample = PDF_NATURALNESS_SAMPLE.find(record => record.id === rating.passageId);
      expect(sample).toBeDefined();
      expect(() => validateNaturalnessRatings([rating], [sample])).not.toThrow();
    }
  });

  acceptanceIt('meets every PDF definition-of-done threshold', async () => {
    const report = await runPdfAcceptance({ benchmark: 'historical-v1' });
    expect(report.candidate).toMatch(/^[0-9a-f]{7,40}$/u);
    expect(report.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.categoryCounts).toEqual(expect.objectContaining({
      title: expect.any(Number),
      columns: expect.any(Number),
      ltr: expect.any(Number),
      rtl: expect.any(Number),
      list: expect.any(Number),
      table: expect.any(Number),
      caption: expect.any(Number),
    }));
    expect(report.pages).toHaveLength(100);
    for (const page of report.pages) {
      expect(page.source).toEqual(expect.any(String));
      expect(page.source.length).toBeGreaterThan(0);
      expect(page.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(page.pageNumber).toBeGreaterThanOrEqual(1);
      expect(page.categories).toEqual(expect.any(Array));
      expect(page.categories.length).toBeGreaterThan(0);
    }
    expect(report.naturalnessEvidence).toHaveLength(50);
    for (const passage of report.naturalnessEvidence) {
      expect(passage.pdfId).toEqual(expect.any(String));
      expect(passage.pageNumber).toEqual(expect.any(Number));
      expect(passage.transcriptSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(Array.isArray(report.failures)).toBe(true);
    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
  }, 10 * 60 * 1000);
});

describe('explicit private historical PDF gold', () => {
  const folders = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  it('requires a private input for the real-paper strict benchmark', () => {
    vi.stubEnv('PN_PDF_BENCHMARK_GOLD', undefined);
    expect(() => loadPdfBenchmarkGold()).toThrow(/Set PN_PDF_BENCHMARK_GOLD/);
  });
  it('keeps generated fixture assertions available without any private input', () => {
    vi.stubEnv('PN_PDF_BENCHMARK_GOLD', undefined);
    const fixture = PDF_ACCEPTANCE_BENCHMARK.find(record => record.id === 'fixture-ltr-two-column');
    const result = loadPdfBenchmarkGold({ requiredIds: [fixture.id] });
    expect(result.records).toBe(PDF_ACCEPTANCE_BENCHMARK);
    expect(result.records.find(record => record.id === fixture.id)).toBe(fixture);
    expect(result.goldEvidence).toBeNull();
  });
  it('does not ignore an explicitly configured missing input even for a generated fixture', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pn-pdf-private-gold-')); folders.push(directory);
    expect(() => loadPdfBenchmarkGold({ goldPath: path.join(directory, 'missing.json'), requiredIds: ['fixture-table'] })).toThrow(/ENOENT/);
  });
  it('rejects same-size drift rather than replacing historical checkpoints', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pn-pdf-private-gold-')); folders.push(directory);
    const file = path.join(directory, 'drifted.json'); writeFileSync(file, Buffer.alloc(81070, 32));
    expect(() => loadPdfBenchmarkGold({ goldPath: file })).toThrow(/SHA-256 drifted/);
  });
  it('rejects empty configuration and unknown requested identities', () => {
    expect(() => loadPdfBenchmarkGold({ goldPath: '' })).toThrow(/must name/);
    expect(() => loadPdfBenchmarkGold({ requiredIds: ['unknown'] })).toThrow(/Unknown historical/);
  });
});
