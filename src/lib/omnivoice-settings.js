import { getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';
import { getOmniVoiceVoiceLanguage, getOmniVoiceVoices, getOmniVoicePreset, getOmniVoiceLegacyVoice } from '../tts/omnivoice/preset-seeds.js';

export const VOICE_ENGINE_HELP = Object.freeze({
  kokoro: 'Ten English voices. Other languages switch to OmniVoice when supported. First setup: about 93 MB on CPU or 326 MB on GPU. Another voice needs about 0.5 MB. Your saved voice is kept.',
  omnivoice: 'Experimental. 32 language entries; quality varies. Requires WebGPU with fp16 and about 1.35 GB of downloads. Choose a voice, variation, or whisper.',
  'omnivoice-clone': 'Read with a personal voice preset. Voice samples and narration stay on this device. Requires WebGPU with fp16.',
});
// voices: the stable voice ID chosen per catalog language. variation: a v1.0.4 choice, used where no voice is chosen.
export const DEFAULT_OMNIVOICE_SETTINGS = Object.freeze({ gender: 'female', voices: Object.freeze({}), whisper: false });
export const OMNIVOICE_WHISPER_WARNING = 'Warning: Whisper can omit words in this language. Check the reading against the text.';

/** @param {unknown} value */
export function isOmniVoiceProfile(value) {
  return value === 'omnivoice' || value === 'omnivoice-clone';
}

/** @param {any} [navigator] */
export async function canUseOmniVoice(navigator = globalThis.navigator) {
  try { return Boolean((await navigator?.gpu?.requestAdapter?.())?.features?.has?.('shader-f16')); }
  catch { return false; }
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

/** @param {unknown} language */
const voiceLanguage = language => getOmniVoiceVoiceLanguage(getOmniVoiceLanguage(language)?.code);

/** @param {any} [settings] @param {string|null} [language] */
export function normalizeOmniVoiceSettings(settings = {}, language = null) {
  const gender = settings?.gender === 'male' ? 'male' : 'female';
  // Keep only voices that still ship for the language they were chosen in.
  const voices = Object.fromEntries(Object.entries(settings?.voices && typeof settings.voices === 'object' ? settings.voices : {})
    .filter(([lang, id]) => getOmniVoicePreset(id)?.lang === lang));
  return {
    gender,
    voices,
    ...(Number.isInteger(settings?.variation) && settings.variation >= 1 && settings.variation <= 10 ? { variation: settings.variation } : {}),
    whisper: settings?.whisper === true && (language === null || isOmniVoiceWhisperAvailable(language)),
  };
}

/** The voice these settings play in this language: the chosen voice, else the v1.0.4 choice, else the first listed.
 * @param {any} settings @param {unknown} language */
export function resolveOmniVoicePreset(settings, language) {
  const config = normalizeOmniVoiceSettings(settings);
  const lang = voiceLanguage(language);
  const chosen = getOmniVoicePreset(config.voices[lang]);
  if (chosen?.gender === config.gender) return chosen;
  return /** @type {import('../tts/omnivoice/preset-seeds.js').OmniVoicePreset} */ (getOmniVoicePreset(
    getOmniVoiceLegacyVoice(lang, config.gender, config.variation) ?? getOmniVoiceVoices(lang, config.gender)[0]));
}

/** Picker position (1-based) of the playing voice among this language's voices of its gender.
 * @param {any} settings @param {unknown} language */
export function getOmniVoicePickerState(settings, language) {
  const config = normalizeOmniVoiceSettings(settings, getOmniVoiceLanguage(language)?.code ?? null);
  const voices = getOmniVoiceVoices(voiceLanguage(language), config.gender);
  return { gender: config.gender, rank: voices.indexOf(resolveOmniVoicePreset(config, language).id) + 1, count: voices.length, whisper: config.whisper };
}

/** Settings after a picker change. A new gender shows that gender's voice; a new position chooses that voice for this language only.
 * @param {any} settings @param {unknown} language @param {{gender?:unknown, rank?:unknown, whisper?:unknown}} picker */
export function applyOmniVoicePicker(settings, language, { gender, rank, whisper }) {
  const current = normalizeOmniVoiceSettings(settings);
  const next = { ...current, gender: gender === 'male' ? 'male' : 'female', whisper: whisper === true };
  if (next.gender === current.gender && Number(rank) !== getOmniVoicePickerState(current, language).rank) {
    const id = getOmniVoiceVoices(voiceLanguage(language), next.gender)[Number(rank) - 1];
    if (id) next.voices = { ...current.voices, [voiceLanguage(language)]: id };
  }
  return normalizeOmniVoiceSettings(next, getOmniVoiceLanguage(language)?.code ?? null);
}

/** Show the picker for this language: the slider has one step per voice of the chosen gender.
 * @param {any} els @param {ReturnType<typeof getOmniVoicePickerState>} state @param {unknown} language */
export function renderOmniVoicePicker(els, { gender, rank, count, whisper }, language) {
  if (els.omniVoiceGender) els.omniVoiceGender.value = gender;
  if (els.omniVoiceVariation) {
    els.omniVoiceVariation.max = String(count);
    els.omniVoiceVariation.value = String(rank);
  }
  if (els.omniVoiceVariationOut) els.omniVoiceVariationOut.textContent = `${rank} / ${count}`;
  if (els.omniVoiceWhisper) {
    els.omniVoiceWhisper.checked = whisper;
    els.omniVoiceWhisper.disabled = !isOmniVoiceWhisperAvailable(language);
  }
}

/** Settings after the user moved the picker controls. @param {any} els @param {any} settings @param {unknown} language */
export function readOmniVoicePicker(els, settings, language) {
  return applyOmniVoicePicker(settings, language, { gender: els.omniVoiceGender?.value, rank: els.omniVoiceVariation?.value, whisper: els.omniVoiceWhisper?.checked });
}

/** @param {string} text @param {string} gender @param {boolean} [useGenderCue] */
export function createOmniVoiceInstruction(text, gender, useGenderCue = true) {
  return useGenderCue ? (/[一-鿿]/u.test(text) ? (gender === 'female' ? '女' : '男') : gender) : '';
}

/** @param {string} text @param {any} voice */
export function createOmniVoiceRequest(text, voice) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('OmniVoice requires 1–2000 characters per chunk.');
  const language = getOmniVoiceLanguage(voice?.detectCode);
  if (!language) throw new Error('Choose a supported OmniVoice language.');
  if (voice?.personalReference) {
    return { text: text.trim(), lang: language.code, instruct: '', speed: 1,
      speakerId: voice.personalReference.id, seed: 42, numStep: 24, personalReference: voice.personalReference };
  }
  const settings = normalizeOmniVoiceSettings(voice.omniVoice, language.code);
  const preset = resolveOmniVoicePreset(settings, language.code);
  return { text: text.trim(), lang: language.code, instruct: createOmniVoiceInstruction(text, preset.gender, preset.genderCue), speed: preset.speed,
    speakerId: preset.id, seed: preset.seed, numStep: preset.numStep,
    ...(preset.guidanceScale !== 2 ? { guidanceScale: preset.guidanceScale } : {}),
    ...(preset.pronunciationVariant !== null ? { pronunciationVariant: preset.pronunciationVariant } : {}),
    ...(settings.whisper ? { whisper: true } : {}) };
}
