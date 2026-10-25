import { expect, test } from '@playwright/test';
import { getExtensionId, launchExtensionContext, openPdfViewer, seedReadableTabTarget } from './extension-fixture.js';

test('PDF highlight resource use stays bounded while a word is unchanged', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    await getExtensionId(context);
    const page = await openPdfViewer(context, 'single-column.pdf');
    await expect(page.locator('#pdf-status')).toContainText('1 page loaded');
    const tabId = await seedReadableTabTarget(context, page, { allowActiveExtensionTab: true });
    const worker = context.serviceWorkers()[0];
    const send = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const results = [];
    for (const playbackRate of [0.5, 1, 3]) {
      expect(await send({ type: 'highlightChunk', anchorId: 'pdf-page-1', text: 'PageNarrator single column fixture' })).toMatchObject({ ok: true });
      expect(await send({
        type: 'highlightWordPlan', currentTime: 0, playbackRate, leadSeconds: 0,
        plan: [{ index: 0, start: 0, end: 60 }, { index: 1, start: 60, end: 61 }],
      })).toMatchObject({ ok: true });
      const before = await metrics();
      const counts = await page.evaluate(async () => {
        const nativeSet = CSS.highlights.set;
        const nativeRects = Range.prototype.getClientRects;
        let paints = 0, geometryReads = 0;
        CSS.highlights.set = function(name, highlight) {
          if (name.startsWith('pagenarrator-word')) paints += 1;
          return nativeSet.call(this, name, highlight);
        };
        Range.prototype.getClientRects = function() { geometryReads += 1; return nativeRects.call(this); };
        try {
          await new Promise((resolve) => {
            let frames = 0;
            const tick = () => { if (++frames === 120) resolve(); else requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
          });
          return { frames: 120, paints, geometryReads, word: [...CSS.highlights.get('pagenarrator-word-0')].map((range) => range.toString()).join('') };
        } finally {
          CSS.highlights.set = nativeSet;
          Range.prototype.getClientRects = nativeRects;
        }
      });
      const after = await metrics();
      results.push({
        playbackRate, ...counts,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        layouts: after.LayoutCount - before.LayoutCount,
        heapDeltaBytes: after.JSHeapUsedSize - before.JSHeapUsedSize,
      });
      await send({ type: 'clearHighlight' });
    }
    console.log(JSON.stringify(results));
    await testInfo.attach('highlight-resource-metrics', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    for (const result of results) {
      expect(result.word).toBe('PageNarrator');
      expect(result.paints).toBeLessThanOrEqual(1);
      expect(result.geometryReads).toBeLessThanOrEqual(4);
    }
  } finally { await cleanup(); }
});
