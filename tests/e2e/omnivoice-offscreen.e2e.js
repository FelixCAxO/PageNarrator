import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import browserModels from '../fixtures/browser-speech-models.json' with { type: 'json' };

test('prepares OmniVoice and reads Swedish through the production offscreen host', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE !== '1', 'Requires pinned OmniVoice data and native WebGPU.');
  test.setTimeout(5 * 60_000);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html lang="sv"><title>Svenskt röstprov</title><article><p>Hej! Idag läser vi en kort berättelse om en lugn trädgård.</p></article></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  try {
    await routeOmniVoiceModelFiles(context);
    await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'omnivoice', language: 'sv', voice: 'af_heart', speed: 1 } });
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => chrome.storage.local.set({ voiceSetupPending: true }));
    const popup = await openExtensionPage(context, 'popup');
    // Chrome cannot route offscreen requests; replay the pinned data into the real cache first.
    await popup.evaluate(async manifest => {
      const cache = await caches.open('pagenarrator-omnivoice-v1');
      for (const file of manifest.files) {
        const url = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/${file.path}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Model data failed: ${file.path} (${response.status})`);
        await cache.put(url, response);
      }
    }, browserModels);
    await popup.locator('#popup-setup-start').click();
    const snapshot = () => worker.evaluate(() => chrome.storage.session.get('readerEngineState').then(value => value.readerEngineState));
    await expect.poll(async () => {
      const state = await snapshot();
      if (state?.modelSetup?.phase === 'error') throw new Error(JSON.stringify(state));
      return state?.modelSetup?.phase;
    }, { timeout: 90_000 }).toBe('ready');
    await expect(popup.locator('#popup-error')).toBeHidden();
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    expect(contexts).toHaveLength(1);
    expect(context.pages().filter(page => page.url().includes('reader-engine.html'))).toHaveLength(0);
    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${server.address().port}`);
    await startReadFromToolbarPopup(context, article);
    await expect.poll(async () => {
      const state = await snapshot();
      if (state?.state === 'error') throw new Error(JSON.stringify(state));
      return state?.state;
    }, { timeout: 120_000 }).toBe('finished');
    const flow = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    expect(flow.log.some(entry => entry.kind === 'chunk_end')).toBe(true);
    await testInfo.attach('offscreen-state', { body: JSON.stringify({ state: await snapshot(), contexts, flow }), contentType: 'application/json' });
  } finally {
    await cleanup();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
