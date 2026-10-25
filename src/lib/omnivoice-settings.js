import { getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';

export const VOICE_ENGINE_HELP = Object.freeze({
  kokoro: 'Ten English voices. First setup: about 93 MB on CPU or 326 MB on GPU. Another voice needs about 0.5 MB. Your saved voice is kept.',
  omnivoice: 'Experimental. 646 language entries; quality varies. Requires WebGPU with fp16 and about 1.35 GB of downloads. Choose a voice, variation, or whisper.',
});
export const DEFAULT_OMNIVOICE_SETTINGS = Object.freeze({ gender: 'female', variation: 1, whisper: false });

/** @param {any} [settings] */
export function normalizeOmniVoiceSettings(settings = {}) {
  return {
    gender: settings?.gender === 'male' ? 'male' : 'female',
    variation: Number.isInteger(settings?.variation) && settings.variation >= 1 && settings.variation <= 10 ? settings.variation : 1,
    whisper: settings?.whisper === true,
  };
}

/** @param {string} text @param {any} voice */
export function createOmniVoiceRequest(text, voice) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('OmniVoice requires 1–2000 characters per chunk.');
  const language = getOmniVoiceLanguage(voice?.detectCode);
  if (!language) throw new Error('Choose a supported OmniVoice language.');
  const settings = normalizeOmniVoiceSettings(voice.omniVoice);
  // Match upstream _resolve_instruct: the text's Han characters select tag language and punctuation.
  const chinese = /[\u4e00-\u9fff]/u.test(text);
  const tags = chinese
    ? [settings.gender === 'female' ? '女' : '男']
    : [settings.gender];
  // Combining whisper with fixed age/pitch instructions can produce unrelated speech.
  if (settings.whisper) tags.push(chinese ? '耳语' : 'whisper');
  else tags.push(...(chinese ? ['青年', '中音调'] : ['young adult', 'moderate pitch']));
  return { text: text.trim(), lang: language.code, instruct: tags.join(chinese ? '，' : ', '), speed: 1, seed: 41 + settings.variation, numStep: 24 };
}
