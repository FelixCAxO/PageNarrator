import { expect, test } from '@playwright/test';
import { getExtensionId, launchExtensionContext, openPdfViewer, seedReadableTabTarget } from './extension-fixture.js';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';

test('mixed intrinsic PDF rotations open upright and retain word highlighting after toolbar rotation', async () => {
  const pages = [0, 90, 180, 270].map((rotation, index) => {
    const x = 54, y = rotation % 180 ? 500 : 700;
    const transform = rotation === 90 ? [0, 1, -1, 0, 612 - y, x]
      : rotation === 180 ? [-1, 0, 0, -1, 612 - x, 792 - y]
        : rotation === 270 ? [0, -1, 1, 0, y, 792 - x] : [1, 0, 0, 1, x, y];
    return { rotation, items: [{ text: `Upright page ${index + 1} retains its native reading orientation.`, transform }] };
  });
  const url = `data:application/pdf;base64,${Buffer.from(buildPdfBytes(pages)).toString('base64')}`;
  const { context, cleanup } = await launchExtensionContext();
  try {
    const page = await openPdfViewer(context, url);
    await expect(page.locator('#pdf-status')).toContainText('4 pages loaded');
    const worker = context.serviceWorkers()[0];
    const tabId = await seedReadableTabTarget(context, page, { allowActiveExtensionTab: true });
    const send = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    for (const [index, { rotation }] of pages.entries()) {
      await page.locator('#pdf-page-input').fill(String(index + 1));
      await page.locator('#pdf-page-input').press('Enter');
      const layer = page.locator(`[data-pagenarrator-id="pdf-page-${index + 1}"] .textLayer`);
      await expect(layer).toContainText(`Upright page ${index + 1}`);
      await expect(layer).toHaveAttribute('data-main-rotation', String(rotation));
      expect(await layer.locator('span').first().evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > bounds.height;
      })).toBe(true);
      const canvas = page.locator(`[data-pagenarrator-id="pdf-page-${index + 1}"] canvas`);
      expect(await canvas.evaluate(element => element.width > element.height)).toBe(rotation % 180 !== 0);
      expect(await send({ type: 'highlightChunk', anchorId: `pdf-page-${index + 1}`, text: `Upright page ${index + 1}` })).toMatchObject({ ok: true });
      expect(await send({ type: 'highlightWord', index: 0 })).toMatchObject({ ok: true });
      const highlighted = () => page.evaluate(() => [...(CSS.highlights.get('pagenarrator-word-0') || [])]
        .filter(range => range.startContainer.isConnected).map(range => range.toString()).join(''));
      await expect.poll(highlighted).toBe('Upright');
      await page.locator('#pdf-rotate-right-btn').click();
      await expect(layer).toHaveAttribute('data-main-rotation', String((rotation + 90) % 360));
      await expect.poll(highlighted).toBe('Upright');
      await page.locator('#pdf-rotate-left-btn').click();
      await expect(layer).toHaveAttribute('data-main-rotation', String(rotation));
      await expect.poll(highlighted).toBe('Upright');
      await send({ type: 'clearHighlight' });
    }
  } finally { await cleanup(); }
});

test('PDF zoom and rotation preserve the current timed word and later resyncs', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await getExtensionId(context);
    const page = await openPdfViewer(context, 'single-column.pdf');
    await expect(page.locator('#pdf-status')).toContainText('1 page loaded');
    const worker = context.serviceWorkers()[0];
    const tabId = await seedReadableTabTarget(context, page, { allowActiveExtensionTab: true });
    const send = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    const currentWord = () => page.evaluate(() => [...(CSS.highlights.get('pagenarrator-word-0') || [])].map((range) => range.toString()).join(''));
    expect(await send({ type: 'highlightChunk', anchorId: 'pdf-page-1', text: 'PageNarrator single column fixture' })).toMatchObject({ ok: true });
    expect(await send({
      type: 'highlightWordPlan', currentTime: 2, playbackRate: 1, leadSeconds: 0,
      plan: [
        { index: 0, start: 0, end: 1, text: 'PageNarrator' },
        { index: 1, start: 1, end: 15, text: 'single' },
        { index: 2, start: 15, end: 30, text: 'column' },
      ],
    })).toMatchObject({ ok: true });
    await expect.poll(currentWord).toBe('single');

    for (const [button, paused] of [['#pdf-zoom-in-btn', false], ['#pdf-rotate-right-btn', true]]) {
      expect(await send({ type: 'highlightPlanResync', currentTime: 2, paused, playbackRate: 1 })).toMatchObject({ ok: true });
      await page.locator('.textLayer').evaluate((layer) => { layer.dataset.beforeSyncRefresh = 'true'; });
      await page.locator(button).click();
      await expect(page.locator('.textLayer[data-before-sync-refresh]')).toHaveCount(0);
      await expect.poll(currentWord).toBe('single');
      expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0')].every((range) => (
        range.startContainer.isConnected && range.startContainer.parentElement.closest('.textLayer')
      )))).toBe(true);
      expect(await send({ type: 'highlightPlanResync', currentTime: 16, paused: false, playbackRate: 3 })).toMatchObject({ ok: true });
      await expect.poll(currentWord).toBe('column');
    }
    await send({ type: 'clearHighlight' });
    expect(await currentWord()).toBe('');
    expect(await send({ type: 'highlightPlanResync', currentTime: 2 })).toMatchObject({ ok: false });
  } finally {
    await cleanup();
  }
});
