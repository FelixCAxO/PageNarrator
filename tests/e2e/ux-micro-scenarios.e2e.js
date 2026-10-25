import { expect, test } from '@playwright/test';
import {
  getExtensionId,
  launchExtensionContext,
  openExtensionPage,
  openPdfViewer,
} from './extension-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';

async function openReadyPopup(context) {
  // These two layout/state cases replay fixed snapshots. An idle live engine would
  // overwrite them when an expanded details panel requests a state sync.
  await context.addInitScript(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => message?.type === 'readerEngineActionRequest'
      && message.action?.type === 'syncState' ? Promise.resolve({ ok: true }) : sendMessage(message, ...args);
  });
  const popup = await openExtensionPage(context, 'popup');
  await expect(popup.locator('#start-reading')).toBeEnabled();
  await popup.locator('details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  return popup;
}

test('queue remains readable at popup width with long titles, words, and all settings expanded', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const engine = await openRoutedReaderEngine(context);
    const popup = await openReadyPopup(context);
    await popup.setViewportSize({ width: 350, height: 600 });
    await engine.evaluate((longWord) => chrome.runtime.sendMessage({
      type: 'readerStateChanged', state: 'paused', title: longWord,
      currentChunk: 0, totalChunks: 2, queue: [longWord, 'A second section.'], transcript: longWord,
    }), 'VeryLongDocumentName'.repeat(20));
    await expect(popup.locator('#popup-player')).toBeVisible();
    const scrollWidth = await popup.evaluate(() => document.documentElement.scrollWidth);
    await popup.screenshot({ path: testInfo.outputPath('popup-expanded.png'), fullPage: true });
    expect(scrollWidth).toBeLessThanOrEqual(350);
    for (const id of ['popup-previous', 'popup-toggle', 'popup-stop', 'popup-next']) {
      const button = popup.locator(`#${id}`);
      expect(await button.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await expect(popup.locator('#popup-queue [aria-current="true"]')).toHaveCount(1);
  } finally {
    await cleanup();
  }
});

test('queue editing survives progress, search explains no matches, and engine recovery clears the error', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const engine = await openRoutedReaderEngine(context);
    const popup = await openReadyPopup(context);
    const broadcast = (state) => engine.evaluate((value) => chrome.runtime.sendMessage({ type: 'readerStateChanged', ...value }), state);
    await broadcast({ state: 'error', errorCode: 'empty_selection' });
    await expect(popup.locator('#popup-error')).toBeVisible();
    await broadcast({ state: 'reading', queue: ['First.', 'Second.', 'Third.'], currentChunk: 0, totalChunks: 3 });
    await expect(popup.locator('#popup-error')).toBeHidden();
    await popup.locator('#popup-queue-jump').fill('3');
    await broadcast({ state: 'reading', currentChunk: 1 });
    await expect(popup.locator('#popup-queue-jump')).toHaveValue('3');
    await popup.getByRole('searchbox', { name: 'Search sections' }).fill('missing passage');
    await expect(popup.locator('#popup-queue-empty')).toBeVisible();
    await popup.getByRole('searchbox', { name: 'Search sections' }).fill('');
    await expect(popup.locator('#popup-queue-empty')).toBeHidden();
    await expect(popup.locator('#popup-queue button')).toHaveCount(3);
  } finally {
    await cleanup();
  }
});

test('PDF page input normalizes committed invalid and same-page values', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const viewer = await openPdfViewer(context, 'single-column.pdf');
    await expect(viewer.locator('#pdf-status')).toHaveText('1 page loaded');
    const input = viewer.locator('#pdf-page-input');
    for (const value of ['', '0', '-2', '99999', '1.5']) {
      await input.fill(value);
      await input.press('Enter');
      await expect(input).toHaveValue('1');
    }
  } finally {
    await cleanup();
  }
});

test('PDF zoom limits disable only the exhausted direction and fit resets zoom', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const viewer = await openPdfViewer(context, 'single-column.pdf');
    await expect(viewer.locator('#pdf-status')).toHaveText('1 page loaded');
    for (let index = 0; index < 5; index += 1) await viewer.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect(viewer.locator('#pdf-zoom-label')).toHaveText('50%');
    await expect(viewer.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Zoom in', exact: true })).toBeEnabled();
    await viewer.getByRole('button', { name: 'Fit page', exact: true }).click();
    await expect(viewer.locator('#pdf-zoom-label')).toHaveText('100%');
    await expect(viewer.getByRole('button', { name: 'Zoom out', exact: true })).toBeEnabled();
    for (let index = 0; index < 20; index += 1) await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(viewer.locator('#pdf-zoom-label')).toHaveText('300%');
    await expect(viewer.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
    await viewer.getByRole('button', { name: 'Fit width', exact: true }).click();
    await viewer.setViewportSize({ width: 360, height: 640 });
    await expect.poll(() => viewer.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await viewer.screenshot({ path: testInfo.outputPath('pdf-narrow.png') });
  } finally {
    await cleanup();
  }
});

test('PDF load failure announces recovery and disables document controls', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const extensionId = await getExtensionId(context);
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html`);
    await expect(viewer.locator('#pdf-status')).not.toContainText('Loading');
    await expect(viewer.locator('#pdf-status')).toHaveAttribute('role', 'status');
    await expect(viewer.locator('#pdf-page-input')).toBeDisabled();
    for (const button of await viewer.locator('#pdf-toolbar button').all()) await expect(button).toBeDisabled();
  } finally {
    await cleanup();
  }
});
