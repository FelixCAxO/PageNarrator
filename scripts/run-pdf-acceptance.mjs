import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadPdfAcceptanceBackend } from './lib/pdf-acceptance-backend.mjs';
import { readPdfCorpusImplementationPins } from './lib/pdf-corpus-control-integrity.mjs';
import { PDF_ACCEPTANCE_BENCHMARK } from '../tests/fixtures/pdf-acceptance-manifest.js';
import { loadPdfBenchmarkGold } from '../tests/helpers/pdf-benchmark-gold.js';
import { loadPdfLibraryBenchmarkGold } from '../tests/helpers/pdf-library-benchmark-gold.js';
import { releaseGateWaiver } from './lib/release-policy.mjs';
import { PDF_NATURALNESS_SAMPLE } from '../tests/fixtures/pdf-naturalness-sample.js';
import { PDF_LIBRARY_NATURALNESS_SAMPLE } from '../tests/fixtures/pdf-library-naturalness-sample.js';
import {
  createPageHighlighter,
  HIGHLIGHT_WORD_TRAIL,
} from '../src/lib/page-highlighter.js';
import {
  annotatePdfTextLayer,
  configurePdfWorker,
  extractPdfTextFromData,
  iteratePdfSpeechChunks,
} from '../src/lib/pdf-extraction.js';
import { getDomWordIndexForSpeechWord } from '../src/lib/reading-model.js';
import { chunkText } from '../src/lib/speech-chunks.js';
import { tokenizeSpokenWords } from '../src/lib/speech-tokenization.js';
import { createPdfPageModel } from '../src/lib/pdf-page-model.js';
import {
  countNarrationErrors,
  matchesOrderedCheckpoints,
  scorePdfAcceptance,
  validateNaturalnessRatingPanel,
  validateNaturalnessReviews,
} from './pdf-acceptance-metrics.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'pdf-corpus');
const RATINGS_PATH = path.join(ROOT_DIR, 'tests', 'fixtures', 'pdf-naturalness-ratings.json');
const MANIFEST_PATH = path.join(ROOT_DIR, 'tests', 'fixtures', 'pdf-acceptance-manifest.js');
const REPORT_PATH = path.join(ROOT_DIR, 'artifacts', 'pdf-acceptance-original.json');
const execFileAsync = promisify(execFile);
const IMAGE_ONLY_FIXTURES = Object.freeze([
  ['single-raster.pdf', true],
  ['multi-raster.pdf', true],
  ['inline-image.pdf', true],
  ['blank-control.pdf', false],
  ['vector-control.pdf', false],
]);

export async function resolvePdfAcceptanceCandidate({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const supplied = {};
  for (const name of ['PN_CANDIDATE_ID', 'GITHUB_SHA']) {
    if (env[name] === undefined) continue;
    if (typeof env[name] !== 'string' || !/^[a-f0-9]{40}$/iu.test(env[name].trim())) throw new Error(`Invalid PDF acceptance candidate ID: ${name}.`);
    supplied[name] = env[name].trim().toLowerCase();
  }
  const ids = [...new Set(Object.values(supplied))];
  if (ids.length > 1) throw new Error('Conflicting PDF acceptance candidate IDs.');
  let head, gitRoot, unavailable, excludedAncestorRepository;
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: rootDir, env, windowsHide: true });
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (lines.length !== 2 || !/^[a-f0-9]{40}$/iu.test(lines[1])) throw new Error('Invalid PDF acceptance Git identity.');
    gitRoot = await realpath(lines[0]);
    head = lines[1].toLowerCase();
    if (path.relative(await realpath(rootDir), gitRoot) !== '') {
      excludedAncestorRepository = { root: gitRoot, head };
      unavailable = 'ancestor-repository-excluded'; head = undefined; gitRoot = null;
    }
  } catch (error) {
    if (error.code === 'ENOENT') unavailable = 'git-executable-unavailable';
    else if (error.code === 128 && /not a git repository\b/iu.test(String(error.stderr))) unavailable = 'no-git-repository';
    else throw new Error('Could not verify PDF acceptance Git identity.', { cause: error });
  }
  if (head !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error('Invalid PDF acceptance Git HEAD.');
    if (ids.length && ids[0] !== head) throw new Error('PDF acceptance supplied candidate ID conflicts with Git HEAD.');
    return { commitSha: head, provenance: 'git-verified', gitHead: head, gitRoot, supplied };
  }
  // An immutable archive has no .git marker. Do not hide broken local repository metadata.
  let localGit;
  try { localGit = await lstat(path.join(rootDir, '.git')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (localGit) throw new Error('Could not verify PDF acceptance identity for existing Git metadata.');
  if (!ids.length) throw new Error('PDF acceptance requires Git HEAD or an explicit full candidate ID.');
  return { commitSha: ids[0], provenance: 'externally-supplied-not-git-verified', gitHead: null, gitRoot: null, supplied,
    gitUnavailableReason: unavailable, gitCeilingDirectories: env.GIT_CEILING_DIRECTORIES ?? null,
    ...(excludedAncestorRepository ? { excludedAncestorRepository } : {}) };
}

export async function runPdfAcceptance({ writeReport = false, goldPath,
  benchmark = 'library-v1',
  backend, outputFile = null, reportIncompleteNaturalness = false,
  naturalnessRatingsPath = process.env.PN_PDF_NATURALNESS_RATINGS } = {}) {
  backend ??= process.env.PN_PDF_ACCEPTANCE_BACKEND ?? (benchmark === 'library-v1' ? 'original-browser' : 'original');
  if (!['library-v1', 'historical-v1'].includes(benchmark)) throw new Error('Unknown PDF acceptance benchmark.');
  const candidateIdentity = await resolvePdfAcceptanceCandidate();
  if (typeof reportIncompleteNaturalness !== 'boolean') throw new TypeError('Naturalness reporting option must be boolean.');
  if (benchmark === 'library-v1') return runPdfLibraryAcceptance({ writeReport, goldPath, backend, outputFile, candidateIdentity,
    naturalnessRatingsPath, reportIncompleteNaturalness });
  if (backend === 'original-browser') throw new Error('The browser acceptance backend is available for library-v1. Historical mode retains original and pdfjs-oracle.');
  if (typeof reportIncompleteNaturalness !== 'boolean') throw new TypeError('Naturalness reporting option must be boolean.');
  const { records: benchmarkRecords, goldEvidence } = loadPdfBenchmarkGold({ goldPath });
  const { engine: pdfjs, identity: backendIdentity } = await loadPdfAcceptanceBackend(backend);
  const implementationPins = await readAcceptanceSourcePins(backendIdentity.sourcePins);
  configurePdfWorker(pdfjs);
  const ratingRecords = JSON.parse(await readFile(RATINGS_PATH, 'utf8'));
  let ratingFixtureError = null;
  try { validateNaturalnessRatings(ratingRecords, PDF_NATURALNESS_SAMPLE); }
  catch (error) { if (!reportIncompleteNaturalness) throw error; ratingFixtureError = error.message; }
  const ratingRows = Array.isArray(ratingRecords) ? ratingRecords.filter(record => record && typeof record === 'object') : [];
  const ratingsByPassageId = new Map(ratingRows.map((record) => [record.passageId, record]));
  const evaluatedPages = [];
  const chunks = [];
  const words = [];

  for (const record of benchmarkRecords) {
    const bytes = await loadVerifiedPdf(record);
    const page = await readBenchmarkPage(bytes, record.pageNumber, pdfjs);
    const pageText = await getProductionPageText(bytes, record, page, pdfjs);
    const narration = normalizeText(pageText.speech);
    const checkpointResult = evaluateReadingOrder(pageText, record.orderedCheckpoints);
    const narrationErrors = countNarrationErrors(pageText.speech, record.forbiddenNarration);
    const grounding = evaluateGrounding(record, page, pageText);

    evaluatedPages.push({
      id: record.id,
      source: record.source,
      sourceSha256: record.sha256,
      pageNumber: record.pageNumber,
      categories: [...record.categories],
      readingOrder: checkpointResult.passed,
      narrationErrors,
      failedCheckpoint: checkpointResult.failedCheckpoint,
      transcriptHash: sha256(narration),
      naturalnessTranscriptHash: sha256(selectPdfNaturalnessPassage(pageText.speech)),
    });
    chunks.push(...grounding.chunks);
    words.push(...grounding.words);
  }

  const pagesById = new Map(evaluatedPages.map((page) => [page.id, page]));
  const passages = PDF_NATURALNESS_SAMPLE.map((sample) => {
    const rating = ratingsByPassageId.get(sample.id);
    return {
      id: sample.id,
      transcriptHashMatches: Boolean(
        rating?.transcriptSha256
        && rating.transcriptSha256 === pagesById.get(sample.pdfId)?.naturalnessTranscriptHash
      ),
      ratings: Array.isArray(rating?.ratings) ? rating.ratings : [],
      transcriptSha256: rating?.transcriptSha256 ?? null,
      reviews: Array.isArray(rating?.reviews) ? rating.reviews : [],
      ...(reportIncompleteNaturalness ? {
        currentTranscriptSha256: pagesById.get(sample.pdfId)?.naturalnessTranscriptHash ?? null,
        ratedTranscriptSha256: rating?.transcriptSha256 ?? null,
        ratingRecordCount: ratingRows.filter(record => record.passageId === sample.id).length,
      } : {}),
    };
  });
  const imageOnly = await evaluateImageOnlyFixtures(pdfjs);
  const score = scorePdfAcceptance({ pages: evaluatedPages, passages, chunks, words, imageOnly },
    { reportIncompleteNaturalness, ratingFixtureError });

  const failureDetails = {
      ...(reportIncompleteNaturalness ? { naturalness: score.naturalness.evidence.records.filter(record => !record.qualified)
        .map(({ id, issues }) => ({ id, issues })) } : {}),
      readingOrder: evaluatedPages.filter((page) => !page.readingOrder)
        .map(({ id, failedCheckpoint }) => ({ id, failedCheckpoint })),
      narration: evaluatedPages.filter((page) => page.narrationErrors > 0)
        .map(({ id, narrationErrors }) => ({ id, narrationErrors })),
      grounding: chunks.filter((chunk) => !chunk.grounded).map((chunk) => chunk.id),
      alignment: words.filter((word) => !word.aligned).map((word) => word.id),
      imageOnly: imageOnly.filter((result) => (
        result.expectedImageOnly
          ? result.code !== 'scanned_pdf_unsupported'
          : result.code === 'scanned_pdf_unsupported'
      )).map((result) => result.id),
  };
  const failures = Object.entries(failureDetails).flatMap(([metric, entries]) => (
    entries.map((entry) => ({
      metric,
      ...(typeof entry === 'string' ? { id: entry } : entry),
    }))
  ));
  const [identityAfter, manifestBytes] = await Promise.all([
    resolvePdfAcceptanceCandidate(),
    readFile(MANIFEST_PATH),
  ]);
  const pinsAfter = await readAcceptanceSourcePins(backendIdentity.sourcePins);
  if (JSON.stringify(candidateIdentity) !== JSON.stringify(identityAfter)) throw new Error('PDF acceptance candidate identity changed during evaluation.');
  if (JSON.stringify(implementationPins) !== JSON.stringify(pinsAfter)) throw new Error('PDF acceptance source or retained data changed during evaluation.');
  const report = {
    backend: backendIdentity, implementationPins, implementationPinsUnchanged: true,
    scope: 'Fixed source/text/grounding acceptance through the selected parser; no browser raster, OCR recognition, speech audio or performance claim.',
    candidate: candidateIdentity.commitSha, candidateIdentity, candidateIdentityUnchanged: true,
    manifestSha256: sha256(manifestBytes),
    categoryCounts: countBenchmarkCategories(benchmarkRecords),
    goldEvidence,
    ...score,
    failures,
    failureDetails,
    pages: evaluatedPages,
    naturalnessEvidence: PDF_NATURALNESS_SAMPLE.map((sample, index) => ({
      ...ratingsByPassageId.get(sample.id),
      pdfId: sample.pdfId,
      pageNumber: sample.pageNumber,
      ...(reportIncompleteNaturalness ? {
        expectedPassageId: sample.id,
        currentTranscriptSha256: passages[index].currentTranscriptSha256,
        ratedTranscriptSha256: passages[index].ratedTranscriptSha256,
        ratingRecordCount: passages[index].ratingRecordCount,
        qualification: score.naturalness.evidence.records[index],
      } : {}),
    })),
    imageOnlyEvidence: imageOnly,
  };

  if (writeReport) {
    const destination = outputFile ? path.resolve(outputFile) : backend === 'original' ? REPORT_PATH : path.join(ROOT_DIR, 'artifacts', 'pdf-acceptance-oracle.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  return report;
}

async function readAcceptanceSourcePins(backendSourcePins, extraFiles = []) {
  const pins = await readPdfCorpusImplementationPins(ROOT_DIR);
  for (const relative of ['scripts/run-pdf-acceptance.mjs', 'scripts/pdf-acceptance-metrics.mjs', 'scripts/lib/pdf-acceptance-backend.mjs',
    'package-lock.json', 'tests/fixtures/pdf-naturalness-sample.js', 'tests/fixtures/pdf-naturalness-ratings.json',
    'src/lib/page-highlighter.js', 'src/lib/reading-model.js', ...backendSourcePins.map(pin => pin.path), ...extraFiles]) {
    const bytes = await readFile(path.isAbsolute(relative) ? relative : path.join(ROOT_DIR, relative));
    pins.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return pins;
}

async function runPdfLibraryAcceptance({ writeReport, goldPath, backend, outputFile, candidateIdentity,
  naturalnessRatingsPath, reportIncompleteNaturalness }) {
  const { records, routingControls, goldEvidence, benchmarkId } = loadPdfLibraryBenchmarkGold({ goldPath });
  const releaseVersion = JSON.parse(await readFile(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
  const naturalnessWaiver = naturalnessRatingsPath ? null : releaseGateWaiver('human-listening-reviews', releaseVersion);
  if (!naturalnessWaiver && !naturalnessRatingsPath && !reportIncompleteNaturalness) {
    throw new Error('Library PDF human reviews are required. Set PN_PDF_NATURALNESS_RATINGS to the imported current review receipts.');
  }
  const ratingRecords = naturalnessRatingsPath ? JSON.parse(await readFile(naturalnessRatingsPath, 'utf8')) : [];
  let ratingFixtureError = null;
  if (!naturalnessWaiver) {
    try { validateNaturalnessRatings(ratingRecords, PDF_LIBRARY_NATURALNESS_SAMPLE); }
    catch (error) { if (!reportIncompleteNaturalness) throw error; ratingFixtureError = error.message; }
  }
  const backendSession = await loadPdfAcceptanceBackend(backend);
  const { engine: pdfjs, identity: backendIdentity } = backendSession;
  let report;
  try {
    const extraPins = ['tests/helpers/pdf-library-benchmark-gold.js', 'tests/fixtures/pdf-library-acceptance-manifest.json',
      'tests/fixtures/pdf-library-naturalness-sample.js',
      'config/release-policy.json', 'scripts/lib/release-policy.mjs', 'package.json',
      ...(naturalnessRatingsPath ? [path.resolve(naturalnessRatingsPath)] : [])];
    const implementationPins = await readAcceptanceSourcePins(backendIdentity.sourcePins, extraPins);
    configurePdfWorker(pdfjs);
    const pages = [], chunks = [], words = [], verifiedInputs = new Map();
    for (const record of records) {
      const result = { id: record.id, source: record.source, sourceSha256: record.sha256,
        pageNumber: record.pageNumber, categories: [...record.categories],
        evaluated: false, readingOrder: false, narrationErrors: 0 };
      try {
        const bytes = await loadVerifiedPdf(record);
        verifiedInputs.set(record.source, { record, bytes: bytes.byteLength, sha256: sha256(bytes) });
        const page = await readBenchmarkPage(bytes, record.pageNumber, pdfjs);
        const pageText = record.privateFilePath
          ? await getLibraryProductionPageText(bytes, record, pdfjs)
          : await getProductionPageText(bytes, record, page, pdfjs);
        if (!pageText.speech.trim() || !tokenizeSpokenWords(pageText.speech).length) {
          result.emptyOutput = true;
          throw new Error('Readable benchmark page returned no spoken words.');
        }
        const checkpoint = evaluateReadingOrder(pageText, record.orderedCheckpoints);
        const grounding = evaluateGrounding(record, page, pageText);
        if (!grounding.chunks.length || !grounding.words.length) throw new Error('Benchmark page has no grounding/word observations.');
        Object.assign(result, { evaluated: true, readingOrder: checkpoint.passed,
          failedCheckpoint: checkpoint.failedCheckpoint,
          narrationErrors: countNarrationErrors(pageText.speech, record.forbiddenNarration),
          transcriptHash: sha256(normalizeText(pageText.speech)),
          naturalnessTranscriptHash: sha256(selectPdfNaturalnessPassage(pageText.speech)),
          forbiddenSpans: record.forbiddenNarration.length,
          narrationStartPage: record.narrationStartPage ?? null });
        chunks.push(...grounding.chunks); words.push(...grounding.words);
      } catch (error) {
        result.error = { code: error?.code ?? null, message: String(error?.message || error) };
        // A failed/empty page remains in every required denominator and cannot qualify the gate.
        chunks.push({ id: `${record.id}:missing-page`, grounded: false });
        words.push({ id: `${record.id}:missing-page`, aligned: false });
      }
      pages.push(result);
    }
    const nativeRoutingControls = [];
    for (const record of routingControls) {
      const result = { id: record.id, source: record.source, sourceSha256: record.sha256,
        pageNumber: record.pageNumber, narrationStartPage: record.narrationStartPage,
        expectedCode: record.expectedCode, passed: false };
      try {
        const bytes = await loadVerifiedPdf(record);
        verifiedInputs.set(record.source, { record, bytes: bytes.byteLength, sha256: sha256(bytes) });
        Object.assign(result, await evaluateNativeRoutingControl(bytes, record, pdfjs));
      } catch (error) {
        result.error = { code: error?.code ?? null, message: String(error?.message || error) };
      }
      nativeRoutingControls.push(result);
    }
    const imageOnly = await evaluateImageOnlyFixtures(pdfjs);
    const passages = naturalnessWaiver ? [] : bindPdfNaturalnessRatings(PDF_LIBRARY_NATURALNESS_SAMPLE, pages, ratingRecords);
    const score = scorePdfAcceptance({ pages, passages, chunks, words, imageOnly },
      { naturalnessWaiver, reportIncompleteNaturalness, ratingFixtureError });
    const failureDetails = {
      ...(score.naturalness.evidence ? { naturalness: score.naturalness.evidence.records.filter(record => !record.qualified)
        .map(({ id, issues }) => ({ id, issues })) } : {}),
      evaluation: pages.filter(page => !page.evaluated).map(({ id, emptyOutput, error }) => ({ id, emptyOutput: Boolean(emptyOutput), error })),
      readingOrder: pages.filter(page => !page.readingOrder).map(({ id, failedCheckpoint }) => ({ id, failedCheckpoint })),
      narration: pages.filter(page => page.narrationErrors).map(({ id, narrationErrors }) => ({ id, narrationErrors })),
      grounding: chunks.filter(chunk => !chunk.grounded).map(chunk => chunk.id),
      alignment: words.filter(word => !word.aligned).map(word => word.id),
      imageOnly: imageOnly.filter(row => row.expectedImageOnly
        ? row.code !== 'scanned_pdf_unsupported' : row.code === 'scanned_pdf_unsupported').map(row => row.id),
      nativeRoutingControls: nativeRoutingControls.filter(row => !row.passed),
    };
    const after = await readAcceptanceSourcePins(backendIdentity.sourcePins, extraPins);
    const afterGold = loadPdfLibraryBenchmarkGold({ goldPath }).goldEvidence;
    if (JSON.stringify(implementationPins) !== JSON.stringify(after) || JSON.stringify(goldEvidence) !== JSON.stringify(afterGold)) {
      throw new Error('Library benchmark source, gold or independent references changed during evaluation.');
    }
    const inputPins = [];
    for (const [source, expected] of verifiedInputs) {
      const bytes = await loadVerifiedPdf(expected.record);
      if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('Library benchmark input changed during evaluation.');
      inputPins.push({ source, bytes: expected.bytes, sha256: expected.sha256 });
    }
    const identityAfter = await resolvePdfAcceptanceCandidate();
    if (JSON.stringify(candidateIdentity) !== JSON.stringify(identityAfter)) throw new Error('PDF acceptance candidate identity changed during evaluation.');
    const expectedInputSources = new Set([...records, ...routingControls].map(record => record.source)).size;
    report = { benchmark: 'library-v1', benchmarkId, candidate: candidateIdentity.commitSha, candidateIdentity, candidateIdentityUnchanged: true, backend: backendIdentity,
      manifestSha256: goldEvidence.manifestSha256, goldEvidence, categoryCounts: countBenchmarkCategories(records),
      implementationPins, implementationPinsUnchanged: true, ...score,
      passed: score.passed && nativeRoutingControls.every(row => row.passed),
      inputPins, expectedInputSources, inputPinsUnchanged: verifiedInputs.size === expectedInputSources,
      pages, failureDetails,
      nativeRoutingControls,
      nativeRoutingControlCounts: { expected: routingControls.length, evaluated: nativeRoutingControls.filter(row => row.probes?.length === 2).length,
        passed: nativeRoutingControls.filter(row => row.passed).length },
      failures: Object.entries(failureDetails).flatMap(([metric, entries]) => entries.map(entry => ({ metric, ...(typeof entry === 'string' ? { id: entry } : entry) }))),
      naturalnessEvidence: passages, imageOnlyEvidence: imageOnly,
      forbiddenNarrationCoverage: { pagesWithChecks: pages.filter(page => page.forbiddenSpans > 0).length,
        expectedPagesWithChecks: records.filter(record => record.forbiddenNarration.length > 0).length,
        expectedSpans: records.reduce((sum, record) => sum + record.forbiddenNarration.length, 0) },
      scope: 'New independent library-page order/furniture benchmark plus unchanged authored fixtures. Native routing controls separately require exact target-only and contextual production-stream refusals; they are not positive pages or OCR successes. Grounding and alignment measure internal candidate speech-to-candidate-DOM mapping, not independent text completeness or screen geometry. No raster, OCR recognition, speech audio or performance claim.',
    };
  } finally {
    const integrity = await backendSession.dispose?.();
    if (report && integrity) {
      report.backendIntegrity = integrity;
      if (!integrity.pass) {
        report.passed = false;
        report.failures.push({ metric: 'browserBackend', message: 'Browser backend cleanup or source/network integrity failed.' });
      }
    }
  }
  if (writeReport) {
    const destination = outputFile ? path.resolve(outputFile) : path.join(ROOT_DIR, 'artifacts', 'pdf-acceptance', 'library-v1',
      `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`, 'report.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  return report;
}

async function evaluateNativeRoutingControl(bytes, record, pdfjs) {
  const probes = [];
  for (const [scope, startPage] of [['target-only', record.pageNumber], ['contextual', record.narrationStartPage]]) {
    const result = { scope, startPage, code: null, returnedOutput: false, cleanupErrors: [] };
    let task, stream;
    try {
      task = pdfjs.getDocument({ data: bytes.slice(), disableWorker: true, useSystemFonts: true, enableScripting: false });
      const document = await task.promise;
      result.sourcePageCount = document.numPages;
      if (!Number.isSafeInteger(document.numPages) || record.pageNumber > document.numPages) throw new Error('Native routing target is outside the source document.');
      // Explicitly bound only the target-only diagnostic. A blank target must not borrow a later page's refusal.
      const bounded = scope === 'target-only' ? { numPages: record.pageNumber,
        getPage: pageNumber => {
          if (pageNumber !== record.pageNumber) throw new Error('Target-only routing probe requested a different page.');
          return document.getPage(pageNumber);
        } } : document;
      result.lastAllowedPage = bounded.numPages;
      stream = iteratePdfSpeechChunks(bounded, { pdfjs, startPage })[Symbol.asyncIterator]();
      for (;;) {
        const next = await stream.next();
        if (next.done || next.value.pageNumber >= record.pageNumber) {
          // Any successful end/target result fails a refusal control, including partial or empty text.
          result.returnedOutput = true;
          result.targetObserved = !next.done && next.value.pageNumber === record.pageNumber;
          result.returnedSpeechCharacters = next.done ? 0 : String(next.value.pdfNarration?.speech ?? next.value.speech ?? '').length;
          break;
        }
      }
    } catch (error) {
      result.code = error?.code ?? null;
      result.error = { name: error?.name ?? null, code: result.code, message: String(error?.message || error) };
    } finally {
      for (const close of [() => stream?.return?.(), () => task?.destroy()]) {
        try { await close(); }
        catch (error) { result.cleanupErrors.push({ code: error?.code ?? null, message: String(error?.message || error) }); }
      }
    }
    probes.push(result);
  }
  return { passed: probes.every(probe => !probe.returnedOutput && probe.code === record.expectedCode && !probe.cleanupErrors.length), probes };
}

async function getLibraryProductionPageText(bytes, record, pdfjs) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableWorker: true, useSystemFonts: true, enableScripting: false });
  let stream;
  try {
    const document = await task.promise;
    stream = iteratePdfSpeechChunks(document, { pdfjs, startPage: record.narrationStartPage })[Symbol.asyncIterator]();
    for (;;) {
      const next = await stream.next();
      if (next.done || next.value.pageNumber > record.pageNumber) return { speech: '', anchorText: '' };
      if (next.value.pageNumber !== record.pageNumber) continue;
      const chunk = next.value;
      // The first real target chunk carries the complete filtered page narration and source indices.
      if (typeof chunk.pdfNarration?.speech !== 'string') throw new Error('Production page narration metadata is missing.');
      return { speech: chunk.pdfNarration.speech, anchorText: chunk.anchorText || '', pdfNarration: chunk.pdfNarration };
    }
  } finally {
    try { await stream?.return?.(); }
    finally { await task.destroy(); }
  }
}

export function evaluateReadingOrder(pageText, checkpoints) {
  return matchesOrderedCheckpoints(pageText?.speech || '', checkpoints);
}

export function bindPdfNaturalnessRatings(samples, pages, ratingRecords) {
  const pagesById = new Map(pages.map(page => [page.id, page]));
  const rows = Array.isArray(ratingRecords) ? ratingRecords : [];
  return samples.map(sample => {
    const rating = rows.find(row => row?.passageId === sample.id);
    const currentTranscriptSha256 = pagesById.get(sample.pdfId)?.naturalnessTranscriptHash ?? null;
    return { id: sample.id, transcriptHashMatches: Boolean(currentTranscriptSha256 && rating?.transcriptSha256 === currentTranscriptSha256),
      transcriptSha256: rating?.transcriptSha256 ?? null, ratedTranscriptSha256: rating?.transcriptSha256 ?? null,
      currentTranscriptSha256, ratingRecordCount: rows.filter(row => row?.passageId === sample.id).length,
      ratings: Array.isArray(rating?.ratings) ? rating.ratings : [], reviews: Array.isArray(rating?.reviews) ? rating.reviews : [] };
  });
}

export function validateNaturalnessRatings(ratingRecords, samples) {
  if (!Array.isArray(ratingRecords) || ratingRecords.length !== samples.length) {
    throw new Error(`Naturalness ratings fixture must contain exactly ${samples.length} records.`);
  }
  const ratingsById = new Map();
  for (const record of ratingRecords) {
    if (!record?.passageId || ratingsById.has(record.passageId)) {
      throw new Error('Naturalness ratings fixture must contain unique passage ids.');
    }
    ratingsById.set(record.passageId, record);
  }

  for (const sample of samples) {
    const record = ratingsById.get(sample.id);
    if (!record) throw new Error(`Naturalness ratings fixture is missing ${sample.id}.`);
    if (!/^[0-9a-f]{64}$/u.test(record.transcriptSha256 || '')) {
      throw new Error(`Naturalness ratings fixture has an invalid transcript hash for ${sample.id}.`);
    }
    const ratings = record.ratings;
    validateNaturalnessRatingPanel(ratings, `Naturalness ratings fixture for ${sample.id}`);
    validateNaturalnessReviews(record, `Naturalness ratings fixture for ${sample.id}`);
    const sortedRatings = [...ratings].sort((a, b) => a - b);
    const middle = Math.floor(sortedRatings.length / 2);
    const expectedMedian = sortedRatings.length % 2
      ? sortedRatings[middle]
      : (sortedRatings[middle - 1] + sortedRatings[middle]) / 2;
    if (record.median !== expectedMedian) {
      throw new Error(`Naturalness ratings fixture has an invalid median for ${sample.id}.`);
    }
    const actualCategories = [...(record.categories || [])].sort();
    const expectedCategories = [...sample.categories].sort();
    if (JSON.stringify(actualCategories) !== JSON.stringify(expectedCategories)) {
      throw new Error(`Naturalness ratings fixture has invalid categories for ${sample.id}.`);
    }
  }
}

function countBenchmarkCategories(records) {
  const counts = {};
  for (const category of [...new Set(records.flatMap((record) => record.categories))].sort()) {
    counts[category] = records.filter((record) => record.categories.includes(category)).length;
  }
  return counts;
}

export async function generatePdfNaturalnessPacket({ backend, benchmark = 'historical-v1', goldPath } = {}) {
  if (!['library-v1', 'historical-v1'].includes(benchmark)) throw new Error('Unknown PDF naturalness benchmark.');
  const library = benchmark === 'library-v1';
  backend ??= process.env.PN_PDF_ACCEPTANCE_BACKEND ?? (library ? 'original-browser' : 'original');
  if (!library && backend === 'original-browser') throw new Error('Historical naturalness packets retain original and pdfjs-oracle backends.');
  const records = library ? loadPdfLibraryBenchmarkGold({ goldPath }).records : PDF_ACCEPTANCE_BENCHMARK;
  const samples = library ? PDF_LIBRARY_NATURALNESS_SAMPLE : PDF_NATURALNESS_SAMPLE;
  const recordsById = new Map(records.map(record => [record.id, record]));
  const passages = [];
  const session = await loadPdfAcceptanceBackend(backend), { engine: pdfjs } = session;
  try {
    configurePdfWorker(pdfjs);
    for (const sample of samples) {
      const record = recordsById.get(sample.pdfId);
      if (!record) throw new Error(`Unknown naturalness PDF identity: ${sample.pdfId}.`);
      const bytes = await loadVerifiedPdf(record);
      const page = await readBenchmarkPage(bytes, record.pageNumber, pdfjs);
      const pageText = record.privateFilePath
        ? await getLibraryProductionPageText(bytes, record, pdfjs)
        : await getProductionPageText(bytes, record, page, pdfjs);
      const transcript = selectPdfNaturalnessPassage(pageText.speech);
      passages.push({
        passageId: sample.id,
        transcript,
        transcriptSha256: sha256(transcript),
        categories: [...sample.categories],
      });
    }
  } finally {
    const integrity = await session.dispose?.();
    if (integrity && !integrity.pass) throw new Error('Naturalness packet backend integrity failed.');
  }
  return passages;
}

export function selectPdfNaturalnessPassage(speech) {
  return chunkText(normalizeTextPreservingCase(speech), 900, { targetMinLen: 650 })[0] || '';
}

export async function writePdfNaturalnessPacket({ backend, benchmark = 'historical-v1', goldPath, outputFile = null } = {}) {
  backend ??= process.env.PN_PDF_ACCEPTANCE_BACKEND ?? (benchmark === 'library-v1' ? 'original-browser' : 'original');
  const passages = await generatePdfNaturalnessPacket({ backend, benchmark, goldPath });
  const packet = {
    backend, ...(benchmark === 'library-v1' ? { benchmark } : {}),
    rubric: 'Score 1-5 for line-wrap repair, split-word repair, punctuation, and structural pauses only. Ignore voice timbre. Use integer scores.',
    passages,
  };
  const destination = outputFile ? path.resolve(outputFile) : path.join(ROOT_DIR, 'artifacts',
    `pdf-naturalness-${benchmark === 'library-v1' ? 'library-v1-' : ''}${backend}.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
  return packet;
}

async function loadVerifiedPdf(record) {
  const source = record.privateFilePath ?? record.source;
  let bytes;

  if (/^https:\/\//u.test(source)) {
    await mkdir(CACHE_DIR, { recursive: true });
    const cachePath = path.join(CACHE_DIR, `${record.id}.pdf`);
    try {
      bytes = new Uint8Array(await readFile(cachePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const response = await fetch(source, {
        headers: { accept: 'application/pdf' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`Could not download ${record.id}: HTTP ${response.status}.`);
      bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(cachePath, bytes);
    }
  } else {
    bytes = new Uint8Array(await readFile(path.resolve(ROOT_DIR, source)));
  }

  const actualHash = sha256(bytes);
  if (actualHash !== record.sha256) {
    throw new Error(`SHA-256 mismatch for ${record.id}: expected ${record.sha256}, got ${actualHash}.`);
  }
  return bytes;
}

async function readBenchmarkPage(bytes, pageNumber, pdfjs) {
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    disableWorker: true,
    useSystemFonts: true,
    enableScripting: false,
  });
  const document = await loadingTask.promise;

  try {
    if (pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error(`Benchmark page ${pageNumber} is outside a ${document.numPages}-page PDF.`);
    }
    const page = await document.getPage(pageNumber);
    try {
      const content = await page.getTextContent();
      return { items: content.items, pageCount: document.numPages, pageView: page.view, pageRotation: page.rotate ?? 0 };
    } finally {
      page.cleanup?.();
    }
  } finally {
    await loadingTask.destroy();
  }
}

async function getProductionPageText(bytes, record, page, pdfjs) {
  if (page.pageCount === 1 || record.id !== 'fixture-running-content') {
    const model = createPdfPageModel(page.items, { pageView: page.pageView });
    const itemOrders = new Map(model.orderedItems.map((item, order) => [item.originalIndex, order]));
    return {
      anchorText: model.anchorText,
      speech: model.speech,
      pdfNarration: {
        speech: model.speech,
        narratedItemOrders: (model.narratedOriginalIndices || []).map(index => itemOrders.get(index)),
      },
    };
  }

  const article = await extractPdfTextFromData(bytes.slice(), { pdfjs, title: record.id });
  const pageChunk = article.chunks.find((chunk) => chunk.pageNumber === record.pageNumber);
  return {
    anchorText: pageChunk?.anchorText || '',
    speech: pageChunk?.speech || '',
    pdfNarration: pageChunk?.pdfNarration,
  };
}

function evaluateGrounding(record, page, pageText) {
  const dom = createTextLayerDom(record, page.items, page.pageView, record.privateFilePath ? page.pageRotation : 0);
  const captured = installHighlightCapture();
  const highlighter = createPageHighlighter(dom.window.document, { pdfMode: true });
  const pageChunk = {
    type: 'pdf-page',
    speech: pageText.speech,
    text: pageText.anchorText,
    anchorText: pageText.anchorText,
    anchorId: `pdf-page-${record.pageNumber}`,
    speechPrefixWords: 0,
    pageNumber: record.pageNumber,
    pdfNarration: pageText.pdfNarration,
  };
  const speechChunks = chunkText([pageChunk], 360, { targetMinLen: 180 });
  const chunks = [];
  const words = [];

  for (const [chunkIndex, chunk] of speechChunks.entries()) {
    const highlightResult = highlighter.highlightChunkByAnchor(chunk.anchorId, chunk.anchorText, {
      chunkText: chunk.speech,
      domWordOffset: chunk.domWordOffset,
      pdfNarration: chunk.pdfNarration,
      reportGrounding: true,
    });
    chunks.push({
      id: `${record.id}:chunk-${chunkIndex + 1}`,
      grounded: Boolean(highlightResult.grounded),
    });

    const spokenWords = tokenizeSpokenWords(chunk.speech);
    for (let speechWordIndex = 0; speechWordIndex < spokenWords.length; speechWordIndex += 1) {
      const domWordIndex = getDomWordIndexForSpeechWord(chunk, speechWordIndex);
      const expected = spokenWords[speechWordIndex]?.text || '';
      const wordResult = highlighter.highlightWord(domWordIndex);
      const actual = getCapturedText(captured, HIGHLIGHT_WORD_TRAIL[0]);
      words.push({
        id: `${record.id}:chunk-${chunkIndex + 1}:word-${speechWordIndex}`,
        aligned: Boolean(wordResult.ok && normalizeToken(actual) === normalizeToken(expected)),
      });
    }
  }

  dom.window.close();
  delete globalThis.CSS;
  delete globalThis.Highlight;
  return { chunks, words };
}

function createTextLayerDom(record, items, pageView, pageRotation = 0) {
  const dom = new JSDOM('<body><section class="pdf-page"><div class="textLayer"></div></section></body>', {
    pretendToBeVisual: true,
    url: 'https://example.test/pdf-viewer.html',
  });
  const { document } = dom.window;
  const section = document.querySelector('section');
  const textLayer = document.querySelector('.textLayer');
  section.dataset.pagenarratorId = `pdf-page-${record.pageNumber}`;
  section.getBoundingClientRect = () => ({ top: 100, left: 60, right: 760, bottom: 880, width: 700, height: 780 });
  dom.window.scrollBy = () => {};

  const originalCreateRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = originalCreateRange();
    const rect = { top: 120, left: 80, right: 720, bottom: 300, width: 640, height: 180 };
    range.getBoundingClientRect = () => rect;
    range.getClientRects = () => [rect];
    return range;
  };

  for (const item of items) {
    if (!normalizeText(item.str)) continue;
    const span = document.createElement('span');
    span.textContent = String(item.str);
    textLayer.appendChild(span);
  }
  annotatePdfTextLayer(textLayer, items, { pageView, pageRotation });
  return dom;
}

function installHighlightCapture() {
  const captured = new Map();
  globalThis.Highlight = class AcceptanceHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        captured.set(name, highlight.ranges);
      },
      delete(name) {
        captured.delete(name);
      },
    },
  };
  return captured;
}

function getCapturedText(captured, name) {
  return (captured.get(name) || []).map((range) => range.toString()).join(' ');
}

async function evaluateImageOnlyFixtures(pdfjs) {
  const fixtureDir = path.join(ROOT_DIR, 'tests', 'fixtures', 'pdfs', 'image-only');
  return Promise.all(IMAGE_ONLY_FIXTURES.map(async ([fileName, expectedImageOnly]) => {
    const bytes = new Uint8Array(await readFile(path.join(fixtureDir, fileName)));
    let code = null;
    try {
      await extractPdfTextFromData(bytes, { pdfjs, title: fileName });
    } catch (error) {
      code = error?.code || 'unexpected_error';
    }
    return { id: fileName, expectedImageOnly, code };
  }));
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeTextPreservingCase(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeToken(value = '') {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const backend = process.argv.find(value => value.startsWith('--backend='))?.slice('--backend='.length)
    ?? process.env.PN_PDF_ACCEPTANCE_BACKEND;
  const outputFile = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? null;
  const benchmark = process.argv.find(value => value.startsWith('--benchmark='))?.slice('--benchmark='.length)
    ?? (process.argv.includes('--write-naturalness-packet') ? 'historical-v1' : 'library-v1');
  if (process.argv.includes('--write-naturalness-packet')) {
    const packet = await writePdfNaturalnessPacket({ backend, benchmark, outputFile });
    process.stdout.write(`Wrote ${packet.passages.length} blind naturalness passages for ${backend}.\n`);
  } else {
    const report = await runPdfAcceptance({ writeReport: process.argv.includes('--write-report'), backend, outputFile,
      benchmark,
      reportIncompleteNaturalness: process.argv.includes('--report-incomplete-naturalness') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
}
