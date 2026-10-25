import { expect, test } from '@playwright/test';
import {
  launchExtensionContext, openPdfViewer, seedHardwareProfile,
  seedRealTtsFlowFlags, startReadFromToolbarPopup,
} from './extension-fixture.js';
import { openRoutedReaderEngine, routeKokoroModelFiles } from './kokoro-download-fixture.js';
import { buildCorpusFlowReport } from './corpus-flow-invariants.js';

test('real US female, US male and UK voices retain word timing through PDF playback', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_REAL_MODEL !== '1', 'Set PN_E2E_REAL_MODEL=1 to run real local Kokoro inference.');
  test.setTimeout(5 * 60_000);
  const { context, cleanup } = await launchExtensionContext();
  const results = [];
  try {
    await routeKokoroModelFiles(context);
    const settings = { language: 'en', voice: 'af_heart', speed: 0.5, sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality', ttsBackendPreference: 'wasm' };
    await seedHardwareProfile(context, { name: 'word-sync', navigator: {}, playbackSettings: settings }, { enableProbe: true, recordFlow: true });
    const engine = await openRoutedReaderEngine(context);
    const worker = context.serviceWorkers()[0];
    for (const [voice, speed, profile] of [
      ['af_heart', 1, 'lowPower'], ['af_heart', 0.5, 'quality'], ['am_michael', 1, 'quality'], ['bf_emma', 3, 'quality'],
    ]) {
      await seedRealTtsFlowFlags(context, { playbackSettings: { ...settings, voice, speed, ttsPerformanceProfile: profile } });
      await expect(engine.locator('#voice-select')).toHaveValue(voice);
      const pdf = await openPdfViewer(context, 'single-column.pdf');
      await expect(pdf.locator('#pdf-status')).toContainText('1 page loaded');
      // Observe rendered CSS ranges against the production audio-clock messages.
      // The PDF viewer does not publish the content script's word-event log.
      await pdf.evaluate(() => {
        let plan = [], clock = null, lead = 0;
        window.__syncSamples = [];
        window.__syncMessages = [];
        chrome.runtime.onMessage.addListener((message) => {
          if (['highlightChunk', 'highlightWordPlan', 'clearHighlight'].includes(message.type)) window.__syncMessages.push(message);
          if (message.type === 'highlightWordPlan') { plan = message.plan; lead = message.leadSeconds || 0; }
          if (['highlightWordPlan', 'highlightPlanResync'].includes(message.type)) clock = { ...message, receivedAt: Date.now() };
          if (message.type === 'clearHighlight') clock = null;
        });
        const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        setInterval(() => {
          if (!clock || clock.paused) return;
          const marked = [...(CSS.highlights.get('pagenarrator-word-0') || [])].map((range) => range.toString()).join('');
          if (!marked) return;
          const time = clock.currentTime + (Date.now() - (clock.sentAtEpochMs || clock.receivedAt)) / 1000 * clock.playbackRate;
          const matches = plan.filter((entry) => normalize(entry.text || '') === normalize(marked));
          const error = Math.min(...matches.map((entry) => Math.max(0, entry.start - lead - time, time - (entry.end - lead)) / clock.playbackRate));
          window.__syncSamples.push({ marked, time, error });
        }, 20);
      });
      await startReadFromToolbarPopup(context, pdf);
      let diagnostics, samples;
      try {
        // The previous run can still report "finished" while the new read starts.
        await pdf.waitForFunction(() => window.__syncMessages.some(({ type }) => type === 'highlightChunk'), null, { timeout: 180_000 });
        await expect.poll(async () => {
          const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
          if (state.state === 'error') throw new Error(`Voice ${voice} failed: ${JSON.stringify(state)}`);
          return state.state;
        }, { timeout: 180_000 }).toBe('finished');
      } finally {
        diagnostics = await worker.evaluate(async () => ({
          ...await chrome.runtime.sendMessage({ type: 'getFlowLog' }),
          state: await chrome.storage.session.get('readerEngineState'),
        }));
        samples = await pdf.evaluate(() => window.__syncSamples);
        const messages = await pdf.evaluate(() => window.__syncMessages);
        await testInfo.attach(`${voice}-${profile}-diagnostics`, {
          body: JSON.stringify({ voice, speed, profile, samples, messages, diagnostics }, null, 2), contentType: 'application/json',
        });
      }
      const report = buildCorpusFlowReport({ readerEngineLog: diagnostics.log });
      expect(report.synthesisFailures).toEqual([]);
      expect(new Set(samples.map(({ marked }) => marked)).size).toBeGreaterThan(5);
      const mismatches = samples.filter(({ error }) => error === null || error > 0.12);
      expect(mismatches).toEqual([]);
      expect(report.chunksSpoken).toBe(report.chunksExtracted);
      expect(diagnostics.hardwareProbe.timingSources.phonemeEstimated).toBeGreaterThan(0);
      results.push({ voice, speed, profile, samples: samples.length, maxClockErrorMs: Math.max(...samples.map(({ error }) => error)) * 1000, mismatches: mismatches.length, timingSources: diagnostics.hardwareProbe.timingSources });
      await pdf.close();
    }
    await testInfo.attach('voice-word-sync', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(results));
  } finally {
    await cleanup();
  }
});
