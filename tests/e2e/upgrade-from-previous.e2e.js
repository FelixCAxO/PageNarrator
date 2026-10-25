import { chromium, expect, test } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_HOOKS_STORAGE_KEY,
  TEST_RECORD_FLOW_STORAGE_KEY,
  TEST_SILENT_TTS_STORAGE_KEY,
} from '../../src/lib/extension-test-flags.js';
import { MESSAGE_TYPES } from '../../src/lib/message-types.js';
import { STORAGE_KEYS, getResumePositionStorageKey } from '../../src/lib/storage-keys.js';
import { openCorpusArticle, resolveExtensionDir, startReadFromToolbarPopup } from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';

// Store users update in place: same extension ID, same profile storage, new package.
// Opt in with an unpacked build of the release being replaced, e.g. the published 1.0.2:
//   PN_E2E_PREVIOUS_EXTENSION_DIR=<dir> npx playwright test tests/e2e/upgrade-from-previous.e2e.js
// Add PN_E2E_REAL_MODEL=1 to narrate with the bundled Kokoro model instead of silent test speech.
const PREVIOUS_DIR = process.env.PN_E2E_PREVIOUS_EXTENSION_DIR || '';
const RUN_REAL_MODEL = /^(1|true|yes)$/i.test(process.env.PN_E2E_REAL_MODEL || '');
const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const ARTICLE = 'playback-controls-long.html';

for (const retiredVoice of [false, true]) {
test(`an in-place update keeps settings and progress and still reads (${retiredVoice ? 'retired custom voice' : 'built-in voice'})`, async ({}, testInfo) => {
  test.skip(!PREVIOUS_DIR, 'Set PN_E2E_PREVIOUS_EXTENSION_DIR to an unpacked previous release to test the Store update path.');
  test.setTimeout(RUN_REAL_MODEL ? 12 * 60_000 : 4 * 60_000);

  const root = await mkdtemp(path.join(tmpdir(), 'pagenarrator-upgrade-'));
  // One unpacked path gives both versions the same extension ID, like a Store update.
  const extensionDir = path.join(root, 'extension');
  const profileDir = path.join(root, 'profile');
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const previousErrors = { uncaught: [], console: [] };
  const errors = { uncaught: [], console: [] };
  let context = null;
  try {
    await installUnpacked(PREVIOUS_DIR, extensionDir);
    context = await launch(profileDir, extensionDir, previousErrors);
    const previous = await extensionInfo(context);
    const articleUrl = server.urlFor(ARTICLE);

    // Settings go through the previous release's own popup and storage code.
    const oldPopup = await context.newPage();
    await oldPopup.goto(`chrome-extension://${previous.id}/src/popup.html`);
    await oldPopup.waitForFunction(() => document.getElementById('popup-voice')?.options?.length > 1, null, { timeout: 30_000 });
    const emma = await oldPopup.locator('#popup-voice option').evaluateAll((options) => (
      options.map((option) => option.value).find((value) => /emma/i.test(value))
    ));
    expect(emma, 'the previous release offers the British Emma voice').toBeTruthy();
    await oldPopup.locator('#popup-settings > summary').click();
    // The production guard accepts trusted native input, so use the actual controls.
    await oldPopup.locator('#popup-voice').focus();
    await oldPopup.locator('#popup-voice').press('End');
    await oldPopup.locator('#popup-voice').press('Enter');
    await oldPopup.locator('#popup-speed').focus();
    await oldPopup.locator('#popup-speed').press('Home');
    for (let step = 0; step < 20; step += 1) await oldPopup.locator('#popup-speed').press('ArrowRight');
    await expect.poll(() => readStorage(context, STORAGE_KEYS.PLAYBACK_SETTINGS), { timeout: 15_000 })
      .toMatchObject({ voice: emma, speed: 1.5 });

    // Saved progress and downloaded-voice records need a Pro license or a model download in the
    // previous release; write them in that release's formats (createResumePosition, model-cache).
    await writeStorage(context, {
      [getResumePositionStorageKey(articleUrl)]: {
        chunk: 1,
        totalChunks: 3,
        progressPercent: 33,
        excerpt: 'This fixture keeps silent test speech active long enough for playback controls to remain visible after reading begins.',
        title: 'Playback controls long article',
        ts: Date.now(),
      },
      [STORAGE_KEYS.INSTALLED_VOICE_IDS]: ['af_heart'],
      ...(retiredVoice ? {
        [STORAGE_KEYS.PLAYBACK_SETTINGS]: { language: 'sv', voice: 'custom-voice:old', voicesByLanguage: { sv: 'custom-voice:old' }, lastBuiltInVoiceId: emma, speed: 1.5 },
        'byoVoiceConfigs.v1': [{ sourceType: 'third-party-api', sourceUri: 'https://voice.example.test/tts', apiKey: 'retired-secret' }],
        'byoVoiceUsage.v1': [{ bytes: 100 }],
        byoVoiceColdStartProbe: { status: 'ready' },
      } : {}),
    });
    if (retiredVoice) await (await serviceWorker(context)).evaluate(async () => {
      await (await caches.open('pagenarrator-local-voice-models-v1')).put('https://pagenarrator.invalid/old', new Response('model and reference audio'));
      await (await caches.open('kokoro-voices')).put('https://pagenarrator.invalid/built-in-marker', new Response('keep built-in data'));
    });
    const before = await readStorage(context, null);
    await saveJson(testInfo, 'storage-before-update.json', before);
    await saveJson(testInfo, 'previous-release-errors.json', previousErrors);
    await oldPopup.close();
    await context.close();
    context = null;

    // A Store update unloads the old version first, and Chrome unregisters its worker immediately
    // (DeactivateExtension in extensions/browser/service_worker/service_worker_task_queue.cc). An
    // unpacked extension swapped between launches skips that step and keeps running the old worker,
    // so drop only the worker registration. Extension storage, Cache Storage, IndexedDB and granted
    // permissions stay, as they do in a Store update.
    for (const name of ['Database', 'ScriptCache']) {
      await rm(path.join(profileDir, 'Default', 'Service Worker', name), { recursive: true, force: true });
    }
    await installUnpacked(resolveExtensionDir({ testInfo }), extensionDir);
    context = await launch(profileDir, extensionDir, errors);
    const updated = await extensionInfo(context);
    expect(updated.id, 'an update keeps the extension ID').toBe(previous.id);
    expect(updated.version).not.toBe(previous.version);
    const statePage = await context.newPage();
    await statePage.goto(`chrome-extension://${updated.id}/src/popup.html`);
    const state = await statePage.evaluate((type) => chrome.runtime.sendMessage({ type }), MESSAGE_TYPES.READER_ENGINE_GET_STATE);
    expect(state, 'the updated background worker runs the new release').toMatchObject({ state: 'idle' });
    await statePage.close();

    const after = await readStorage(context, null);
    await saveJson(testInfo, 'storage-after-update.json', after);
    expect(after[STORAGE_KEYS.PLAYBACK_SETTINGS], 'settings survive the update').toMatchObject({ speed: 1.5 });
    expect(after[getResumePositionStorageKey(articleUrl)], 'saved progress survives the update').toMatchObject({ chunk: 1 });

    // Command-line extensions are reinstalled on every launch, so Chrome reports onInstalled
    // reason 'install' here; a Store update reports 'update', which arms no first-run voice setup
    // (tests/ci/background.test.js). Clear the flag this harness adds so the popup is an updated user's.
    await (await serviceWorker(context)).evaluate((key) => chrome.storage.local.remove(key), STORAGE_KEYS.VOICE_SETUP_PENDING);
    await writeStorage(context, {
      [TEST_HOOKS_STORAGE_KEY]: true,
      [TEST_RECORD_FLOW_STORAGE_KEY]: true,
      ...(RUN_REAL_MODEL ? {} : { [TEST_SILENT_TTS_STORAGE_KEY]: true }),
    });
    const article = await openCorpusArticle(context, server, ARTICLE);
    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
    await expect(popup.locator('#popup-setup'), 'an updated user skips first-run voice setup').toBeHidden();
    await expect(popup.locator('#popup-settings-summary')).toHaveText('Emma voice · 1.50x');
    await expect(popup.locator('#popup-previous'), 'reading resumes at the saved section').toBeEnabled({ timeout: 15_000 });
    await expect.poll(() => engineState(context), { timeout: RUN_REAL_MODEL ? 10 * 60_000 : 90_000 }).toBe('finished');

    const worker = await serviceWorker(context);
    if (retiredVoice) {
      const stored = await readStorage(context, null);
      expect(stored[STORAGE_KEYS.PLAYBACK_SETTINGS]).toMatchObject({ voice: emma, language: 'en', speed: 1.5 });
      expect(JSON.stringify(stored)).not.toMatch(/custom-voice:|retired-secret|byoVoice/);
      expect(await worker.evaluate(async () => ({
        retired: await caches.has('pagenarrator-local-voice-models-v1'),
        builtIn: Boolean(await (await caches.open('kokoro-voices')).match('https://pagenarrator.invalid/built-in-marker')),
      }))).toEqual({ retired: false, builtIn: true });
      await expect(popup.locator('#popup-custom-voices')).toHaveCount(0);
      await expect(popup.locator('#popup-voice option')).toHaveCount(10);
    }
    const log = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }).then((response) => response?.log || []));
    const played = log.filter((entry) => entry.kind === 'chunk_play');
    expect(played.length, 'narration plays after the update').toBeGreaterThan(0);
    expect(played[0].chunkIndex, 'narration starts from the saved section, not the top').toBeGreaterThan(0);
    if (RUN_REAL_MODEL) {
      const decoded = log.filter((entry) => [entry.kind, entry.channel].some((name) => /(^|_)decode_latency$/.test(name || '')));
      expect(decoded.length, 'the bundled Kokoro model produced audio').toBeGreaterThan(0);
    }
    expect(errors.uncaught, 'no uncaught extension errors after the update').toEqual([]);
  } finally {
    await saveJson(testInfo, 'updated-release-errors.json', errors);
    await context?.close().catch((error) => console.warn('Could not close the upgrade test browser.', error));
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
}

async function saveJson(testInfo, name, value) {
  const filePath = testInfo.outputPath(name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  await testInfo.attach(name, { path: filePath, contentType: 'application/json' });
}

async function installUnpacked(sourceDir, extensionDir) {
  await rm(extensionDir, { recursive: true, force: true });
  await cp(sourceDir, extensionDir, { recursive: true });
  // Headless tests cannot click the toolbar button, so grant the fixture origin as the other e2e tests do.
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://*/*'])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function launch(profileDir, extensionDir, errors) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: !/^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || ''),
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  context.on('weberror', (error) => errors.uncaught.push(String(error.error()?.stack || error.error())));
  context.on('page', (page) => page.on('pageerror', (error) => errors.uncaught.push(`${page.url()}: ${error.stack || error}`)));
  context.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(`${message.location()?.url || ''}: ${message.text()}`);
  });
  return context;
}

async function serviceWorker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 30_000 });
}

async function extensionInfo(context) {
  const worker = await serviceWorker(context);
  return { id: new URL(worker.url()).hostname, version: await worker.evaluate(() => chrome.runtime.getManifest().version) };
}

async function readStorage(context, key) {
  const worker = await serviceWorker(context);
  const values = await worker.evaluate((name) => chrome.storage.local.get(name), key);
  return key ? values[key] : values;
}

async function writeStorage(context, values) {
  const worker = await serviceWorker(context);
  await worker.evaluate((entries) => chrome.storage.local.set(entries), values);
}

async function engineState(context) {
  const worker = await serviceWorker(context);
  const state = await worker.evaluate(() => chrome.storage.session.get('readerEngineState')
    .then((value) => value.readerEngineState || { state: 'idle' }));
  if (state.state === 'error') throw new Error(`Reader engine failed after the update: ${JSON.stringify(state)}`);
  return state.state;
}
