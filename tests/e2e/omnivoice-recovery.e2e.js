import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine } from './kokoro-download-fixture.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';

test('recovers a worker crash and switches Swedish voice settings through the packaged reader', async ({}, testInfo) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="sv"><title>Svensk berättelse</title><article>${Array.from({ length: 8 }, (_, index) => `<p>Del ${index + 1}. Vi följer den lugna stigen genom trädgården och lyssnar på fåglarna som sjunger bland träden.</p>`).join('')}</article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  try {
    // Exercise production control flow without competing with real GPU measurements.
    await context.addInitScript(() => {
      globalThis.__recovery = { workers: 0, terminated: 0, crashed: false, jobs: [] };
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.number = ++__recovery.workers; }
        postMessage(message) {
          if (message.method === 'abort') return;
          if (!['init', 'synthesize', 'dispose'].includes(message.method)) return super.postMessage(message);
          queueMicrotask(() => {
            if (message.method === 'synthesize') {
              __recovery.jobs.push({ worker: this.number, ...message.request });
              if (!__recovery.crashed) {
                __recovery.crashed = true;
                this.dispatchEvent(new ErrorEvent('error', { message: 'Injected GPU worker crash', cancelable: true }));
                return;
              }
            }
            const result = message.method === 'synthesize'
              ? { pcm: Float32Array.from({ length: 36_000 }, (_, index) => .1 * Math.sin(index * 2 * Math.PI * 220 / 24_000)), sampleRate: 24_000 }
              : undefined;
            this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, result } }));
          });
        }
        terminate() { __recovery.terminated++; super.terminate(); }
      };
    });
    await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'omnivoice', language: 'sv', voice: 'af_heart',
      omniVoice: { gender: 'female', variation: 1, whisper: false } } });
    const engine = await openRoutedReaderEngine(context);
    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article);
    const worker = context.serviceWorkers()[0];
    const log = async () => (await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))).log;
    await expect.poll(async () => (await log()).filter(event => event.kind === 'chunk_play').length).toBeGreaterThan(0);
    const controls = await openExtensionPage(context, 'popup');
    if (!await controls.locator('#popup-settings').evaluate(node => node.open)) await controls.locator('#popup-settings summary').click();
    await selectNativeOption(controls.locator('#popup-omnivoice-gender'), 'male');
    await setNativeRange(controls.locator('#popup-omnivoice-variation'), 4);
    await expect.poll(() => engine.evaluate(() => __recovery.jobs.some(job => job.speakerId === 'male-4'))).toBe(true);
    await expect.poll(async () => (await worker.evaluate(() => chrome.storage.session.get('readerEngineState'))).readerEngineState?.state,
      { timeout: 30_000 }).toBe('finished');
    const report = await engine.evaluate(() => __recovery);
    expect(report.workers).toBe(2);
    expect(report.terminated).toBe(2);
    expect(report.jobs[1]).toEqual({ ...report.jobs[0], worker: 2 });
    expect(report.jobs.every(job => job.lang === 'sv')).toBe(true);
    expect((await log()).some(event => event.kind === 'synthesis_failed')).toBe(false);
    await testInfo.attach('worker-recovery', { body: JSON.stringify({ report, flow: await log() }), contentType: 'application/json' });
  } finally {
    await cleanup(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
