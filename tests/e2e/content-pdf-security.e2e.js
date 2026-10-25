import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  getExtensionId,
  launchExtensionContext,
  openCorpusArticle,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';

async function fixturePdfUrl() {
  const bytes = await readFile('tests/fixtures/pdfs/single-column.pdf');
  return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

test('blocks web-origin PDF viewer framing and private runtime resource reads', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    const id = await getExtensionId(context);
    const origin = `chrome-extension://${id}`;
    const privateResources = ['src/pdf-viewer.html', 'assets/pdf-engine/pdf.wasm', 'native/kokoro-engine.wasm', 'voice-packs/selected-manifest.json'];
    const internalReads = await context.serviceWorkers()[0].evaluate(async (paths) => Promise.all(paths.map(async (resource) => {
      const response = await fetch(chrome.runtime.getURL(resource));
      await response.body?.cancel();
      return response.ok;
    })), privateResources);
    expect(internalReads).toEqual(privateResources.map(() => true));
    const viewerUrl = `${origin}/src/pdf-viewer.html?src=${encodeURIComponent(await fixturePdfUrl())}`;
    await context.route('https://attacker.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Untrusted web page</title><iframe src="${viewerUrl}"></iframe>`,
    }));
    const page = await context.newPage();
    await page.goto('https://attacker.test/');
    const reads = await page.evaluate(async ({ extensionOrigin, paths }) => Promise.all(paths.map(async (resource) => {
      try {
        const response = await fetch(`${extensionOrigin}/${resource}`);
        await response.body?.cancel();
        return { resource, readable: response.ok };
      } catch {
        return { resource, readable: false };
      }
    })), { extensionOrigin: origin, paths: privateResources });
    const result = {
      privilegedFrames: page.frames().filter((frame) => frame.url().startsWith(origin)).length,
      reads,
    };
    await testInfo.attach('web-origin-boundary.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result).toEqual({
      privilegedFrames: 0,
      reads: privateResources.map((resource) => ({ resource, readable: false })),
    });
  } finally {
    await cleanup();
  }
});

test('retains trusted extension PDF navigation, extraction, and teardown', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    const id = await getExtensionId(context);
    const worker = context.serviceWorkers()[0];
    const viewerUrl = `chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(await fixturePdfUrl())}`;
    const pagePromise = context.waitForEvent('page');
    const tab = await worker.evaluate((url) => chrome.tabs.create({ url, active: true }), viewerUrl);
    const page = await pagePromise;
    await expect(page.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 15_000 });
    const metadata = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata' }), tab.id);
    expect(metadata).toMatchObject({ ok: true, pageCount: 1 });
    const chunk = await worker.evaluate(({ tabId, instanceToken }) => chrome.tabs.sendMessage(tabId, {
      type: 'getPdfChunk', streamId: 'trusted-security-test', instanceToken,
    }), { tabId: tab.id, instanceToken: metadata.instanceToken });
    expect(chunk.value.speech).toContain('PageNarrator single column fixture');
    expect(await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'tearDownPdfViewer' }), tab.id)).toEqual({ ok: true });
    await expect(page.locator('.pdf-page')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('denies native content-script storage, controls, state, RPC, and flow-log access', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: new URL('./fixtures/', import.meta.url) });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://127.0.0.1/*'], testInfo });
  try {
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    const worker = context.serviceWorkers()[0];
    const targetTab = await worker.evaluate(async (url) => {
      await chrome.storage.local.set({ securityProbeSentinel: 'private-extension-setting' });
      globalThis.__pnSecuritySenders = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message.securityProbe) globalThis.__pnSecuritySenders.push({
          type: message.type, id: sender.id, url: sender.url, origin: sender.origin, frameId: sender.frameId,
        });
        return false;
      });
      return (await chrome.tabs.query({})).find((tab) => tab.url === url);
    }, article.url());
    expect(targetTab.id).toEqual(expect.any(Number));

    const probe = (requests) => worker.evaluate(async ({ tabId, messages }) => {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async (commands) => {
          const capture = async (operation) => {
            try { return { rejected: false, value: await operation() ?? null }; }
            catch (error) { return { rejected: true, value: null, error: String(error.message || error) }; }
          };
          const storage = await capture(() => chrome.storage.local.get('securityProbeSentinel'));
          const messages = [];
          for (const message of commands) messages.push({
            type: message.type,
            ...await capture(() => chrome.runtime.sendMessage({ ...message, securityProbe: true })),
          });
          return { storage, messages };
        },
        args: [messages],
      });
      return injection.result;
    }, { tabId: targetTab.id, messages: requests });

    const dataRequests = [
      { type: 'readerEngineGetState' },
      { type: 'readerEngineRpc', operation: 'storage.local.get', args: ['securityProbeSentinel'] },
      { type: 'getFlowLog' },
    ];
    const idleProbe = await probe([
      { type: 'readerEngineActionRequest', action: { type: 'togglePlayback' }, tab: { id: targetTab.id, url: article.url() } },
      ...dataRequests,
    ]);
    await writeFile(testInfo.outputPath('isolated-world-idle-probe.json'), JSON.stringify(idleProbe, null, 2));
    await testInfo.attach('isolated-world-idle-probe.json', { body: JSON.stringify(idleProbe, null, 2), contentType: 'application/json' });
    expect(idleProbe.storage).toMatchObject({ rejected: true, value: null, error: expect.stringMatching(/access.*storage|storage.*access/i) });
    expect(idleProbe.messages.map(({ rejected, value }) => ({ rejected, value })))
      .toEqual(Array.from({ length: 4 }, () => ({ rejected: false, value: null })));
    expect(await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).toEqual([]);

    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
    await expect(popup.locator('#popup-toggle')).toHaveText('Pause', { timeout: 15_000 });
    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Paused');
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'readerEngineGetState' }))).toMatchObject({ state: 'paused' });

    const pausedProbe = await probe([
      { type: 'readerEngineActionRequest', action: { type: 'stop' } },
      { type: 'readerEngineAction', action: { type: 'stop' } },
      ...dataRequests,
    ]);
    const senders = await worker.evaluate(() => globalThis.__pnSecuritySenders);
    await writeFile(testInfo.outputPath('isolated-world-paused-probe.json'), JSON.stringify({ ...pausedProbe, senders }, null, 2));
    await testInfo.attach('isolated-world-paused-probe.json', { body: JSON.stringify({ ...pausedProbe, senders }, null, 2), contentType: 'application/json' });
    expect(pausedProbe.storage).toMatchObject({ rejected: true, value: null });
    expect(pausedProbe.messages.map(({ rejected, value }) => ({ rejected, value })))
      .toEqual(Array.from({ length: 5 }, () => ({ rejected: false, value: null })));
    expect(senders).toHaveLength(9);
    const extensionId = await getExtensionId(context);
    for (const sender of senders) expect(sender).toMatchObject({
      id: extensionId, url: article.url(), origin: server.origin, frameId: 0,
    });
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'readerEngineGetState' }))).toMatchObject({ state: 'paused' });
    await expect(popup.locator('#popup-status')).toHaveText('Paused');
    await popup.locator('#popup-stop').click();
    await expect(popup.locator('#popup-status')).toHaveText('Ready to read');
  } finally {
    await cleanup();
    await server.close();
  }
});
