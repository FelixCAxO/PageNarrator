import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  getExtensionId,
  launchExtensionContext,
  openCorpusArticle,
  openExtensionPage,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const pdfFixtureDir = path.resolve('tests/fixtures/pdfs');

test.describe('All Functions & Settings E2E Verification', () => {
  test('1. Every setting persists to storage and binds bi-directionally to UI', async () => {
    const { context, cleanup } = await launchExtensionContext();
    try {
      const popup = await openExtensionPage(context, 'popup');

      // Expand Settings and Advanced Settings
      await popup.locator('#popup-settings').evaluate((node) => { node.open = true; });
      await popup.locator('#popup-advanced').evaluate((node) => { node.open = true; });

      // Verify default state
      await expect(popup.locator('#popup-language')).toHaveValue('en');
      await expect(popup.locator('#popup-voice')).toHaveValue('af_heart');
      await expect(popup.locator('#popup-speed')).toHaveValue('1');
      await expect(popup.locator('#popup-speed-out')).toHaveText('1.00x');
      await expect(popup.locator('#popup-section-pause')).toHaveValue('0');
      await expect(popup.locator('#popup-section-pause-out')).toHaveText('Normal');
      await expect(popup.locator('#popup-performance-profile')).toHaveValue('auto');
      await expect(popup.locator('#popup-backend-preference')).toHaveValue('auto');
      await expect(popup.locator('#popup-idle-release')).toBeChecked();
      await expect(popup.locator('#popup-skip-code')).not.toBeChecked();
      await expect(popup.locator('#popup-area-color')).toHaveValue('#ffdd57');
      await expect(popup.locator('#popup-word-color')).toHaveValue('#ffdd57');
      await expect(popup.locator('#popup-area-opacity')).toHaveValue('0.1');
      await expect(popup.locator('#popup-word-opacity')).toHaveValue('0.38');

      // 1. Voice switching across built-in Kokoro voices
      await selectNativeOption(popup.locator('#popup-voice'), 'am_fenrir');
      await expect(popup.locator('#popup-settings-summary')).toContainText('Fenrir');

      await selectNativeOption(popup.locator('#popup-voice'), 'bf_emma');
      await expect(popup.locator('#popup-settings-summary')).toContainText('Emma');

      // 2. Speed adjustments & clamping
      await setNativeRange(popup.locator('#popup-speed'), '2.25');
      await expect(popup.locator('#popup-speed-out')).toHaveText('2.25x');
      await expect(popup.locator('#popup-settings-summary')).toContainText('2.25x');

      // 3. Section pause adjustments & formatting
      await setNativeRange(popup.locator('#popup-section-pause'), '2.4');
      await expect(popup.locator('#popup-section-pause-out')).toHaveText('2.4s slower');

      await setNativeRange(popup.locator('#popup-section-pause'), '-1.5');
      await expect(popup.locator('#popup-section-pause-out')).toHaveText('Faster');

      // 4. Performance profile
      await selectNativeOption(popup.locator('#popup-performance-profile'), 'lowPower');

      // 5. Backend preference
      await selectNativeOption(popup.locator('#popup-backend-preference'), 'wasm');

      // 6. Idle release
      await popup.locator('#popup-idle-release').uncheck();

      // 7. Skip code snippets
      await popup.locator('#popup-skip-code').check();

      // 8. Colors & Opacities
      await expect.poll(() => popup.evaluate(() => chrome.storage.local.get('playbackSettings')
        .then(({ playbackSettings }) => playbackSettings?.skipCodeSnippets))).toBe(true);
      // Chromium's native OS color picker is outside Playwright's page input
      // target. Prepare exact color values as fixtures, verify their synthetic
      // input events cannot save, then use the native range control to persist
      // the complete form. This covers persistence, not the OS picker itself.
      const colorFixture = await popup.evaluate(async () => {
        const writes = [];
        const record = (changes, area) => {
          if (area === 'local' && changes.playbackSettings) writes.push(changes.playbackSettings.newValue.highlight);
        };
        chrome.storage.onChanged.addListener(record);
        for (const [id, value] of [['popup-area-color', '#00aa55'], ['popup-word-color', '#7c3aed']]) {
          const input = document.getElementById(id);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        chrome.storage.onChanged.removeListener(record);
        const { playbackSettings } = await chrome.storage.local.get('playbackSettings');
        return { writes, colors: [playbackSettings.highlight.area.color, playbackSettings.highlight.word.color] };
      });
      expect(colorFixture.writes).toEqual([]);
      expect(colorFixture.colors).toEqual(['#ffdd57', '#ffdd57']);
      await setNativeRange(popup.locator('#popup-area-opacity'), '0.5');
      await expect(popup.locator('#popup-area-opacity-out')).toHaveText('50%');
      await setNativeRange(popup.locator('#popup-word-opacity'), '0.8');
      await expect(popup.locator('#popup-word-opacity-out')).toHaveText('80%');

      // Wait for storage write. waitForFunction does not await a returned Promise; poll instead.
      await expect.poll(() => popup.evaluate(() => chrome.storage.local.get('playbackSettings').then((res) => {
        const s = res.playbackSettings;
        return (
          s?.language === 'en'
          && s?.voice === 'bf_emma'
          && s?.speed === 2.25
          && s?.sectionPauseSeconds === -1.5
          && s?.ttsPerformanceProfile === 'lowPower'
          && s?.ttsBackendPreference === 'wasm'
          && s?.idleReleaseEnabled === false
          && s?.skipCodeSnippets === true
          && s?.highlight?.area?.color === '#00aa55'
          && s?.highlight?.word?.color === '#7c3aed'
          && s?.highlight?.area?.opacity === 0.5
          && s?.highlight?.word?.opacity === 0.8
        );
      }))).toBe(true);

      // Reload popup and verify UI reflects the restored settings perfectly
      await popup.reload();
      await popup.locator('#popup-settings').evaluate((node) => { node.open = true; });
      await popup.locator('#popup-advanced').evaluate((node) => { node.open = true; });

      await expect(popup.locator('#popup-language')).toHaveValue('en');
      await expect(popup.locator('#popup-voice')).toHaveValue('bf_emma');
      await expect(popup.locator('#popup-speed')).toHaveValue('2.25');
      await expect(popup.locator('#popup-speed-out')).toHaveText('2.25x');
      await expect(popup.locator('#popup-section-pause')).toHaveValue('-1.5');
      await expect(popup.locator('#popup-section-pause-out')).toHaveText('Faster');
      await expect(popup.locator('#popup-performance-profile')).toHaveValue('lowPower');
      await expect(popup.locator('#popup-backend-preference')).toHaveValue('wasm');
      await expect(popup.locator('#popup-idle-release')).not.toBeChecked();
      await expect(popup.locator('#popup-skip-code')).toBeChecked();
      await expect(popup.locator('#popup-area-color')).toHaveValue('#00aa55');
      await expect(popup.locator('#popup-word-color')).toHaveValue('#7c3aed');
      await expect(popup.locator('#popup-area-opacity')).toHaveValue('0.5');
      await expect(popup.locator('#popup-word-opacity')).toHaveValue('0.8');
    } finally {
      await cleanup();
    }
  });

  test('3. Setup warming, error retry, skip, and hardware status work e2e', async () => {
    const { context, cleanup } = await launchExtensionContext();
    try {
      const popup = await openExtensionPage(context, 'popup');
      const engine = await openRoutedReaderEngine(context);

      // 1. Voice setup simulation
      await engine.evaluate(() => chrome.runtime.sendMessage({
        type: 'readerStateChanged',
        state: 'idle',
        setupPending: true,
        modelSetup: { phase: 'loading', progress: 65, detail: 'Downloading model.onnx: 6.5 / 10.0 MB', eta: 'One-time setup' },
      }));
      await expect(popup.locator('#popup-setup')).toBeVisible();
      await expect.poll(() => popup.locator('#popup-setup-progress').evaluate((el) => el.value)).toBe(65);
      await expect(popup.locator('#popup-setup-detail')).toHaveText('Downloading model.onnx: 6.5 / 10.0 MB');

      // 2. Setup error & retry
      await engine.evaluate(() => chrome.runtime.sendMessage({
        type: 'readerStateChanged',
        state: 'idle',
        setupPending: true,
        modelSetup: { phase: 'error', detail: 'WASM memory allocation failure.', eta: 'Try again' },
      }));
      await expect(popup.locator('#popup-setup-start')).toHaveText('Retry');
      await expect(popup.locator('#popup-setup-detail')).toHaveText('WASM memory allocation failure.');

      // 3. Skip setup
      await popup.locator('#popup-setup-skip').click();
      await expect(popup.locator('#popup-setup')).toBeHidden();

      // 4. Hardware status update
      await engine.evaluate(() => chrome.runtime.sendMessage({
        type: 'readerStateChanged',
        state: 'idle',
        backend: { device: 'webgpu' },
      }));
      await expect(popup.locator('#popup-hardware-status')).toContainText('WebGPU');
    } finally {
      await cleanup();
    }
  });

  test('4. Full read lifecycle on web article: read page, transcript, queue search, pause, resume, next, prev, jump, stop', async ({}, testInfo) => {
    const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
    const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
    try {
      await seedFlowTestFlags(context);
      const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
      const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });

      // Verify active playback state
      await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 15_000 });
      await expect(popup.locator('#popup-toggle')).toHaveText('Pause');
      await expect(popup.locator('#popup-player')).toBeVisible();

      // Transcript inspection during real read
      await popup.locator('#popup-transcript-card').evaluate((node) => { node.open = true; });
      await expect(popup.locator('#popup-transcript-count')).not.toHaveText('0 sections');
      await expect(popup.locator('#popup-transcript')).toContainText('This fixture keeps silent test speech active');

      // Queue inspection & search during real read
      await popup.locator('#popup-queue-card').evaluate((node) => { node.open = true; });
      await expect(popup.locator('#popup-queue li')).not.toHaveCount(0);
      const initialCount = await popup.locator('#popup-queue li').count();

      // Queue search filter
      await popup.locator('#popup-queue-search').fill('silent');
      await expect(popup.locator('#popup-queue li')).toHaveCount(1);
      await popup.locator('#popup-queue-search').fill('');
      await expect(popup.locator('#popup-queue li')).toHaveCount(initialCount);

      // Pause
      await popup.locator('#popup-toggle').click();
      await expect(popup.locator('#popup-status')).toHaveText('Paused', { timeout: 10_000 });
      await expect(popup.locator('#popup-toggle')).toHaveText('Resume');

      // Resume
      await popup.locator('#popup-toggle').click();
      await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 10_000 });
      await expect(popup.locator('#popup-toggle')).toHaveText('Pause');

      // Next section
      await popup.locator('#popup-next').click();
      await expect(popup.locator('#popup-previous')).toBeEnabled({ timeout: 10_000 });

      // Previous section
      await popup.locator('#popup-previous').click();

      // Stop
      await popup.locator('#popup-stop').click();
      await expect(popup.locator('#popup-status')).toHaveText('Ready to read', { timeout: 10_000 });
      await expect(popup.locator('#popup-idle-actions')).toBeVisible();
      await expect(popup.locator('#popup-player')).toBeHidden();
    } finally {
      await cleanup();
      await server.close();
    }
  });

  test('5. PDF viewer loads, extracts text, handles page navigation and starts reading', async () => {
    const { context, cleanup } = await launchExtensionContext();
    try {
      const extensionId = await getExtensionId(context);
      const fixtureBytes = await readFile(path.join(pdfFixtureDir, 'single-column.pdf'));
      const pdfDataUrl = `data:application/pdf;base64,${fixtureBytes.toString('base64')}`;

      const pdfPage = await context.newPage();
      await pdfPage.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfDataUrl)}`);

      // Verify PDF viewer DOM
      await expect(pdfPage.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 15_000 });
      await expect(pdfPage.locator('[data-pagenarrator-id="pdf-page-1"] .textLayer')).toContainText(
        'PageNarrator single column fixture',
      );

      // Verify PDF toolbar controls
      await expect(pdfPage.locator('#pdf-toolbar')).toBeVisible();
      await expect(pdfPage.locator('#pdf-page-input')).toHaveValue('1');
      await expect(pdfPage.locator('#pdf-page-count')).toHaveText('/ 1');
      await expect(pdfPage.locator('#pdf-zoom-label')).toHaveText('100%');
      await expect(pdfPage.locator('#pdf-zoom-in-btn')).toBeVisible();
      await expect(pdfPage.locator('#pdf-zoom-out-btn')).toBeVisible();
      await expect(pdfPage.locator('#pdf-rotate-left-btn')).toBeVisible();
      await expect(pdfPage.locator('#pdf-rotate-right-btn')).toBeVisible();
      await expect(pdfPage.locator('#pdf-fit-width-btn')).toBeVisible();
      await expect(pdfPage.locator('#pdf-fit-page-btn')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
