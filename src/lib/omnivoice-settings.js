import { getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';

export const VOICE_ENGINE_HELP = Object.freeze({
  kokoro: 'Ten English voices. First setup: about 93 MB on CPU or 326 MB on GPU. Another voice needs about 0.5 MB. Your saved voice is kept.',
  omnivoice: 'Experimental. 32 language entries; quality varies. Requires WebGPU with fp16 and about 1.35 GB of downloads. Choose a voice, variation, or whisper.',
});
export const DEFAULT_OMNIVOICE_SETTINGS = Object.freeze({ gender: 'female', variation: 1, whisper: false });
export const OMNIVOICE_WHISPER_WARNING = 'Warning: Whisper can omit words in this language. Check the reading against the text.';
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
  return {
    gender: settings?.gender === 'male' ? 'male' : 'female',
    variation: Number.isInteger(settings?.variation) && settings.variation >= 1 && settings.variation <= 10 ? settings.variation : 1,
    whisper: settings?.whisper === true && (language === null || isOmniVoiceWhisperAvailable(language)),
  };
}

/** @param {string} text @param {any} voice */
export function createOmniVoiceRequest(text, voice) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('OmniVoice requires 1–2000 characters per chunk.');
  const language = getOmniVoiceLanguage(voice?.detectCode);
  if (!language) throw new Error('Choose a supported OmniVoice language.');
  const settings = normalizeOmniVoiceSettings(voice.omniVoice);
  // Keep the gender cue; the fixed reference carries age and pitch in both playback modes.
  const instruct = /[\u4e00-\u9fff]/u.test(text) ? (settings.gender === 'female' ? '女' : '男') : settings.gender;
  return { text: text.trim(), lang: language.code, instruct, speed: 1,
    speakerId: `${settings.gender}-${settings.variation}`, seed: 41 + settings.variation, numStep: language.code === 'tr' ? 32 : 24,
    ...(settings.whisper ? { whisper: true } : {}) };
}
