import { expect, test } from '@playwright/test';
import { launchExtensionContext, openExtensionPage } from './extension-fixture.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';

test('voice model is easy to reach and switching preserves both sets of controls', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  const downloads = [];
  context.on('request', (request) => {
    if (/huggingface\.co|hf\.co|xethub\.hf\.co/.test(request.url())) downloads.push(request.url());
  });
  try {
    let popup = await openExtensionPage(context, 'popup');
    await popup.setViewportSize({ width: 350, height: 600 });
    const model = popup.locator('#popup-tts-engine');
    await expect(model).toHaveValue('kokoro');
    await expect(model).toBeInViewport();
    await expect(popup.locator('#popup-settings')).not.toHaveAttribute('open', '');
    await popup.screenshot({ path: testInfo.outputPath('kokoro-default.png'), fullPage: true });

    await popup.locator('#popup-settings > summary').click();
    await selectNativeOption(popup.locator('#popup-voice'), 'am_michael');
    await selectNativeOption(model, 'omnivoice');
    await expect(popup.locator('#popup-omnivoice-settings')).toBeVisible();
    await expect(popup.locator('#popup-voice')).toBeHidden();
    await expect(popup.locator('#popup-language')).toBeVisible();
    await expect(popup.locator('#popup-language')).toBeInViewport();
    await expect(popup.locator('#popup-voice-model-help')).toContainText('1.35 GB');
    await selectNativeOption(popup.locator('#popup-language'), 'sv');
    await setNativeRange(popup.locator('#popup-omnivoice-variation'), 4);
    await popup.locator('#popup-omnivoice-whisper').check();
    await expect(popup.locator('#popup-omnivoice-pitch')).toHaveCount(0);
    await expect(popup.locator('#popup-omnivoice-age')).toHaveCount(0);
    await popup.evaluate(() => window.scrollTo(0, 0));
    await popup.screenshot({ path: testInfo.outputPath('omnivoice-controls.png'), fullPage: true });

    await selectNativeOption(model, 'kokoro');
    await expect(popup.locator('#popup-voice')).toHaveValue('am_michael');
    await expect(popup.locator('#popup-omnivoice-settings')).toBeHidden();
    await expect(popup.locator('#popup-language')).toBeHidden();
    await expect.poll(() => popup.evaluate(() => chrome.storage.local.get('playbackSettings')
      .then((value) => value.playbackSettings.ttsEngine))).toBe('kokoro');
    await popup.close();
    popup = await openExtensionPage(context, 'popup');
    await popup.setViewportSize({ width: 280, height: 600 });
    await expect(popup.locator('#popup-tts-engine')).toHaveValue('kokoro');
    await expect(popup.locator('#popup-tts-engine')).toBeInViewport();
    await selectNativeOption(popup.locator('#popup-tts-engine'), 'omnivoice');
    await expect(popup.locator('#popup-settings')).toHaveAttribute('open', '');
    await expect(popup.locator('#popup-language')).toBeInViewport();
    await expect(popup.locator('#popup-omnivoice-variation')).toHaveValue('4');
    await expect(popup.locator('#popup-omnivoice-whisper')).toBeChecked();
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await popup.evaluate(() => window.scrollTo(0, 0));
    await popup.screenshot({ path: testInfo.outputPath('omnivoice-compact.png'), fullPage: true });
    expect(downloads).toEqual([]);
  } finally {
    await cleanup();
  }
});
