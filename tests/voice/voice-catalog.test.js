import { describe, expect, it } from 'vitest';
import {
  KOKORO_MODEL_REVISION,
  getDefaultVoiceId,
  getVoiceById,
  getVoiceOptions,
  getVoicesForDetectedLanguage,
} from '../../src/tts/voices/voice-registry.js';

import { getLanguageOptions, getSelectableVoicesForLanguage, getUnsupportedLanguageMessage, resolveVoiceSelection } from '../../src/tts/voices/language-voice-options.js';

describe('built-in Kokoro catalog', () => {
  it('keeps the default voice and voice IDs unchanged', () => {
    const voices = getVoiceOptions();
    expect(getDefaultVoiceId()).toBe('af_heart');
    expect(voices.every(voice => voice.engine === 'kokoro' && voice.license === 'Apache-2.0')).toBe(true);
    expect(getVoiceById('piper-sv-se-nst-medium')).toBeNull();
    expect(KOKORO_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.stringify(voices)).not.toMatch(/piper|browser|custom-voice/i);
    expect(voices.every(voice => voice.kokoroVoiceDownloadUrl.includes(`/resolve/${KOKORO_MODEL_REVISION}/voices/`))).toBe(true);
    expect(getVoiceOptions().map((voice) => voice.id)).toMatchInlineSnapshot(`
      [
        "af_heart",
        "af_aoede",
        "af_bella",
        "af_kore",
        "af_nicole",
        "af_sarah",
        "am_fenrir",
        "am_michael",
        "am_puck",
        "bf_emma",
      ]
    `);
  });

  it('keeps voice choices unchanged while removing bundled file paths', () => {
    expect(getVoiceOptions().map((voice) => ({
      id: voice.id,
      label: voice.label,
      engine: voice.engine,
      lang: voice.lang,
      detectCode: voice.detectCode,
      gender: voice.gender,
      quality: voice.quality,
      status: voice.status,
      localKokoroVoicePath: voice.localKokoroVoicePath || null,
      localModelPath: voice.localModelPath || null,
      localConfigPath: voice.localConfigPath || null,
      license: voice.license,
    }))).toMatchInlineSnapshot(`
      [
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_heart",
          "label": "Heart - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "A",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_aoede",
          "label": "Aoede - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_bella",
          "label": "Bella - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "A-",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_kore",
          "label": "Kore - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_nicole",
          "label": "Nicole - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "B-",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "af_sarah",
          "label": "Sarah - American female",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "male",
          "id": "am_fenrir",
          "label": "Fenrir - American male",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "male",
          "id": "am_michael",
          "label": "Michael - American male",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "male",
          "id": "am_puck",
          "label": "Puck - American male",
          "lang": "en-US",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "C+",
          "status": "on-demand",
        },
        {
          "detectCode": "en",
          "engine": "kokoro",
          "gender": "female",
          "id": "bf_emma",
          "label": "Emma - British female",
          "lang": "en-GB",
          "license": "Apache-2.0",
          "localConfigPath": null,
          "localKokoroVoicePath": null,
          "localModelPath": null,
          "quality": "B-",
          "status": "on-demand",
        },
      ]
    `);
  });

  it('maps language choices to the complete approved English catalog', () => {
    expect(getLanguageOptions()).toEqual([{ code: 'en', label: 'English', lang: 'en-US' }]);
    expect(getSelectableVoicesForLanguage('en-US')).toEqual(getVoiceOptions());
    expect(getSelectableVoicesForLanguage('sv')).toEqual([]);
  });

  it('normalizes saved voice IDs and rejects removed engines', () => {
    expect(resolveVoiceSelection('kokoro-af-heart', 'en')?.id).toBe('af_heart');
    expect(resolveVoiceSelection('piper-sv-se-nst-medium', 'en')?.id).toBe('af_heart');
    expect(resolveVoiceSelection('custom-voice:studio', 'en')?.id).toBe('af_heart');
    expect(getUnsupportedLanguageMessage()).toContain('Other languages are not supported');
  });

  it('offers English voices as the explicit fallback for unsupported detected languages', () => {
    expect(getVoicesForDetectedLanguage('en').bundled).toEqual(getVoiceOptions());
    const swedish = getVoicesForDetectedLanguage('sv');
    expect(swedish.bundled).toEqual([]);
    expect(swedish.downloadable).toEqual([]);
    expect(swedish.fallback).toEqual(getVoiceOptions());
  });
});
