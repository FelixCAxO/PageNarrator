import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { HISTORICAL_PDF_GOLD_SHA256 } from '../helpers/pdf-benchmark-gold.js';
import { assertCurrentPdfCorpusControl, readPdfCorpusImplementationPins } from '../../scripts/lib/pdf-corpus-control-integrity.mjs';

// Original public100 identities; all result text/measurements below are authored unit data.
// No private excerpts, PDF source, corpus report, model or browser is read/executed.
const hash = character => character.repeat(64);
function arrangement() {
  const goldEvidence = { path: 'explicit-private-gold.json', bytes: 81070, sha256: HISTORICAL_PDF_GOLD_SHA256,
    historicalManifestSha256: 'fac19a254f0e507ddf677159397a1e9a0283311c3a26a37d7f33d42c62a27d83', historicalRealPaperRecords: 90 };
  const implementationPins = [
    { path: 'native/pdf.wasm', bytes: 1234, sha256: hash('a') },
    { path: 'src/lib/pdf-page-model.js', bytes: 123, sha256: hash('b') },
    { path: 'src/lib/pdf-vertical-model.js', bytes: 122, sha256: hash('c') },
    { path: 'src/pdf/browser-pdf.js', bytes: 121, sha256: hash('d') },
  ];
  const own = { schemaVersion: 1, controlIntegrityVersion: 1, backend: 'original', total: 100, parsed: 100,
    sourceSha256: hash('e'), wasmSha256: hash('a'), implementationPinsUnchanged: true,
    implementationPins: structuredClone(implementationPins), goldEvidence: structuredClone(goldEvidence),
    records: PDF_ACCEPTANCE_BENCHMARK.map(record => ({ id: record.id, source: record.source, pageNumber: record.pageNumber,
      categories: [...record.categories], sha256: record.sha256, status: 'parsed', text: 'Authored control.', speech: 'Authored control.',
      items: 2, readingOrder: true, narrationErrors: 0, unmappedGlyphs: 0, recognizedSymbolGlyphs: 0 })),
    readingOrderPassed: 100, narrationClean: 100, recognizedSymbolGlyphs: 0, failures: {} };
  return { own, expected: { records: PDF_ACCEPTANCE_BENCHMARK, goldEvidence, implementationPins,
    sourceSha256: hash('e'), wasmSha256: hash('a') } };
}
function rejects(change, message) {
  const { own, expected } = arrangement(); change(own, expected);
  expect(() => assertCurrentPdfCorpusControl(own, expected)).toThrow(message);
}

describe('current paired PDF control admission before candidate filtering', () => {
  it('admits the exact original100 source/page/order identities and current pins', () => {
    const { own, expected } = arrangement(), before = structuredClone(own);
    const result = assertCurrentPdfCorpusControl(own, expected);
    expect(result).toEqual({ records: 100, currentImplementationPins: 4, sourceSha256: hash('e'), wasmSha256: hash('a'),
      pageModelSha256: hash('b'), goldSha256: HISTORICAL_PDF_GOLD_SHA256 });
    expect(own).toEqual(before); expect(Object.isFrozen(result)).toBe(true);
  });
  it('rejects empty records despite old numeric100/100 totals', () => rejects(own => { own.records = []; }, /complete parsed100/));
  it('rejects missing complete set and old producer contract', () => {
    rejects(own => { delete own.records; }, /complete parsed100/);
    rejects(own => { delete own.controlIntegrityVersion; }, /complete parsed100/);
  });
  it('rejects a duplicate at the same100 length', () => rejects(own => { own.records[1] = structuredClone(own.records[0]); }, /duplicate/));
  it('rejects reordered original identities', () => rejects(own => { [own.records[0], own.records[1]] = [own.records[1], own.records[0]]; }, /identity\/order/));
  it.each(['id', 'source', 'pageNumber', 'categories'])('rejects missing identity field %s', key => {
    rejects(own => { delete own.records[0][key]; }, /identity\/order/);
  });
  it('rejects a different PDF digest or page', () => {
    rejects(own => { own.records[0].sha256 = hash('f'); }, /digest\/status/);
    rejects(own => { own.records[0].pageNumber++; }, /identity\/order/);
  });
  it('rejects a failed status hidden behind parsed100', () => rejects(own => { own.records[0].status = 'failed'; }, /digest\/status/));
  it('rejects contradictory parse-failure summaries', () => {
    rejects(own => { delete own.failures; }, /parse-failure summary/);
    rejects(own => { own.failures = { 'old parse failure': 1 }; }, /parse-failure summary/);
  });
  it('rejects malformed result metrics and summary counts', () => {
    rejects(own => { own.records[0].unmappedGlyphs = -1; }, /result fields/);
    rejects(own => { delete own.records[0].readingOrder; }, /result fields/);
    rejects(own => { own.readingOrderPassed = 99; }, /summary counts/);
  });
  it('preserves actual failures instead of requiring all quality flags to pass', () => {
    const { own, expected } = arrangement(); own.records[0].readingOrder = false; own.records[1].narrationErrors = 1;
    own.records[2].unmappedGlyphs = 1; own.records[3].recognizedSymbolGlyphs = 2;
    own.readingOrderPassed = 98; own.narrationClean = 98; own.recognizedSymbolGlyphs = 2;
    expect(assertCurrentPdfCorpusControl(own, expected).records).toBe(100);
    expect(own.records[0].readingOrder).toBe(false); expect(own.records[1].narrationErrors).toBe(1);
  });
  it.each(['sourceSha256', 'wasmSha256'])('rejects stale or missing current digest %s', key => {
    rejects(own => { own[key] = hash('f'); }, /source\/WASM/);
    rejects(own => { delete own[key]; }, /source\/WASM/);
  });
  it('rejects a missing, incomplete or reordered full implementation pin array', () => {
    rejects(own => { delete own.implementationPins; }, /pin set/);
    rejects(own => { own.implementationPins.pop(); }, /pin set/);
    rejects(own => { own.implementationPins.reverse(); }, /implementation pin differs/);
    rejects(own => { own.implementationPinsUnchanged = false; }, /pin set/);
  });
  it('rejects stale page-model, runtime module and native bytes independently', () => {
    for (const index of [0, 1, 2, 3]) rejects(own => { own.implementationPins[index].sha256 = hash('f'); }, /implementation pin differs/);
    rejects(own => { own.implementationPins[0].bytes++; }, /implementation pin differs/);
  });
  it('rejects a native source-only edit while source-digest, WASM and build metadata stay unchanged', async () => {
    const pins = await readPdfCorpusImplementationPins(fileURLToPath(new URL('../../', import.meta.url)));
    // Input identities come from build-native-pdf.mjs; read-only collection, no build/PDF work.
    const nativeInputs = [
      'native/pdf.cpp', 'native/pdf-type1.cpp', 'native/pdf-codecs.cpp', 'native/pdf-fax.cpp',
      'native/pdf-jbig2.cpp', 'native/pdf-mq.h', 'native/pdf-crypto.cpp', 'native/pdf-crypto.h', 'native/pdf-jpx.cpp',
      'native/pdf-inline.cpp',
      'native/pdf-cff-path.cpp',
      'native/pdf-ttf-path.cpp',
    ];
    for (const source of nativeInputs) {
      expect(pins.some(pin => pin.path === source), source).toBe(true);
      const { own, expected } = arrangement();
      own.implementationPins = structuredClone(pins); expected.implementationPins = structuredClone(pins);
      const wasm = pins.find(pin => pin.path === 'native/pdf.wasm').sha256;
      own.wasmSha256 = expected.wasmSha256 = wasm;
      expect(assertCurrentPdfCorpusControl(own, expected).records).toBe(100);
      const changedSource = expected.implementationPins.find(pin => pin.path === source);
      changedSource.sha256 = changedSource.sha256[0] === 'f' ? hash('e') : hash('f');
      for (const unchanged of ['native/pdf.wasm', 'native/pdf.json']) {
        expect(expected.implementationPins.find(pin => pin.path === unchanged)).toEqual(own.implementationPins.find(pin => pin.path === unchanged));
      }
      expect(own.sourceSha256).toBe(expected.sourceSha256);
      expect(() => assertCurrentPdfCorpusControl(own, expected)).toThrow(/current implementation pin differs/);
    }
  });
  it('requires the page-model and native WASM pins even with equal arrays', () => {
    rejects((own, expected) => { expected.implementationPins.splice(1, 1); own.implementationPins.splice(1, 1); }, /required page-model/);
    rejects((own, expected) => { expected.implementationPins[0].sha256 = hash('c'); own.implementationPins[0].sha256 = hash('c'); }, /WASM pin absent/);
  });
  it('rejects missing historical gold instead of upgrading old results', () => {
    rejects(own => { delete own.goldEvidence; }, /gold evidence missing/);
    rejects(own => { own.goldEvidence.path = ''; }, /gold evidence missing/);
  });
  it.each(['bytes', 'sha256', 'historicalManifestSha256', 'historicalRealPaperRecords'])('rejects drifted or missing gold %s', key => {
    rejects(own => { own.goldEvidence[key] = 'drifted'; }, /gold evidence differs/);
    rejects(own => { delete own.goldEvidence[key]; }, /gold evidence differs/);
  });
  it('allows a different explicit private file location with identical content evidence', () => {
    const { own, expected } = arrangement(); own.goldEvidence.path = 'another-machine-private-gold.json';
    expect(assertCurrentPdfCorpusControl(own, expected).goldSha256).toBe(HISTORICAL_PDF_GOLD_SHA256);
  });
});
