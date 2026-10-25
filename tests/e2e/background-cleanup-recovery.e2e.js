import { chromium, expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getExtensionId, launchExtensionContext, openCorpusArticle, openExtensionPage,
  resolveExtensionDir, seedFlowTestFlags, startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';

test('a failed retirement cleanup permits playback and retries after the worker restarts', async ({}, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagenarrator-cleanup-recovery-'));
  const extensionDir = path.join(root, 'extension');
  const server = await startCorpusFixtureServer({ corpusDir: fileURLToPath(new URL('./fixtures/', import.meta.url)) });
  let cleanup = async () => {};
  let restartedContext;
  try {
    await cp(resolveExtensionDir({ testInfo }), extensionDir, { recursive: true });
    // Fault setup runs before the original background code in this disposable copy.
    const backgroundPath = path.join(extensionDir, 'assets/background.js.js');
    await writeFile(backgroundPath, `
      const pnFixtureDelete = caches.delete.bind(caches);
      const pnFixtureReady = chrome.storage.local.get('pnCleanupFaultInjected').then(async (saved) => {
        if (saved.pnCleanupFaultInjected) return false;
        await chrome.storage.local.set({ pnCleanupFaultInjected: true, 'byoVoiceConfigs.v1': [{ sourceUri: 'https://voice.example.test/tts', apiKey: 'retired-secret' }] });
        await (await caches.open('pagenarrator-local-voice-models-v1')).put('https://pagenarrator.invalid/retired', new Response('retired model'));
        return true;
      });
      caches.delete = async (name) => {
        if (await pnFixtureReady) throw new Error('Injected retirement cache failure');
        return pnFixtureDelete(name);
      };
    ` + await readFile(backgroundPath, 'utf8'));
    const launched = await launchExtensionContext({ extensionDir, hostPermissions: ['http://*/*'], testInfo });
    cleanup = launched.cleanup;
    const { context } = launched;
    const extensionId = await getExtensionId(context);
    const popup = await openExtensionPage(context, 'popup');
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'readerEngineGetState' }))).toEqual({ state: 'idle' });
    expect(await popup.evaluate(() => chrome.permissions.getAll().then((permissions) => permissions.origins))).toEqual(['http://*/*']);
    expect(await popup.evaluate(async () => Boolean((await chrome.storage.local.get('byoVoiceConfigs.v1'))['byoVoiceConfigs.v1']))).toBe(true);
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    const player = await startReadFromToolbarPopup(context, article, { closePopup: false });
    await expect(player.locator('#popup-status')).toHaveText('Reading');
    await player.locator('#popup-stop').click();
    await expect(player.locator('#popup-status')).toHaveText('Ready to read');
    await player.close();
    await popup.close();

    await context.close();
    restartedContext = await chromium.launchPersistentContext(launched.userDataDir, {
      channel: 'chromium',
      headless: !/^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || ''),
      args: ['--mute-audio', `--disable-extensions-except=${launched.extensionDir}`, `--load-extension=${launched.extensionDir}`],
    });
    const restartedPopup = await restartedContext.newPage();
    await restartedPopup.goto(`chrome-extension://${extensionId}/src/popup.html`);
    expect(await restartedPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'readerEngineGetState' }))).toEqual({ state: 'idle' });
    await expect.poll(() => restartedPopup.evaluate(async () => ({
      configs: (await chrome.storage.local.get('byoVoiceConfigs.v1'))['byoVoiceConfigs.v1'] ?? null,
      cache: await caches.has('pagenarrator-local-voice-models-v1'),
    }))).toEqual({ configs: null, cache: false });
  } finally {
    await restartedContext?.close();
    await cleanup();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
