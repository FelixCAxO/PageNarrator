import { test, expect } from '@playwright/test';
import { installTrustedUiEventBoundary } from '../../src/lib/trusted-ui-events.js';
import { createReaderEngineController } from '../../src/ui/reader-engine/reader-engine-controller.js';

// This browser-native source test needs no extension build or model download.
test.use({ launchOptions: { args: [] } });

test.beforeEach(async ({ page }) => {
  await page.setContent(`
    <button id="read" type="button">Read</button>
    <input id="jump" aria-label="Section">
    <form id="voice"><input id="name" required value="Voice"><button id="save">Save</button></form>
  `);
  await page.addScriptTag({ content: `(${installTrustedUiEventBoundary.toString()})(document);` });
  await page.addScriptTag({ content: `
    const createController = (${createReaderEngineController.toString()});
    window.effects = [];
    window.edits = [];
    for (const type of ['input', 'change']) {
      document.getElementById('name').addEventListener(type, () => window.edits.push(type));
    }
    createController().bind({
      document,
      els: { read: document.getElementById('read'), queueJumpInput: document.getElementById('jump') },
      actions: {
        handlePrimaryAction: () => window.effects.push('read'),
        jumpToEnteredChunk: () => window.effects.push('jump'),
        handleVoiceModelVisibilityChange: () => window.effects.push('visibility'),
      },
    });
    document.getElementById('voice').addEventListener('submit', (event) => {
      event.preventDefault();
      window.effects.push('save');
    });
  ` });
});

test('rejects script-dispatched click/Enter and native requestSubmit without activation', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('read').click();
    document.getElementById('read').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('jump').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.getElementById('voice').requestSubmit(document.getElementById('save'));
  });
  expect(await page.evaluate(() => window.effects)).toEqual([]);
});

test('preserves native mouse and Enter/Space button activation and section Enter', async ({ page }) => {
  await page.locator('#read').click();
  await page.locator('#read').press('Enter');
  await page.locator('#read').press('Space');
  await page.locator('#jump').press('Enter');
  expect(await page.evaluate(() => window.effects)).toEqual(['read', 'read', 'read', 'jump']);
});

test('preserves real submit-button clicks and implicit Enter submission', async ({ page }) => {
  await page.locator('#save').click();
  await page.locator('#name').press('Enter');
  expect(await page.evaluate(() => window.effects)).toEqual(['save', 'save']);
  await page.evaluate(() => document.getElementById('voice').requestSubmit(document.getElementById('save')));
  expect(await page.evaluate(() => window.effects)).toEqual(['save', 'save']);
});

test('preserves actual field input while rejecting scripted input/change events', async ({ page }) => {
  await page.locator('#name').fill('Updated voice');
  await page.locator('#name').press('Tab');
  expect(await page.evaluate(() => window.edits)).toEqual(['input', 'change']);
  await page.evaluate(() => {
    const field = document.getElementById('name');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await page.evaluate(() => window.edits)).toEqual(['input', 'change']);
});

test('does not retain submission permission after invalid or canceled user clicks', async ({ page }) => {
  await page.locator('#name').fill('');
  await page.evaluate(() => document.getElementById('name').addEventListener('invalid', (event) => {
    event.target.value = 'Filled by script';
    document.getElementById('voice').requestSubmit(document.getElementById('save'));
  }, { once: true }));
  await page.locator('#save').click();
  await page.evaluate(() => { document.getElementById('name').value = 'Filled by script'; });
  await page.evaluate(() => document.getElementById('voice').requestSubmit(document.getElementById('save')));
  expect(await page.evaluate(() => window.effects)).toEqual([]);

  await page.evaluate(() => document.getElementById('save').addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('voice').requestSubmit(document.getElementById('save'));
  }, { once: true }));
  await page.locator('#save').click();
  await page.evaluate(() => document.getElementById('voice').requestSubmit(document.getElementById('save')));
  expect(await page.evaluate(() => window.effects)).toEqual([]);
});

test('rejects scripted lifecycle events and preserves native page teardown', async ({ page }) => {
  const teardownEvents = [];
  page.on('console', (message) => {
    if (message.text() === 'native-page-teardown') teardownEvents.push(message.text());
  });
  await page.evaluate(() => {
    window.addEventListener('pagehide', () => console.log('native-page-teardown'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  expect(await page.evaluate(() => window.effects)).toEqual([]);
  expect(teardownEvents).toEqual([]);
  await page.goto('data:text/html,Next document');
  expect(teardownEvents).toEqual(['native-page-teardown']);
});
