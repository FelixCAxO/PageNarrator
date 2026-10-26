// @ts-check
import { getVoiceOptions, normalizeStoredVoiceId } from './voice-registry.js';
import { getOmniVoiceLanguage } from '../omnivoice/languages.js';
import { getMessage, t, languageName } from '../../lib/i18n.js';

const ENGLISH = Object.freeze({ code: 'en', label: 'English', lang: 'en-US' });
const LANGUAGE_LABELS = Object.freeze({ en: 'English', sv: 'Swedish', de: 'German', fr: 'French', nl: 'Dutch' });

export function getLanguageOptions() {
  return [ENGLISH];
}

export function getLanguageOption(code) {
  const normalized = normalizeLanguageCode(code);
  if (normalized === 'en') return ENGLISH;
  const omniVoice = getOmniVoiceLanguage(normalized);
  if (omniVoice) return omniVoice;
  return { code: normalized, label: LANGUAGE_LABELS[normalized] || normalized.toUpperCase(), lang: normalized };
}

export function normalizeLanguageCode(code) {
  const value = String(code || '').trim().toLowerCase();
  return !value || value === 'und' ? 'en' : getOmniVoiceLanguage(value)?.code || value.split('-')[0];
}

export function getSelectableVoicesForLanguage(languageCode) {
  const code = normalizeLanguageCode(languageCode);
  return code === 'en'
    ? getVoiceOptions().filter((voice) => voice.detectCode === 'en')
    : [];
}

export function groupVoicesByQuality(voices = []) {
  /** @type {{ gradedVoices: any[], experimentalVoices: any[] }} */
  const grouped = { gradedVoices: [], experimentalVoices: [] };
  for (const voice of Array.isArray(voices) ? voices : []) {
    grouped[isExperimentalVoice(voice) ? 'experimentalVoices' : 'gradedVoices'].push(voice);
  }
  return grouped;
}

export function isExperimentalVoice(voice) {
  const quality = String(voice?.quality || '').trim().toLowerCase();
  return voice?.engine === 'kokoro' && (!quality || !['a', 'a-', 'b+', 'b', 'b-', 'c+'].includes(quality));
}

export function formatVoiceOptionLabel(voice) {
  if (!voice) return '';
  const descriptions = { 'American female': t('American female'), 'American male': t('American male'), 'British female': t('British female') };
  const [name, description] = voice.label.split(' - ');
  const label = descriptions[description] ? `${name} - ${descriptions[description]}` : voice.label;
  return isExperimentalVoice(voice) && voice.quality ? `${label} (${voice.quality})` : label;
}

export function resolveVoiceSelection(voiceId, languageCode) {
  const voices = getSelectableVoicesForLanguage(languageCode);
  const value = String(voiceId || '').trim();
  const normalized = normalizeStoredVoiceId(value);
  return voices.find((voice) => voice.id === normalized) || voices[0] || null;
}

export function getDetectedLanguageSuggestion(detected, engine = 'kokoro') {
  if (!detected?.reliable || !detected?.code || detected.code === 'und') return null;
  const language = getOmniVoiceLanguage(detected.code);
  if (!language) return null;
  const supported = engine === 'omnivoice' || language.code === 'en';
  return { code: language.code, label: language.label, engine: supported ? engine : 'omnivoice', supported };
}

export function getUnsupportedLanguageMessage(code) {
  const language = getOmniVoiceLanguage(code);
  const label = language ? languageName(language.code, language.label) : '';
  return language && language.code !== 'en'
    ? getMessage('languageSuggestionOmniVoice', [label], {
      fallback: `Detected ${label}. Kokoro supports English. Choose OmniVoice and ${label} in Voice settings to read this text.`,
    })
    : t('Choose an English Kokoro voice. Other languages are not supported.');
}
