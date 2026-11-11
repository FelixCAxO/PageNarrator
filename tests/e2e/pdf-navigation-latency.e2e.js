import { expect, test } from '@playwright/test';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { launchExtensionContext, navigatePdfViewer } from './extension-fixture.js';

// A real PDF, module worker, WASM parser, canvas paint, and selectable text layer.
const bytes = buildPdfBytes(Array.from({ length: 20 }, (_, index) => ({
  items: Array.from({ length: 40 }, (_, line) => ({
    text: `Marker page ${index + 1} line ${line + 1} reads a complete sentence.`,
    x: 54, y: 740 - line * 16,
  })),
})));
const source = `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;

async function measureJump(page, targets) {
  return page.evaluate(numbers => new Promise((resolve, reject) => {
    const target = numbers.at(-1);
    const start = performance.now();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Page ${target} did not become selectable.`)); }, 15000);
    const observer = new MutationObserver(check);
    observer.observe(document.getElementById('pdf-pages'), { childList: true, subtree: true });
    function check() {
      const element = document.querySelector(`[data-page-number="${target}"]`);
      if (!element?.querySelector('.textLayer')?.textContent.includes(`Marker page ${target} `)) return;
      if (!element.querySelector('canvas')?.width) return;
      observer.disconnect(); clearTimeout(timer);
      // Include an opportunity for the completed canvas to reach the screen.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
    }
    for (const number of numbers) {
      const input = document.getElementById('pdf-page-input');
      input.value = String(number);
      input.dispatchEvent(new Event('change'));
    }
    check();
  }), targets);
}

for (const [deviceMemory, canvasLimit] of [[4, 3], [8, 5]]) {
  test(`navigates PDFs with 6x CPU throttling and a ${deviceMemory} GB memory hint`, async ({}, testInfo) => {
    const { context, cleanup } = await launchExtensionContext({ testInfo });
    try {
      await context.addInitScript(memory => {
        Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => memory });
        Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 2 });
      }, deviceMemory);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await navigatePdfViewer(page, source);
      await expect(page.locator('[data-page-number="1"] .textLayer')).toContainText('Marker page 1 ');
      const samples = [];
      for (const number of [6, 10, 14, 18]) samples.push(await measureJump(page, [number]));
      const rapidMs = await measureJump(page, [4, 10, 16]);
      await expect(page.locator('#pdf-page-input')).toHaveValue('16');
      await expect(page.locator('[data-page-number="17"] .textLayer')).toContainText('Marker page 17 ');
      const prefetchedMs = await measureJump(page, [17]);
      expect(Math.max(...samples, rapidMs, prefetchedMs)).toBeLessThan(2000);
      expect(await page.locator('.pdf-page canvas').count()).toBeLessThanOrEqual(canvasLimit);
      expect(errors).toEqual([]);
      const evidence = { cpuThrottleRate: 6, deviceMemoryHint: deviceMemory,
        hardwareConcurrencyHint: 2, coldJumpMs: samples, rapidJumpMs: rapidMs, prefetchedJumpMs: prefetchedMs };
      console.log(JSON.stringify(evidence));
      await testInfo.attach('navigation-timings', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    } finally {
      await cleanup();
    }
  });
}
