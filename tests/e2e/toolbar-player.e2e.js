import { expect, test } from '@playwright/test';
import { launchExtensionContext, openExtensionPage } from './extension-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';

test('clean install exposes setup and every advanced toolbar-player control', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const popup = await openExtensionPage(context, 'popup');
    await expect(popup.locator('#popup-setup')).toBeVisible();
    await popup.locator('#popup-setup-skip').click();
    await expect(popup.locator('#popup-setup')).toBeHidden();

    for (const id of ['popup-settings', 'popup-advanced']) {
      await expect(popup.locator(`#${id}`)).toBeVisible();
    }
    // Transcript and queue have nothing to show before a read; they appear with the queue.
    for (const id of ['popup-transcript-card', 'popup-queue-card']) {
      await expect(popup.locator(`#${id}`)).toBeHidden();
    }
    await popup.locator('#popup-settings').evaluate((node) => { node.open = true; });
    await popup.locator('#popup-advanced').evaluate((node) => { node.open = true; });
    await setNativeRange(popup.locator('#popup-speed'), '3');
    await setNativeRange(popup.locator('#popup-section-pause'), '1.5');
    await selectNativeOption(popup.locator('#popup-performance-profile'), 'quality');
    await selectNativeOption(popup.locator('#popup-backend-preference'), 'wasm');
    await popup.locator('#popup-idle-release').uncheck();
    await popup.locator('#popup-skip-code').check();
    // waitForFunction treats a returned Promise as truthy without awaiting it; poll instead.
    await expect.poll(() => popup.evaluate(() => chrome.storage.local.get('playbackSettings')
      .then((state) => state.playbackSettings?.skipCodeSnippets === true))).toBe(true);
    await popup.reload();
    await popup.locator('#popup-settings').evaluate((node) => { node.open = true; });
    await popup.locator('#popup-advanced').evaluate((node) => { node.open = true; });
    await expect(popup.locator('#popup-speed')).toHaveValue('3');
    await expect(popup.locator('#popup-section-pause')).toHaveValue('1.5');
    await expect(popup.locator('#popup-performance-profile')).toHaveValue('quality');
    await expect(popup.locator('#popup-backend-preference')).toHaveValue('wasm');
    await expect(popup.locator('#popup-idle-release')).not.toBeChecked();
    await expect(popup.locator('#popup-skip-code')).toBeChecked();
  } finally {
    await cleanup();
  }
});

test('toolbar player receives hardware, transcript and queue state on demand', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const engine = await openRoutedReaderEngine(context);
    const popup = await openExtensionPage(context, 'popup');
    await engine.evaluate(() => chrome.runtime.sendMessage({
      type: 'readerStateChanged',
      state: 'paused',
      title: 'Current article',
      currentChunk: 1,
      totalChunks: 2,
      progressLabel: 'Section 2 of 2',
      remainingLabel: '12 words remaining',
      backend: { device: 'webgpu' },
      transcript: 'First section.\n\nSecond section.',
      queue: ['First section.', 'Second section.'],
    }));
    await expect(popup.locator('#popup-status')).toHaveText('Paused');
    await expect(popup.locator('#popup-hardware-status')).toContainText('WebGPU');
    await expect(popup.locator('#popup-transcript-count')).toHaveText('2 sections');
    await expect(popup.locator('#popup-queue-count')).toHaveText('2 sections');
    await expect(popup.locator('#popup-queue li')).toHaveCount(2);
    await expect(popup.locator('#popup-transcript-card')).toBeVisible();
    await expect(popup.locator('#popup-queue-card')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('voice preparation progress and retry remain in the toolbar player', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const engine = await openRoutedReaderEngine(context);
    const popup = await openExtensionPage(context, 'popup');
    await engine.evaluate(() => chrome.runtime.sendMessage({
      type: 'readerStateChanged',
      state: 'idle',
      setupPending: true,
      modelSetup: { phase: 'loading', progress: 42, detail: 'Downloading model.onnx: 4.2 / 10.0 MB', eta: 'One-time setup' },
    }));
    await expect.poll(() => popup.locator('#popup-setup-progress').evaluate((element) => element.value)).toBe(42);
    await expect(popup.locator('#popup-setup-detail')).toHaveText('Downloading model.onnx: 4.2 / 10.0 MB');
    await engine.evaluate(() => chrome.runtime.sendMessage({
      type: 'readerStateChanged',
      state: 'idle',
      setupPending: true,
      modelSetup: { phase: 'error', detail: 'Preparation failed.', eta: 'Try again' },
    }));
    await expect(popup.locator('#popup-setup-start')).toHaveText('Retry');
    await expect(popup.locator('#popup-setup-detail')).toHaveText('Preparation failed.');
  } finally {
    await cleanup();
  }
});
