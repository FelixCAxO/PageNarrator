import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  launchExtensionContext,
  openCorpusArticle,
  recordPlaybackEvents,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';
import {
  buildCorpusContentReport,
  buildCorpusFlowReport,
} from './corpus-flow-invariants.js';

// Authored public fixtures or explicit private captures are flow inputs, not held-out site quality.
const configuredCorpusDir = process.env.PN_E2E_CORPUS_DIR;
if (configuredCorpusDir !== undefined && !configuredCorpusDir.trim()) {
  throw new Error('PN_E2E_CORPUS_DIR must name a directory containing private HTML flow inputs.');
}
const corpusDir = configuredCorpusDir === undefined
  ? fileURLToPath(new URL('./corpus/', import.meta.url)) : path.resolve(configuredCorpusDir);
const corpusGoldDir = path.join(corpusDir, 'gold');
const corpusSlugs = readdirSync(corpusDir)
  .filter((name) => name.endsWith('.html'))
  .sort();
if (!corpusSlugs.length) throw new Error('The corpus directory contains no HTML flow inputs; no test pass is implied.');

test.describe.configure({ mode: 'parallel' });

test.describe('offline corpus flow invariants', () => {
  let server;

  test.beforeAll(async () => {
    server = await startCorpusFixtureServer({ corpusDir });
  });

  test.afterAll(async () => {
    await server?.close();
  });

  for (const slug of corpusSlugs) {
    test(`${slug} preserves speech flow invariants`, async () => {
      const { context, cleanup } = await launchExtensionContext({
        hostPermissions: ['http://*/*'],
      });
      try {
        await seedFlowTestFlags(context);
        const articlePage = await openCorpusArticle(context, server, slug);
        await startReadFromToolbarPopup(context, articlePage);
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const getState = () => worker.evaluate(() => chrome.storage.session.get('readerEngineState')
          .then((value) => value.readerEngineState?.state || 'idle'));
        await expect.poll(getState, { timeout: 30_000 }).toMatch(/reading|finished/);
        await expect.poll(getState, { timeout: 60_000 }).toBe('finished');

        const readerEngineLog = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })
          .then((response) => response?.log || []));
        const pageLog = await recordPlaybackEvents(articlePage, context);
        const report = buildCorpusFlowReport({ readerEngineLog, pageLog });
        const contentReport = buildCorpusContentReport({
          readerEngineLog,
          gold: loadCorpusGold(slug),
        });

        expect(report.synthesisFailures, 'silent TTS should not fail synthesis').toHaveLength(0);
        expect(report.chunksExtracted, 'corpus run should record extracted chunks').toBeGreaterThan(0);
        expect(report.chunksSpoken, 'chunksSpoken should equal chunksExtracted').toBe(report.chunksExtracted);
        expect(report.missingChunkIndices, 'no extracted chunks should be silently dropped').toEqual([]);
        expect(report.unendedChunkIndices, 'every spoken chunk should end').toEqual([]);
        expect(report.p95HandoffGapMs, 'p95 chunk handoff gap').toBeLessThan(20);
        expect(report.decodeLatencyP95Ms, 'p95 audio playback-start latency').toBeLessThan(50);
        expect(report.preloadDecodeLatencyP95Ms, 'p95 preloaded audio decode latency').toBeLessThan(1000);
        expect(report.replayedChunkIndices, 'no chunk should be replayed during a clean read').toEqual([]);
        expect(report.maxConsecutiveShortChunks, 'short chunks should be merged before they create audible holes').toBeLessThan(5);
        expect(report.wordEvents, 'corpus run should record word highlight events').not.toHaveLength(0);
        expect(report.wordEventsMissingTokens, 'word events should include speech and DOM tokens').toHaveLength(0);
        expect(report.wordEvents.length, 'each spoken chunk should emit at least one word highlight').toBeGreaterThanOrEqual(report.chunksSpoken);
        expect(report.tokenMismatches, 'spoken token should equal highlighted DOM token').toEqual([]);
        expect(contentReport.forbiddenSpokenChunks, 'share/icon/widget text should not be spoken').toEqual([]);
        if (contentReport.goldTextCount > 0) {
          expect(contentReport.mainTextRecall, 'gold main text recall').toBe(1);
          expect(contentReport.missingGoldText, 'gold main text should remain audible').toEqual([]);
        }
      } finally {
        await cleanup();
      }
    });
  }
});

function loadCorpusGold(slug) {
  const goldPath = `${corpusGoldDir}/${slug.replace(/\.html$/u, '.json')}`;
  if (!existsSync(goldPath)) return null;
  return JSON.parse(readFileSync(goldPath, 'utf8'));
}
