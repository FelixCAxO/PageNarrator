import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  launchExtensionContext,
  openCorpusArticle,
  openExtensionPage,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';
import { startCorpusFixtureServer } from './corpus-fixture-server.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('toolbar popup is the only player and narration survives popup close', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
  try {
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');

    await startReadFromToolbarPopup(context, article);
    const reopened = await openExtensionPage(context, 'popup');

    await expect(reopened.locator('#popup-player')).toBeVisible({ timeout: 15_000 });
    // The player is visible while preparing too (with Stop); word counts start with reading.
    await expect(reopened.locator('#popup-progress')).toContainText('words left', { timeout: 15_000 });
    const remainingWords = Number((await reopened.locator('#popup-progress').textContent()).match(/(\d+) words left/)?.[1]);
    expect(remainingWords).toBeGreaterThan(200);
    await expect(reopened.locator('#open-toolbar-player')).toHaveCount(0);
    await expect(reopened.locator('#popup-settings')).not.toHaveAttribute('open', '');
    await reopened.screenshot({ path: testInfo.outputPath('popup-active.png') });
  } finally {
    await cleanup();
    await server.close();
  }
});

test('Read page resumes saved progress instead of flicking back to idle', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
  try {
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    const storagePage = await openExtensionPage(context, 'popup');
    await storagePage.evaluate(({ key }) => chrome.storage.local.set({
      [key]: {
        chunk: 1,
        totalChunks: 3,
        progressPercent: 33,
        excerpt: 'This fixture keeps silent test speech active long enough for playback controls to remain visible after reading begins.',
        title: 'Playback controls long article',
        ts: Date.now(),
      },
    }), { key: `pos:${article.url()}` });
    await storagePage.close();

    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });

    await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 15_000 });
    await expect(popup.locator('#popup-player')).toBeVisible();
    await expect(popup.locator('#popup-previous')).toBeEnabled();
  } finally {
    await cleanup();
    await server.close();
  }
});

test('single popup Pause, Resume, Next, Previous, and Stop controls change engine state once', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
  try {
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    const popup = await startReadFromToolbarPopup(context, article, { closePopup: false });

    await expect(popup.locator('#popup-toggle')).toHaveText('Pause', { timeout: 15_000 });
    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Paused', { timeout: 10_000 });
    await expect(popup.locator('#popup-toggle')).toHaveText('Resume');

    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 10_000 });
    await expect(popup.locator('#popup-toggle')).toHaveText('Pause');

    await popup.locator('#popup-next').click();
    await expect(popup.locator('#popup-previous')).toBeEnabled({ timeout: 10_000 });
    await popup.locator('#popup-previous').click();

    await popup.locator('#popup-stop').click();
    await expect(popup.locator('#popup-status')).toHaveText('Ready to read', { timeout: 10_000 });
    await expect(popup.locator('#popup-idle-actions')).toBeVisible();
  } finally {
    await cleanup();
    await server.close();
  }
});

test('Read selected narrates only the browser selection', async ({}, testInfo) => {
  const server = await startCorpusFixtureServer({ corpusDir: fixtureDir });
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://*/*'], testInfo });
  try {
    await seedFlowTestFlags(context);
    const article = await openCorpusArticle(context, server, 'playback-controls-long.html');
    await article.evaluate(() => {
      const paragraph = document.querySelector('article p');
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await startReadFromToolbarPopup(context, article, { selected: true });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await expect.poll(() => worker.evaluate(() => chrome.storage.session.get('readerEngineState')
      .then((value) => value.readerEngineState?.state || 'idle')), { timeout: 60_000 }).toBe('finished');
    const log = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })
      .then((response) => response?.log || []));
    const spoken = log.filter((entry) => entry.kind === 'chunk_play').map((entry) => entry.speechText).join(' ');
    expect(spoken).toContain('This fixture keeps silent test speech active');
    expect(spoken).not.toContain('The final section lets the queue finish');
  } finally {
    await cleanup();
    await server.close();
  }
});
