// Authored unit metadata only; no private book text or candidate-derived gold.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPdfLibraryBenchmarkGold } from '../helpers/pdf-library-benchmark-gold.js';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { publicPdfLibraryManifest } from '../../scripts/lib/pdf-library-public-manifest.mjs';

const folders = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pn-library-gold-')); folders.push(directory);
  const input = path.join(directory, 'owned-input.pdf'), reference = path.join(directory, 'reference.json');
  writeFileSync(input, 'Original synthetic source identity only.');
  writeFileSync(reference, '{"originalReference":true}');
  const sourceHash = hash(readFileSync(input));
  const records = Array.from({ length: 90 }, (_, index) => ({ id: `library-unit-${index + 1}`,
    source: `private-library:${sourceHash}`, sha256: sourceHash, pageNumber: index + 1,
    narrationStartPage: Math.max(1, index - 2), categories: ['library', 'ltr'] }));
  const gold = { schemaVersion: 1, benchmarkId: 'private-library-v1-20261024', sourceInventorySha256: 'a'.repeat(64),
    sourceRoot: directory, referenceMethod: 'Original authored unit controls; not library-quality evidence.',
    records: records.map(record => ({ ...record, privateFilePath: input,
      orderedCheckpoints: [`Beginning authored section ${record.id}`, `Middle authored section ${record.id}`, `Ending authored section ${record.id}`],
      forbiddenNarration: [], referencePins: [{ path: 'reference.json', bytes: readFileSync(reference).length, sha256: hash(readFileSync(reference)) }] })) };
  const manifest = { schemaVersion: 1, benchmarkId: gold.benchmarkId, sourceInventorySha256: gold.sourceInventorySha256, records };
  const goldPath = path.join(directory, 'gold.json'), manifestPath = path.join(directory, 'manifest.json');
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(gold)); writeFileSync(goldPath, bytes);
    manifest.gold = { bytes: bytes.length, sha256: hash(bytes) };
    const privateBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(path.join(directory, 'manifest.private.json'), privateBytes);
    writeFileSync(manifestPath, JSON.stringify(publicPdfLibraryManifest(privateBytes)));
  };
  save();
  return { directory, input, reference, records, gold, manifest, goldPath, manifestPath, save,
    load: () => loadPdfLibraryBenchmarkGold({ goldPath, manifestPath }) };
}

function addRouting(f) {
  f.manifest.routingControls = ['scanned_pdf_unsupported', 'pdf_corrupt'].map((expectedCode, index) => ({
    id: `library-routing-unit-${index + 1}`, source: f.records[0].source, sha256: f.records[0].sha256,
    pageNumber: index + 91, narrationStartPage: index + 88, categories: ['native-routing-control'], expectedCode,
  }));
  f.gold.routingControls = f.manifest.routingControls.map(record => ({ ...record, privateFilePath: f.input,
    referencePins: [{ ...f.gold.records[0].referencePins[0] }] }));
  f.save();
}
afterEach(() => {
  for (const directory of folders.splice(0)) {
    const relative = path.relative(realpathSync(tmpdir()), realpathSync(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe unit cleanup path.');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('new independent private-library benchmark gold', () => {
  it('publishes random opaque IDs while keeping hashes, page numbers and gold unchanged locally', () => {
    const f = fixture(), before = readFileSync(f.goldPath);
    const manifest = JSON.parse(readFileSync(f.manifestPath));
    expect(manifest.schemaVersion).toBe(2);
    for (const row of manifest.records) {
      expect(Object.keys(row).sort()).toEqual(['categories', 'id']);
      expect(row.id).not.toContain(f.records[0].sha256.slice(0, 16));
    }
    expect(f.load().records[0].id).toBe(manifest.records[0].id);
    expect(readFileSync(f.goldPath).equals(before)).toBe(true);
    writeFileSync(path.join(f.directory, 'manifest.private.json'), '{}');
    expect(f.load).toThrow('private manifest pin drifted');
  });
  it('rejects leaked metadata, duplicate opaque IDs and a changed public roster', () => {
    const f = fixture();
    for (const mutate of [m => { m.records[0].sha256 = f.records[0].sha256; },
      m => { m.records[0].pageNumber = 1; }, m => { m.records[1].id = m.records[0].id; },
      m => { m.records[0].categories = ['changed']; }]) {
      f.save(); const manifest = JSON.parse(readFileSync(f.manifestPath)); mutate(manifest);
      writeFileSync(f.manifestPath, JSON.stringify(manifest)); expect(f.load).toThrow('public opaque page identity');
    }
  });
  it('combines90 pinned private pages with the exact10 unchanged authored fixture objects', () => {
    const f = fixture(), result = f.load();
    expect(result.records).toHaveLength(100);
    expect(result.records.slice(90)).toEqual(PDF_ACCEPTANCE_BENCHMARK.filter(record => !record.goldData));
    for (const [index, record] of result.records.slice(90).entries()) {
      expect(record).toBe(PDF_ACCEPTANCE_BENCHMARK.filter(row => !row.goldData)[index]);
    }
    expect(result.goldEvidence).toMatchObject({ kind: 'independent-private-library-v1', privateRecords: 90, generatedRecords: 10 });
    expect(result.goldEvidence.independentReferencePins).toHaveLength(1);
    expect(result.records[0].source).toBe(`private-library:${result.records[0].id}`);
    expect(result.records[0].privateFilePath).toBe(realpathSync(f.input));
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0].orderedCheckpoints)).toBe(true);
    expect(result.routingControls).toEqual([]);
    expect(Object.isFrozen(result.routingControls)).toBe(true);
  });
  it('rejects missing, empty and same-size changed gold instead of restoring historical data', () => {
    const f = fixture();
    expect(() => loadPdfLibraryBenchmarkGold({ goldPath: '', manifestPath: f.manifestPath })).toThrow('path is empty');
    const bytes = readFileSync(f.goldPath); bytes[bytes.length - 2] ^= 1; writeFileSync(f.goldPath, bytes);
    expect(f.load).toThrow('SHA-256 drifted');
    expect(() => loadPdfLibraryBenchmarkGold({ goldPath: path.join(f.directory, 'missing.json'), manifestPath: f.manifestPath })).toThrow(/ENOENT/u);
  });
  it.each([
    ['wrong source hash', f => { f.gold.records[0].sha256 = 'b'.repeat(64); }],
    ['reordered pages', f => { [f.gold.records[0], f.gold.records[1]] = [f.gold.records[1], f.gold.records[0]]; }],
    ['wrong context', f => { f.gold.records[5].narrationStartPage = 1; }],
    ['two checkpoints', f => { f.gold.records[0].orderedCheckpoints.pop(); }],
    ['empty checkpoint', f => { f.gold.records[0].orderedCheckpoints[1] = ' '; }],
    ['duplicate checkpoint', f => { f.gold.records[0].orderedCheckpoints[1] = f.gold.records[0].orderedCheckpoints[0]; }],
    ['missing reference', f => { f.gold.records[0].referencePins = []; }],
    ['wrong benchmark version', f => { f.gold.benchmarkId = 'historical-v1'; }],
  ])('rejects independently pinned but malformed metadata: %s', (_name, mutate) => {
    const f = fixture(); mutate(f); f.save(); expect(f.load).toThrow('Invalid independent PDF library gold');
  });
  it('rejects reference byte drift and conflicting aliases', () => {
    const f = fixture(); writeFileSync(f.reference, 'changed'); expect(f.load).toThrow('reference bytes drifted');
    writeFileSync(f.reference, '{"originalReference":true}');
    f.gold.records[1].referencePins[0].sha256 = 'b'.repeat(64); f.save(); expect(f.load).toThrow('conflicting reference pins');
  });
  it('rejects private sources outside the frozen root and duplicate source pages', () => {
    const f = fixture(), outside = mkdtempSync(path.join(tmpdir(), 'pn-library-gold-')); folders.push(outside);
    const other = path.join(outside, 'other.pdf'); writeFileSync(other, 'owned outside-root unit control');
    f.gold.records[0].privateFilePath = other; f.save(); expect(f.load).toThrow('outside the frozen private root');
    f.gold.records[0].privateFilePath = f.input;
    f.records[1].pageNumber = f.records[0].pageNumber;
    f.records[1].narrationStartPage = f.records[0].narrationStartPage;
    f.gold.records[1] = { ...f.gold.records[1], ...f.records[1] }; f.save(); expect(f.load).toThrow('duplicate source page');
  });
  it('does not accept historical-size or unbounded files as the new schema', () => {
    const f = fixture(); f.manifest.gold.bytes = 9 * 1024 * 1024;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); expect(f.load).toThrow('public identity/count/pin contract');
  });
  it('keeps private paths and excerpt fields out of public source records', () => {
    const f = fixture();
    f.records[0].privateFilePath = f.input; f.save(); expect(f.load).toThrow('public page identity');
    delete f.records[0].privateFilePath;
    f.records[0].orderedCheckpoints = ['Original unit excerpt']; f.save(); expect(f.load).toThrow('public page identity');
  });
  it('keeps the two pinned native refusal controls outside the100 positive pages', () => {
    const f = fixture(); addRouting(f);
    const result = f.load();
    expect(result.records).toHaveLength(100);
    expect(result.routingControls).toHaveLength(2);
    expect(result.routingControls.map(row => row.expectedCode)).toEqual(['scanned_pdf_unsupported', 'pdf_corrupt']);
    expect(result.routingControls[0]).toMatchObject({ narrationStartPage: 88, privateFilePath: realpathSync(f.input) });
    expect(result.routingControls[0]).not.toHaveProperty('orderedCheckpoints');
    expect(result.goldEvidence.routingControls).toBe(2);
    expect(Object.isFrozen(result.routingControls[0])).toBe(true);
  });
  it.each([
    ['public count', f => { f.manifest.routingControls.pop(); }],
    ['private count', f => { f.gold.routingControls.pop(); }],
    ['swapped private codes', f => { f.gold.routingControls[0].expectedCode = 'pdf_corrupt'; }],
    ['unknown code', f => { f.manifest.routingControls[0].expectedCode = f.gold.routingControls[0].expectedCode = 'pdf_unsupported'; }],
    ['positive categories', f => { f.manifest.routingControls[0].categories = f.gold.routingControls[0].categories = ['library']; }],
    ['missing context', f => { delete f.manifest.routingControls[0].narrationStartPage; delete f.gold.routingControls[0].narrationStartPage; }],
    ['missing reference', f => { f.gold.routingControls[0].referencePins = []; }],
    ['duplicate positive page', f => { Object.assign(f.manifest.routingControls[0], { pageNumber: 1, narrationStartPage: 1 }); Object.assign(f.gold.routingControls[0], f.manifest.routingControls[0]); }],
    ['private public location', f => { f.manifest.routingControls[0].privateFilePath = f.input; }],
  ])('rejects native-routing identity/contract drift: %s', (_name, mutate) => {
    const f = fixture(); addRouting(f); mutate(f); f.save();
    expect(f.load).toThrow('Invalid independent PDF library gold');
  });
  it('validates routing-only references and source containment with the same safeguards', () => {
    const f = fixture(); addRouting(f);
    const reference = path.join(f.directory, 'routing-reference.json');
    writeFileSync(reference, '{"originalRoutingReference":true}');
    f.gold.routingControls[0].referencePins = [{ path: 'routing-reference.json', bytes: readFileSync(reference).length,
      sha256: hash(readFileSync(reference)) }]; f.save();
    expect(f.load().goldEvidence.independentReferencePins).toHaveLength(2);
    writeFileSync(reference, 'changed'); expect(f.load).toThrow('reference bytes drifted');
    f.gold.routingControls[0].referencePins = f.gold.routingControls[1].referencePins;
    const outside = mkdtempSync(path.join(tmpdir(), 'pn-library-gold-')); folders.push(outside);
    const other = path.join(outside, 'other.pdf'); writeFileSync(other, 'Original outside-root routing control.');
    f.gold.routingControls[0].privateFilePath = other; f.save();
    expect(f.load).toThrow('outside the frozen private root');
  });
});
