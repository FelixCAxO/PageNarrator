import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import {
  getExtensionId,
  launchExtensionContext,
  openCorpusArticle,
  openPdfViewer,
  recordPlaybackEvents,
  seedHardwareProfile,
  seedReadableTabTarget,
  seedRealTtsFlowFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';
import { routeKokoroModelFiles, seedKokoroModelCache } from './kokoro-download-fixture.js';
import {
  buildCorpusContentReport,
  buildCorpusFlowReport,
} from './corpus-flow-invariants.js';

// Real model coverage is opt-in: it replays the pinned download from local
// model files and synthesizes on the host CPU/GPU, so it needs real compute:
//   PN_E2E_REAL_MODEL=1 npx playwright test --project=real-model
// Without the flag every test below is skipped before a browser is launched, so
// `npm run test:e2e:local` stays offline and deterministic by default.
const RUN_REAL_MODEL = /^(1|true|yes)$/i.test(process.env.PN_E2E_REAL_MODEL || '');
const RUN_REAL_ARXIV = /^(1|true|yes)$/i.test(process.env.PN_E2E_REAL_ARXIV || '');
const FORCE_REAL_MODEL_CPU = /^(1|true|yes)$/i.test(process.env.PN_E2E_FORCE_CPU || '');
const LIVE_MODEL_DOWNLOAD = /^(1|true|yes)$/i.test(process.env.PN_E2E_LIVE_MODEL_DOWNLOAD || '');
const REAL_MODEL_SKIP_REASON = 'Set PN_E2E_REAL_MODEL=1 to run real Kokoro synthesis with fixture-replayed downloads (needs real compute). Add PN_E2E_LIVE_MODEL_DOWNLOAD=1 for genuine Hugging Face downloads.';
const REAL_ARXIV_SKIP_REASON = 'Set PN_E2E_REAL_ARXIV=1 with PN_E2E_REAL_MODEL=1 to run the live arXiv PDF no-adapter flow test.';
// Model load + warmup, then full on-device synthesis. These are two
// sequential waits, so the per-test cap must cover BOTH plus setup margin -
// otherwise the test aborts mid-read and the phase budgets are not honored.
const MODEL_READY_TIMEOUT_MS = 4 * 60_000;
const FINISH_TIMEOUT_MS = 4 * 60_000;
const REAL_MODEL_TEST_TIMEOUT_MS = MODEL_READY_TIMEOUT_MS + FINISH_TIMEOUT_MS + 90_000;

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const multiPagePdf = `data:application/pdf;base64,${Buffer.from(buildPdfBytes([1, 2].map((page) => ({
  items: (page === 1 ? [
    'PageNarrator single column fixture page 1.',
    'This local PDF keeps its text selectable while PageNarrator reads every sentence aloud.',
    'Page transitions keep the voice moving, with words highlighted in reading order.',
    'Reader settings preserve the selected voice and speed while the audio plays.',
  ] : [
    'PageNarrator second page fixture.',
    'The next page adds fresh text to verify continuation through the document.',
    'Every spoken chunk should finish once, with the following chunk prepared ahead of playback.',
    'Selecting a different voice should preserve the text, position, and reading controls.',
  ]).map((text, line) => ({ text, x: 54, y: 700 - line * 24 })),
})))).toString('base64')}`;

const REAL_TTS_PLAYBACK_SETTINGS_BASE = {
  language: 'en',
  voice: 'af_heart',
  speed: 1,
  sectionPauseSeconds: 0,
};

const REAL_TTS_PROFILE_CASES = Object.freeze([
  {
    name: 'quality',
    playbackSettings: {
      ...REAL_TTS_PLAYBACK_SETTINGS_BASE,
      // Force the generated path so the read proves the downloaded model works.
      ttsPerformanceProfile: 'quality',
    },
  },
  {
    name: 'auto',
    playbackSettings: {
      ...REAL_TTS_PLAYBACK_SETTINGS_BASE,
      // Exercise the user-facing profile path.
      ttsPerformanceProfile: 'auto',
    },
  },
]);

const LIVE_ARXIV_PDF_URL = 'https://arxiv.org/pdf/2603.20576';

test.describe('real Kokoro model end-to-end reads', () => {
  test.beforeEach(() => {
    test.skip(!RUN_REAL_MODEL, REAL_MODEL_SKIP_REASON);
    test.setTimeout(REAL_MODEL_TEST_TIMEOUT_MS);
  });

  for (const { name, playbackSettings } of REAL_TTS_PROFILE_CASES) {
    test(`loads the Kokoro model and narrates an article with real synthesis (${name})`, async () => {
    let server;
    let cleanup = async () => {};
    try {
      server = await startCorpusFixtureServer({ corpusDir: fixturesDir });
      const launched = await launchExtensionContext({ hostPermissions: ['http://*/*'] });
      cleanup = launched.cleanup;
      const { context } = launched;
      await routeKokoroModelFiles(context, { live: LIVE_MODEL_DOWNLOAD });
      if (FORCE_REAL_MODEL_CPU) await forceNoWebGpuAdapter(context);
      await seedHardwareProfile(context, {
        name: `real-${name}${FORCE_REAL_MODEL_CPU ? '-cpu' : ''}`,
        navigator: {},
        playbackSettings: FORCE_REAL_MODEL_CPU
          ? { ...playbackSettings, ttsBackendPreference: 'wasm' }
          : playbackSettings,
      }, { enableProbe: true, recordFlow: true });
      await seedKokoroModelCache(context, { live: LIVE_MODEL_DOWNLOAD });

      const articlePage = await openCorpusArticle(context, server, 'playback-controls-long.html');
      await startReadFromToolbarPopup(context, articlePage);
      await waitForEngineState(context, /reading|finished/, MODEL_READY_TIMEOUT_MS);
      await waitForEngineState(context, 'finished', FINISH_TIMEOUT_MS);

      const diagnostics = await getEngineDiagnostics(context);
      const readerEngineLog = diagnostics.log;
      const pageLog = await recordPlaybackEvents(articlePage, context);
      const report = buildCorpusFlowReport({ readerEngineLog, pageLog });
      const contentReport = buildCorpusContentReport({ readerEngineLog });
      const mediaClockGapMs = maxMediaClockHandoffGapMs(report);

      expect(report.synthesisFailures, 'real Kokoro synthesis should not record a synthesis failure').toHaveLength(0);
      expect(browserFallbackEvents(readerEngineLog), 'real read should not switch to browser speech after Kokoro starts').toHaveLength(0);
      expect(report.chunksExtracted, 'real read should extract chunks').toBeGreaterThan(0);
      expect(report.chunksSpoken, 'every extracted chunk should be spoken').toBe(report.chunksExtracted);
      expect(report.missingChunkIndices, 'no extracted chunk should be dropped').toEqual([]);
      expect(report.unendedChunkIndices, 'every spoken chunk should reach its end').toEqual([]);
      expect(report.replayedChunkIndices, 'no chunk should replay during a clean read').toEqual([]);
      // Decode-latency events are emitted only for blob-based on-device audio.
      expect(generatedAudioDecodeEvents(readerEngineLog).length, 'real read should decode on-device Kokoro audio, not a browser voice').toBeGreaterThan(0);
      // Real generated audio carries genuine duration and real word-timing
      // alignment, which silent test speech could never produce together.
      expect(maxChunkEndMediaTime(report.chunkEnds), 'real audio should advance past zero seconds').toBeGreaterThan(0);
      expect(report.wordEvents, 'real read should emit word-highlight events').not.toHaveLength(0);
      expect(report.tokenMismatches, 'spoken token should match highlighted DOM token').toEqual([]);
      expect(contentReport.forbiddenSpokenChunks, 'widget/share text should not be spoken').toEqual([]);

      const hardwareProbe = diagnostics.hardwareProbe;
      expect(hardwareProbe?.firstSynthesisMs, 'real read should record first synthesis timing').toBeGreaterThan(0);
      expect(report.chunkStarts[1].speechText.length, 'the body buffered after the short title should use a small opening chunk')
        .toBeLessThanOrEqual(120);
      expect(hardwareProbe.sections[1].synthesisEndedAtMs, 'first paragraph should be ready before the short opening title plays')
        .toBeLessThanOrEqual(hardwareProbe.sections[0].audioStartAtMs);
      await test.info().attach('article-reading-diagnostics', {
        body: Buffer.from(JSON.stringify({ hardwareProbe, chunkStarts: report.chunkStarts, chunkEnds: report.chunkEnds })),
        contentType: 'application/json',
      });
      console.log(`[real-model:${name}] ${JSON.stringify({
        backend: hardwareProbe.selectedBackendPlan,
        fallbacks: hardwareProbe.fallbacks,
        modelLoadMs: hardwareProbe.modelLoadMs,
        firstAudibleMs: hardwareProbe.preTtsLatency?.firstAudibleMs,
        openingBodyChars: report.chunkStarts[1].speechText.length,
        openingBodySynthesisMs: hardwareProbe.sections[1].synthesisMs,
        synthesisMs: hardwareProbe.sections?.map((section) => section.synthesisMs) || [],
        chunksSpoken: report.chunksSpoken,
        p95HandoffGapMs: report.p95HandoffGapMs,
        mediaClockGapMs,
      })}`);
      expect(report.p95HandoffGapMs, 'article chunk handoffs should stay smooth').toBeLessThan(500);
      expect(mediaClockGapMs, 'late callbacks should not conceal an article playback pause').toBeLessThan(500);

      const spokenText = report.chunkStarts.map((entry) => entry.speechText || '').join(' ');
      expect(spokenText, 'article body should be narrated').toContain('extracts article text');
    } finally {
      await cleanup();
      await server?.close();
    }
  });

    test(`loads the Kokoro model and narrates a PDF with real synthesis (${name})`, async () => {
    const { context, cleanup } = await launchExtensionContext();
    try {
      await routeKokoroModelFiles(context, { live: LIVE_MODEL_DOWNLOAD });
      if (FORCE_REAL_MODEL_CPU) await forceNoWebGpuAdapter(context);
      await seedRealTtsFlowFlags(context, { playbackSettings: FORCE_REAL_MODEL_CPU
        ? { ...playbackSettings, ttsBackendPreference: 'wasm' } : playbackSettings });
      await seedKokoroModelCache(context, { live: LIVE_MODEL_DOWNLOAD });

      const pdfPage = await openPdfViewer(context, multiPagePdf);
      await expect(pdfPage.locator('#pdf-status')).toContainText('2 pages loaded', { timeout: 30_000 });
      await expect(pdfPage.locator('[data-pagenarrator-id="pdf-page-1"] .textLayer')).toContainText(
        'PageNarrator single column fixture',
      );

      await pdfPage.bringToFront();
      await seedReadableTabTarget(context, pdfPage, { allowActiveExtensionTab: true });
      await startReadFromToolbarPopup(context, pdfPage);
      await waitForEngineState(context, /reading|finished/, MODEL_READY_TIMEOUT_MS);
      await waitForEngineState(context, 'finished', FINISH_TIMEOUT_MS);

      const readerEngineLog = (await getEngineDiagnostics(context)).log;
      const report = buildCorpusFlowReport({ readerEngineLog });
      const mediaClockGapMs = maxMediaClockHandoffGapMs(report);

      expect(report.synthesisFailures, 'real Kokoro PDF synthesis should not record a synthesis failure').toHaveLength(0);
      expect(browserFallbackEvents(readerEngineLog), 'real PDF read should not switch to browser speech after Kokoro starts').toHaveLength(0);
      expect(report.chunksSpoken, 'PDF read should speak at least one chunk').toBeGreaterThan(0);
      expect(report.chunkStarts.length, 'real PDF audio should cover multiple chunks').toBeGreaterThan(1);
      expect(report.chunksSpoken, 'every extracted PDF chunk should be spoken').toBe(report.chunksExtracted);
      expect(report.missingChunkIndices, 'no extracted PDF chunk should be dropped').toEqual([]);
      expect(report.unendedChunkIndices, 'every spoken PDF chunk should reach its end').toEqual([]);
      expect(report.replayedChunkIndices, 'no PDF chunk should replay during a clean read').toEqual([]);
      expect(report.p95HandoffGapMs, 'PDF chunk handoffs should stay smooth').toBeLessThan(500);
      expect(mediaClockGapMs, 'late callbacks should not conceal a PDF playback pause').toBeLessThan(500);
      expect(generatedAudioDecodeEvents(readerEngineLog).length, 'real PDF read should decode on-device Kokoro audio, not a browser voice').toBeGreaterThan(0);
      expect(maxChunkEndMediaTime(report.chunkEnds), 'real PDF audio should advance past zero seconds').toBeGreaterThan(0);

      const spokenText = report.chunkStarts.map((entry) => entry.speechText || '').join(' ');
      expect(spokenText, 'PDF body should be narrated').toContain('PageNarrator single column fixture');
      expect(spokenText, 'first PDF page should be narrated').toContain('fixture page 1');
      expect(spokenText, 'both PDF pages should be narrated').toContain('second page fixture');
      console.log(`[real-model:pdf:${name}] ${JSON.stringify({
        chunksSpoken: report.chunksSpoken,
        p95HandoffGapMs: report.p95HandoffGapMs,
        mediaClockGapMs,
      })}`);
    } finally {
      await cleanup();
    }
  });
  }

  test('loads and narrates the live arXiv PDF smoothly on WASM without adapter console errors', async () => {
    test.skip(!RUN_REAL_ARXIV, REAL_ARXIV_SKIP_REASON);

    const extensionErrors = [];
    const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://arxiv.org/*'] });
    await routeKokoroModelFiles(context, { live: LIVE_MODEL_DOWNLOAD });
    watchExtensionErrors(context, extensionErrors);

    try {
      await forceNoWebGpuAdapter(context);
      await seedHardwareProfile(context, {
        name: 'real-arxiv-no-adapter',
        navigator: {
          deviceMemory: 8,
          hardwareConcurrency: 8,
        },
        playbackSettings: {
          ...REAL_TTS_PLAYBACK_SETTINGS_BASE,
          ttsPerformanceProfile: 'auto',
        },
      }, { enableProbe: true, recordFlow: true });
      await seedKokoroModelCache(context, { live: LIVE_MODEL_DOWNLOAD });

      const extensionId = await getExtensionId(context);
      const pdfPage = await context.newPage();
      watchPageErrors(pdfPage, 'pdf-viewer', extensionErrors);
      await pdfPage.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(LIVE_ARXIV_PDF_URL)}`);
      await expect(pdfPage.locator('#pdf-status')).toHaveText(/^[1-9]\d* pages? loaded$/, { timeout: 120_000 });
      await seedReadableTabTarget(context, pdfPage, { allowActiveExtensionTab: true });

      await startReadFromToolbarPopup(context, pdfPage);
      await waitForEngineState(context, /reading|finished/, MODEL_READY_TIMEOUT_MS);
      await expect.poll(async () => {
        const diagnostics = await getEngineDiagnostics(context);
        return diagnostics.log.filter((entry) => entry.kind === 'chunk_end').length;
      }, { timeout: FINISH_TIMEOUT_MS }).toBeGreaterThanOrEqual(6);

      const readerEngineLog = (await getEngineDiagnostics(context)).log;
      const report = buildCorpusFlowReport({ readerEngineLog });
      const spokenText = report.chunkStarts.map((entry) => entry.speechText || '').join(' ');
      const endedIndices = new Set(report.chunkEnds.map((entry) => entry.chunkIndex));

      expect(extensionErrors).toEqual([]);
      expect(report.synthesisFailures, 'live arXiv PDF should not hit speech preload timeout').toHaveLength(0);
      expect(report.chunkStarts.length, 'live arXiv PDF should keep reading past the first preload window').toBeGreaterThanOrEqual(6);
      expect(report.chunkEnds.length, 'live arXiv PDF should complete at least six chunks smoothly').toBeGreaterThanOrEqual(6);
      for (let index = 0; index < 6; index += 1) {
        expect(endedIndices.has(index), `chunk ${index} should reach its end`).toBe(true);
      }
      expect(report.replayedChunkIndices, 'no chunk should replay during the live arXiv flow').toEqual([]);
      expect(report.missingChunkIndices.filter((index) => index < 6), 'no early arXiv chunk should be skipped').toEqual([]);
      expect(report.p95HandoffGapMs, 'live arXiv handoffs should stay smooth').toBeLessThan(500);
      // The live paper can revise its wording and heading presentation.
      const abstractIndex = spokenText.search(/\babstract[:.]\s+Users across enterprises/iu);
      const benchmarkIndex = spokenText.search(/\bExisting benchmarks (?:only )?tackle (?:only )?individual pieces/iu);
      expect(abstractIndex, 'the abstract should be narrated').toBeGreaterThanOrEqual(0);
      expect(benchmarkIndex, 'the benchmark discussion should follow the abstract').toBeGreaterThan(abstractIndex);
    } finally {
      await cleanup();
    }
  });
});

// These clean-read fixtures all use 1x playback; end callbacks may arrive late during native work.
function maxMediaClockHandoffGapMs({ chunkStarts, chunkEnds }) {
  return Math.max(0, ...chunkStarts.slice(1).map((start, index) => {
    const previous = chunkStarts[index];
    const end = chunkEnds[index];
    expect(end.chunkIndex).toBe(previous.chunkIndex);
    return ((start.t - start.mediaTime) - (previous.t - previous.mediaTime + end.mediaTime)) * 1000;
  }));
}

async function forceNoWebGpuAdapter(context) {
  await context.addInitScript(() => {
    const fakeGpu = {
      requestAdapter: async () => {
        throw new Error('No available adapters.');
      },
    };
    Object.defineProperty(Navigator.prototype, 'gpu', {
      configurable: true,
      get: () => fakeGpu,
    });
  });
}

function watchExtensionErrors(context, errors) {
  context.on('console', (message) => {
    if (message.type() === 'error') errors.push(formatExtensionError('console', message.location().url, message.text()));
  });
  context.on('weberror', (webError) => {
    const location = webError.location();
    errors.push(formatExtensionError('weberror', location.url, webError.error().message));
  });
}

function watchPageErrors(page, label, errors) {
  page.on('pageerror', (error) => {
    errors.push(`${label}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(formatExtensionError(label, message.location().url || page.url(), message.text()));
  });
}

function formatExtensionError(scope, url, message) {
  return `${scope}: ${url || 'unknown'}: ${message}`;
}

function maxChunkEndMediaTime(chunkEnds = []) {
  return chunkEnds.reduce((max, entry) => Math.max(max, Number(entry.mediaTime) || 0), 0);
}

function generatedAudioDecodeEvents(readerEngineLog = []) {
  return readerEngineLog.filter((entry) => (
    entry.channel === 'preload_decode_latency'
    || entry.kind === 'audio_preload_decode_latency'
    || entry.channel === 'decode_latency'
    || entry.kind === 'audio_decode_latency'
  ));
}

function browserFallbackEvents(readerEngineLog = []) {
  return readerEngineLog.filter((entry) => entry.kind === 'browser_voice_fallback');
}

async function getEngineDiagnostics(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  return worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))
    .then((response) => response || { log: [], hardwareProbe: null });
}

async function waitForEngineState(context, expected, timeout) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const pattern = expected instanceof RegExp ? expected : new RegExp(`^${expected}$`);
  await expect.poll(async () => {
    const snapshot = await worker.evaluate(() => chrome.storage.session.get('readerEngineState')
      .then((value) => value.readerEngineState || { state: 'idle' }));
    if (snapshot.state === 'error') {
      const target = await worker.evaluate(() => Promise.all([
        chrome.storage.local.get('readableTabTarget'),
        chrome.tabs.query({ active: true, currentWindow: true }),
      ]));
      throw new Error(`Reader engine failed: ${JSON.stringify({ snapshot, target })}`);
    }
    return snapshot.state;
  }, { timeout }).toMatch(pattern);
}
