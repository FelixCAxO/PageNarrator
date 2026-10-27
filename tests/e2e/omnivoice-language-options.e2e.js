import { test, expect } from '@playwright/test';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags } from './extension-fixture.js';
import { selectNativeOption } from './native-controls-fixture.js';

for (const locale of ['en', 'sv']) {
  test(`OmniVoice shows full language names sorted in ${locale}`, async ({}, testInfo) => {
    const { context, cleanup } = await launchExtensionContext({ testInfo, locale });
    try {
      await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'omnivoice', language: 'sv' } });
      const popup = await openExtensionPage(context, 'popup');
      const language = popup.locator('#popup-language');
      await expect(language).toHaveValue('sv');
      await expect(language.locator('option')).toHaveCount(32);
      const options = await language.evaluate(select => [...select.options].map(option => ({ code: option.value, label: option.textContent })));
      expect(options.filter(option => option.label === option.code).map(option => option.code).join(', ')).toBe('');
      expect(options.map(option => option.code)).not.toContain('sol');
      expect(new Set(options.map(option => option.label)).size).toBe(options.length);
      const labels = options.map(option => option.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, locale)));
      await popup.locator('#popup-settings > summary').click();
      for(const code of ['yue','th']){
        await selectNativeOption(language,code);
        const whisper=popup.locator('#popup-omnivoice-whisper');
        await expect(whisper).toBeEnabled();
        await whisper.setChecked(true);
        await expect.poll(()=>popup.evaluate(async()=>(await chrome.storage.local.get('playbackSettings')).playbackSettings))
          .toMatchObject({language:code,omniVoice:{whisper:true}});
        await popup.reload();
        await expect(language).toHaveValue(code);
        await expect(whisper).toBeChecked();
        await expect(whisper).toBeEnabled();
        await expect(popup.locator('#popup-voice-model-help')).toContainText(locale==='sv'?'Varning: Viskning kan utelämna ord':'Warning: Whisper can omit words');
        await popup.locator('#popup-settings > summary').click();
      }
      await selectNativeOption(language,'sv');
      await expect(popup.locator('#popup-omnivoice-whisper')).toBeEnabled();
      await expect(popup.locator('#popup-voice-model-help')).not.toContainText(locale==='sv'?'Varning:':'Warning:');
    } finally {
      await cleanup();
    }
  });
}
