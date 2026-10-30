import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import {
  launchExtensionContext,
  openCorpusArticle,
  openExtensionPage,
  seedFlowTestFlags,
  seedReadableTabTarget,
  seedRealTtsFlowFlags,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';
import { routeKokoroModelFiles, seedKokoroModelCache } from './kokoro-download-fixture.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const realTts = /^(1|true|yes)$/i.test(process.env.PN_E2E_REAL_MODEL || '');

for (const backgroundMode of ['switch tabs', 'minimize window']) {
  test(`narration completes across sections after ${backgroundMode}`, async ({}, testInfo) => {
    test.setTimeout(realTts ? 300_000 : 60_000);
    const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
    const { context, cleanup } = await launchExtensionContext({
      hostPermissions: ['http://*/*'], testInfo, backgroundThrottling: true,
    });
    try {
      if (realTts) {
        await routeKokoroModelFiles(context);
        await seedKokoroModelCache(context);
        await seedRealTtsFlowFlags(context, { playbackSettings: { voice: 'af_heart', language: 'en', speed: 3 } });
      } else await seedFlowTestFlags(context);
      const worker = context.serviceWorkers()[0];
      const snapshot = () => worker.evaluate(() => chrome.storage.session.get('readerEngineState')
        .then(result => result.readerEngineState));
      const flow = () => worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })
        .then(result => result?.log || []));
      const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
      const tabId = await seedReadableTabTarget(context, article);
      // Model a visual response held by background rendering until the source is visible again.
      await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
        globalThis.__pnDelayedHighlights = 0;
        const addListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
        chrome.runtime.onMessage.addListener = listener => addListener((message, sender, sendResponse) => listener(
          message, sender, response => {
            if (message?.type !== 'highlightChunk' || !document.hidden) return sendResponse(response);
            globalThis.__pnDelayedHighlights += 1;
            const resume = () => {
              if (document.hidden) return;
              document.removeEventListener('visibilitychange', resume);
              sendResponse(response);
            };
            document.addEventListener('visibilitychange', resume);
          },
        ));
      } }), tabId);
      const cdp = await context.newCDPSession(article);
      const popup = await openExtensionPage(context, 'popup');
      await popup.bringToFront();
      await seedReadableTabTarget(context, article);
      await popup.locator('#start-reading').click();
      await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: realTts ? 180_000 : 15_000 });
      await popup.close();
      await article.bringToFront();
      await expect.poll(async () => (await flow()).filter(entry => entry.kind === 'chunk_play').length,
        { timeout: realTts ? 180_000 : 5_000 }).toBeGreaterThan(0);
      const playedBefore = (await flow()).filter(entry => entry.kind === 'chunk_play').length;

      if (backgroundMode === 'switch tabs') {
        const other = await context.newPage();
        await other.goto('about:blank');
        await other.bringToFront();
      } else {
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        expect((await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState).toBe('minimized');
      }
      await expect.poll(() => article.evaluate(() => document.hidden)).toBe(true);
      await expect.poll(async () => {
        const state = await snapshot();
        if (state?.state === 'error') throw new Error(JSON.stringify(state));
        return state?.state;
      }, { timeout: realTts ? 180_000 : 35_000 }).toBe('finished');
      const log = await flow();
      const played = log.filter(entry => entry.kind === 'chunk_play');
      const ended = log.filter(entry => entry.kind === 'chunk_end');
      expect(played.length).toBeGreaterThan(playedBefore);
      expect(ended.map(entry => entry.chunkIndex)).toEqual(played.map(entry => entry.chunkIndex));
      expect(ended.every(entry => entry.mediaTime > 0)).toBe(true);
      expect(log.filter(entry => entry.kind === 'synthesis_failed')).toEqual([]);
      const handoffGapsMs = played.slice(1).map((entry, index) => (entry.t - ended[index].t) * 1000);
      await writeFile(testInfo.outputPath('handoff-gaps.json'), JSON.stringify({ backgroundMode, realTts, handoffGapsMs }, null, 2));
      // A background highlight reply times out after 500 ms; speech must not wait for it.
      expect(Math.max(...handoffGapsMs)).toBeLessThan(400);
      const delayedHighlights = await worker.evaluate(id => chrome.scripting.executeScript({
        target: { tabId: id }, func: () => globalThis.__pnDelayedHighlights,
      }).then(results => results[0].result), tabId);
      expect(delayedHighlights).toBeGreaterThan(0);
      await testInfo.attach('background-playback', {
        body: JSON.stringify({ backgroundMode, delayedHighlights, state: await snapshot(), log }), contentType: 'application/json',
      });
    } finally {
      await cleanup();
      await server.close();
    }
  });
}
