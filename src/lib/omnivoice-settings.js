import { getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';
import { OMNIVOICE_VARIATION_ORDER } from '../tts/omnivoice/variation-order.js';
import { getOmniVoicePresetSeed, getOmniVoicePresetNumStep, hasOmniVoicePresetGenderCue, getOmniVoicePresetGuidanceScale, getOmniVoicePresetSpeed, getOmniVoicePresetPronunciationVariant } from '../tts/omnivoice/preset-seeds.js';

export const VOICE_ENGINE_HELP = Object.freeze({
  kokoro: 'Ten English voices. First setup: about 93 MB on CPU or 326 MB on GPU. Another voice needs about 0.5 MB. Your saved voice is kept.',
  omnivoice: 'Experimental. 32 language entries; quality varies. Requires WebGPU with fp16 and about 1.35 GB of downloads. Choose a voice, variation, or whisper.',
});
export const DEFAULT_OMNIVOICE_SETTINGS = Object.freeze({ gender: 'female', variation: OMNIVOICE_VARIATION_ORDER.en.female[0], whisper: false });
export const OMNIVOICE_WHISPER_WARNING = 'Warning: Whisper can omit words in this language. Check the reading against the text.';
/** @param {unknown} language @param {unknown} gender */
export function getOmniVoiceVariationOrder(language, gender) {
  const code = getOmniVoiceLanguage(language)?.code;
  const order = OMNIVOICE_VARIATION_ORDER[code] || OMNIVOICE_VARIATION_ORDER.en;
  return order[gender === 'male' ? 'male' : 'female'];
}
/** @param {unknown} code */
export function isOmniVoiceWhisperAvailable(code) {
  const language = getOmniVoiceLanguage(code);
  return Boolean(language);
}
/** @param {unknown} code */
export function hasOmniVoiceWhisperWordLossRisk(code) {
  return ['yue', 'th'].includes(getOmniVoiceLanguage(code)?.code || '');
}

/** @param {any} [settings] @param {string|null} [language] */
export function normalizeOmniVoiceSettings(settings = {}, language = null) {
  const gender = settings?.gender === 'male' ? 'male' : 'female';
  return {
    gender,
    variation: Number.isInteger(settings?.variation) && settings.variation >= 1 && settings.variation <= 10
      ? settings.variation : getOmniVoiceVariationOrder(language, gender)[0],
    whisper: settings?.whisper === true && (language === null || isOmniVoiceWhisperAvailable(language)),
  };
}

/** @param {string} text @param {string} gender @param {boolean} [useGenderCue] */
export function createOmniVoiceInstruction(text, gender, useGenderCue = true) {
  return useGenderCue ? (/[\u4e00-\u9fff]/u.test(text) ? (gender === 'female' ? '女' : '男') : gender) : '';
}

/** @param {string} text @param {any} voice */
export function createOmniVoiceRequest(text, voice) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('OmniVoice requires 1–2000 characters per chunk.');
  const language = getOmniVoiceLanguage(voice?.detectCode);
  if (!language) throw new Error('Choose a supported OmniVoice language.');
  const settings = normalizeOmniVoiceSettings(voice.omniVoice, language.code);
  const instruct = createOmniVoiceInstruction(text, settings.gender, hasOmniVoicePresetGenderCue(language.code, settings.gender, settings.variation));
  const guidanceScale = getOmniVoicePresetGuidanceScale(language.code, settings.gender, settings.variation);
  const pronunciationVariant = getOmniVoicePresetPronunciationVariant(language.code, settings.gender, settings.variation);
  return { text: text.trim(), lang: language.code, instruct, speed: getOmniVoicePresetSpeed(language.code, settings.gender, settings.variation),
    speakerId: `${settings.gender}-${settings.variation}`, seed: getOmniVoicePresetSeed(language.code, settings.gender, settings.variation),
    numStep: getOmniVoicePresetNumStep(language.code, settings.gender, settings.variation),
    ...(guidanceScale !== 2 ? { guidanceScale } : {}),
    ...(pronunciationVariant !== null ? { pronunciationVariant } : {}),
    ...(settings.whisper ? { whisper: true } : {}) };
}
