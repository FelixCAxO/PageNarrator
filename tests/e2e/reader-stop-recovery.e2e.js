import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  launchExtensionContext,
  openCorpusArticle,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

for (const stopAction of ['close source tab', 'press Stop']) {
  test(`${stopAction} during narration cleans up without offscreen errors and permits another read`, async ({}, testInfo) => {
    const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
    const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
    let observer;
    try {
      // Exercise real teardown/event wiring; model inference is irrelevant here.
      await seedFlowTestFlags(context);
      let article = await openCorpusArticle(context, server, 'playback-controls-long.html');
      let popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
      await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 15_000 });
      observer = await observeOffscreenErrors(context);

      if (stopAction === 'close source tab') await article.close();
      else await popup.locator('#popup-stop').click();
      await expect(popup.locator('#popup-status')).toHaveText('Ready to read', { timeout: 10_000 });
      await expect(popup.locator('#popup-idle-actions')).toBeVisible();
      await observer.flush();
      expect(observer.errors, 'stopping must not throw or suppress an offscreen error').toEqual([]);

      // Start-read URL probing intentionally catches validation TypeErrors.
      // Observe caught exceptions around the controls under test, not that probe.
      await observer.close();
      observer = null;
      await popup.close();
      if (article.isClosed()) article = await openCorpusArticle(context, server, 'playback-controls-long.html');
      popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
      await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 15_000 });
      observer = await observeOffscreenErrors(context);
      await popup.locator('#popup-stop').click();
      await expect(popup.locator('#popup-status')).toHaveText('Ready to read', { timeout: 10_000 });
      await observer.flush();
      expect(observer.errors, 'a subsequent read and stop must remain healthy').toEqual([]);
    } finally {
      await observer?.close();
      await cleanup();
      await server.close();
    }
  });
}

test('a configured section pause can pause, resume and stop without offscreen errors', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
  let observer;
  try {
    await seedFlowTestFlags(context);
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => chrome.storage.local.set({
      playbackSettings: { voice: 'af_heart', language: 'en', speed: 3, sectionPauseSeconds: 5 },
    }));
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });
    await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 15_000 });
    observer = await observeOffscreenErrors(context);
    const readLog = () => worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })
      .then((response) => response?.log || []));
    await expect.poll(async () => (await readLog()).filter((entry) => entry.kind === 'chunk_end').length,
      { timeout: 20_000 }).toBeGreaterThan(0);
    await observer.flush();
    expect(observer.errors, 'entering a section pause must not throw even when the event is caught').toEqual([]);
    const playedBeforePause = (await readLog()).filter((entry) => entry.kind === 'chunk_play').length;
    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Paused');
    // Wait past the configured delay: a paused section gap must not advance.
    await popup.waitForTimeout(5_100);
    expect((await readLog()).filter((entry) => entry.kind === 'chunk_play')).toHaveLength(playedBeforePause);
    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Reading');
    await popup.locator('#popup-stop').click();
    await expect(popup.locator('#popup-status')).toHaveText('Ready to read');
    await observer.flush();
    expect(observer.errors, 'resuming and stopping a section pause must not throw or suppress an error').toEqual([]);
  } finally {
    await observer?.close();
    await cleanup();
    await server.close();
  }
});

async function observeOffscreenErrors(context) {
  // Offscreen documents are CDP targets, not Playwright pages; pageerror alone
  // misses the production failure even when the popup eventually returns idle.
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find((info) => info.url.endsWith('/src/reader-engine.html?engine=1'));
  expect(target, 'narration must use the actual offscreen reader').toBeTruthy();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  const errors = [];
  const pending = new Map();
  let sequence = 0;
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const task = pending.get(message.id);
      if (task) {
        pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
      }
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      errors.push(message.params.args.map((argument) => argument.description || argument.value || '').join(' '));
    }
    if (message.method === 'Debugger.paused') {
      const error = message.params.data;
      // Extension event dispatch can catch exceptions without a Runtime event.
      // Record TypeErrors even when caught; expected cancellation is not a bug.
      if (error?.className === 'TypeError' || /^TypeError:/.test(error?.description || '')) errors.push(error.description);
      void send('Debugger.resume').catch((error) => errors.push(error.message));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  await send('Runtime.enable');
  await send('Debugger.enable');
  await send('Debugger.setPauseOnExceptions', { state: 'all' });
  return {
    errors,
    flush: () => send('Runtime.evaluate', { expression: 'Promise.resolve(true)', awaitPromise: true }),
    close: () => cdp.detach(),
  };
}
