import { chromium, expect, test } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';
import {
  launchExtensionContext,
  openExtensionPage,
  openPdfViewer,
  seedReadableTabTarget,
  seedRealTtsFlowFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { KOKORO_DOWNLOAD_PREFIX, openRoutedReaderEngine, routeKokoroModelFiles } from './kokoro-download-fixture.js';

const RUN_REAL_MODEL = /^(1|true|yes)$/i.test(process.env.PN_E2E_REAL_MODEL || '');
const LIVE_MODEL_DOWNLOAD = /^(1|true|yes)$/i.test(process.env.PN_E2E_LIVE_MODEL_DOWNLOAD || '');
const playbackSettings = {
  language: 'en', voice: 'af_heart', speed: 3, sectionPauseSeconds: 0,
  ttsBackendPreference: 'wasm', ttsPerformanceProfile: 'quality',
};

test('does not download voices while idle and offers retry after an uncached offline setup', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    const downloads = await routeKokoroModelFiles(context);
    downloads.setOffline(true);
    await seedRealTtsFlowFlags(context, { playbackSettings });
    await openRoutedReaderEngine(context);
    const popup = await openExtensionPage(context, 'popup');
    await expect(popup.locator('#popup-voice option')).toHaveCount(10);
    await expect(popup.locator('#popup-setup-start')).toBeVisible();
    // Allow the popup's initial state synchronization and the engine's idle work.
    await popup.waitForTimeout(1_000);
    expect(downloads.requests).toEqual([]);
    expect(await cachedModelUrls(popup)).toEqual([]);

    await context.setOffline(true);
    await popup.locator('#popup-setup-start').click();
    await expect(popup.locator('#popup-setup-start')).toHaveText('Retry', { timeout: 30_000 });
    expect(downloads.requests.length).toBeGreaterThan(0);
    expect(downloads.requests.every((url) => url.startsWith(KOKORO_DOWNLOAD_PREFIX))).toBe(true);
    expect(await cachedModelUrls(popup)).toEqual([]);
    const failedRequestCount = downloads.requests.length;

    await popup.locator('#popup-setup-start').click();
    await expect.poll(() => downloads.requests.length).toBeGreaterThan(failedRequestCount);
    await expect(popup.locator('#popup-setup-start')).toHaveText('Retry', { timeout: 30_000 });
  } finally {
    await cleanup();
  }
});

test('downloads a voice, survives an offline browser restart, and recovers after cache deletion', async ({}, testInfo) => {
  test.skip(!RUN_REAL_MODEL, 'Set PN_E2E_REAL_MODEL=1 for real synthesis with fixture-replayed model downloads; add PN_E2E_LIVE_MODEL_DOWNLOAD=1 for genuine Hugging Face downloads.');
  test.setTimeout(8 * 60_000);
  const launched = await launchExtensionContext({ testInfo });
  const { context, cleanup } = launched;
  let restartedContext;
  try {
    const downloads = await routeKokoroModelFiles(context, { live: LIVE_MODEL_DOWNLOAD });
    const remoteCodeRequests = [];
    const trackRemoteCode = (request) => {
      if (/^https?:/.test(request.url()) && /\.(?:wasm|m?js)(?:[?#]|$)/.test(request.url())) {
        remoteCodeRequests.push(request.url());
      }
    };
    context.on('request', trackRemoteCode);
    await seedRealTtsFlowFlags(context, { playbackSettings });
    let engine = await openRoutedReaderEngine(context);
    const popup = await openExtensionPage(context, 'popup');
    await expect(popup.locator('#popup-setup-start')).toBeVisible();
    expect(await cachedModelUrls(popup)).toEqual([]);
    expect(downloads.requests).toEqual([]);

    downloads.setOffline(true);
    await context.setOffline(true);
    await popup.locator('#popup-setup-start').click();
    await expect(popup.locator('#popup-setup-start')).toHaveText('Retry', { timeout: 30_000 });
    expect(await cachedModelUrls(popup)).toEqual([]);
    downloads.setOffline(false);
    await context.setOffline(false);
    await popup.locator('#popup-setup-start').click();
    await expect(popup.locator('#popup-setup')).toBeHidden({ timeout: 4 * 60_000 });
    expect(downloads.requests.some((url) => url.endsWith('/onnx/model_quantized.onnx'))).toBe(true);
    expect(downloads.requests.some((url) => url.endsWith('/onnx/model.onnx'))).toBe(false);
    expect([...new Set(downloads.requests.filter((url) => url.includes('/voices/')))])
      .toEqual([`${KOKORO_DOWNLOAD_PREFIX}voices/af_heart.bin`]);
    const cacheUrls = await cachedModelUrls(popup);
    expect(cacheUrls).toContain(`${KOKORO_DOWNLOAD_PREFIX}onnx/model_quantized.onnx`);
    expect(cacheUrls).toContain(`${KOKORO_DOWNLOAD_PREFIX}voices/af_heart.bin`);
    await popup.close();

    const pdf = await openPdfViewer(context, 'single-column.pdf');
    await expect(pdf.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 30_000 });
    await startReadFromToolbarPopup(context, pdf);
    const first = await waitForFinishedAudio(context);
    expect(first.audioEvents).toBeGreaterThan(0);

    await context.close();
    restartedContext = await chromium.launchPersistentContext(launched.userDataDir, {
      channel: 'chromium',
      headless: !/^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || ''),
      args: [
        '--mute-audio',
        `--disable-extensions-except=${launched.extensionDir}`,
        `--load-extension=${launched.extensionDir}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    restartedContext.on('request', trackRemoteCode);
    const offlineDownloads = await routeKokoroModelFiles(restartedContext, { live: LIVE_MODEL_DOWNLOAD });
    offlineDownloads.setOffline(true);
    await restartedContext.setOffline(true);
    const worker = restartedContext.serviceWorkers()[0] || await restartedContext.waitForEvent('serviceworker');
    // Command-line loading reports install again; a normal browser restart keeps setup complete.
    await worker.evaluate((key) => chrome.storage.local.remove(key), STORAGE_KEYS.VOICE_SETUP_PENDING);
    engine = await openRoutedReaderEngine(restartedContext);
    // Context offline emulation misses a fresh extension renderer after restart.
    const network = await restartedContext.newCDPSession(engine);
    await network.send('Network.enable');
    await network.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    expect(await engine.evaluate(() => navigator.onLine)).toBe(false);

    const offlinePdf = await openPdfViewer(restartedContext, 'single-column.pdf');
    await expect(offlinePdf.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 30_000 });
    await startReadFromToolbarPopup(restartedContext, offlinePdf);
    const second = await waitForFinishedAudio(restartedContext);
    expect(second.audioEvents).toBeGreaterThan(0);
    expect(offlineDownloads.requests, 'cached model and voice should not retry any remote request after browser restart').toEqual([]);
    expect(remoteCodeRequests, 'executable JavaScript and WASM must stay inside the extension').toEqual([]);

    await engine.evaluate(async () => {
      await caches.delete('transformers-cache');
      await caches.delete('kokoro-voices');
    });
    expect(await cachedModelUrls(engine)).toEqual([]);
    await engine.close();
    engine = await openRoutedReaderEngine(restartedContext);
    const clearedNetwork = await restartedContext.newCDPSession(engine);
    await clearedNetwork.send('Network.enable');
    await clearedNetwork.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    expect(await engine.evaluate(() => navigator.onLine)).toBe(false);
    // Closing the engine releases its PDF session; load a fresh local document.
    await offlinePdf.close();
    const clearedPdf = await openPdfViewer(restartedContext, 'single-column.pdf');
    await expect(clearedPdf.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 30_000 });
    await seedReadableTabTarget(restartedContext, clearedPdf, { allowActiveExtensionTab: true });
    const clearedPopup = await openExtensionPage(restartedContext, 'popup');
    await clearedPopup.locator('#start-reading').click();
    await expect(clearedPopup.locator('#popup-setup-start')).toHaveText('Retry', { timeout: 30_000 });
    expect(offlineDownloads.requests.length).toBeGreaterThan(0);
    expect(await cachedModelUrls(clearedPopup)).toEqual([]);

    offlineDownloads.setOffline(false);
    await restartedContext.setOffline(false);
    await clearedNetwork.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await clearedPopup.locator('#popup-setup-start').click();
    await expect(clearedPopup.locator('#popup-setup')).toBeHidden({ timeout: 4 * 60_000 });
    expect(await cachedModelUrls(clearedPopup)).toContain(`${KOKORO_DOWNLOAD_PREFIX}onnx/model_quantized.onnx`);
    expect(await cachedModelUrls(clearedPopup)).toContain(`${KOKORO_DOWNLOAD_PREFIX}voices/af_heart.bin`);
    await clearedPopup.close();
    await startReadFromToolbarPopup(restartedContext, clearedPdf);
    const recovered = await waitForFinishedAudio(restartedContext);
    expect(recovered.audioEvents).toBeGreaterThan(0);
    expect(remoteCodeRequests, 'redownloading missing model data must not download executable code').toEqual([]);
    console.log(`[on-demand-voice] ${JSON.stringify({
      downloadSource: LIVE_MODEL_DOWNLOAD ? 'live-hugging-face' : 'fixture-replayed-network',
      runtime: 'production-engine-in-extension-tab',
      requestedFiles: [...new Set(downloads.requests)],
      cachedFiles: cacheUrls.length,
      firstAudioEvents: first.audioEvents,
      offlineAudioEvents: second.audioEvents,
      offlineBrowserRestart: true,
      cacheClearedRecoveryAudioEvents: recovered.audioEvents,
    })}`);
  } finally {
    await restartedContext?.close();
    await cleanup();
  }
});

async function cachedModelUrls(page) {
  return page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        if (request.url.includes('/Kokoro-82M-v1.0-ONNX/')) urls.push(request.url);
      }
    }
    return urls;
  });
}

async function waitForFinishedAudio(context) {
  const worker = context.serviceWorkers()[0];
  await expect.poll(async () => {
    const snapshot = await worker.evaluate(() => chrome.storage.session.get('readerEngineState')
      .then((value) => value.readerEngineState || {}));
    if (snapshot.state === 'error') throw new Error(`Narration failed: ${JSON.stringify(snapshot)}`);
    return snapshot.state;
  }, { timeout: 3 * 60_000 }).toBe('finished');
  const { log = [] } = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
  expect(log.filter((entry) => entry.kind === 'synthesis_failure')).toEqual([]);
  expect(log.filter((entry) => entry.kind === 'browser_voice_fallback')).toEqual([]);
  return { audioEvents: log.filter((entry) => ['preload_decode_latency', 'decode_latency'].includes(entry.channel)
    || ['audio_preload_decode_latency', 'audio_decode_latency'].includes(entry.kind)).length };
}
