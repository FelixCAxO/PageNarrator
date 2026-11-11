import { getOmniVoiceLanguage } from '../tts/omnivoice/languages.js';

const MIN_DETECTION_SAMPLE_LENGTH = 80;
const MAX_DETECTION_SAMPLE_LENGTH = 3000;
const RELIABLE_PERCENT = 70;
const RELIABLE_MARGIN = 20;

export function normalizeDetectionSample(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?;:'"()/\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETECTION_SAMPLE_LENGTH);
}

export async function detectPageLanguage(text, { i18n = globalThis.chrome?.i18n } = {}) {
  const sample = normalizeDetectionSample(text);

  if (sample.length < MIN_DETECTION_SAMPLE_LENGTH || typeof i18n?.detectLanguage !== 'function') {
    return createUnknownDetection();
  }

  let result;
  try { result = await i18n.detectLanguage(sample); }
  catch { return createUnknownDetection(); }
  const [best, second = { percentage: 0 }] = (result?.languages || [])
    .filter(item => typeof item?.language === 'string' && Number.isFinite(item.percentage))
    .sort((left, right) => right.percentage - left.percentage);

  if (!best?.language) return createUnknownDetection();

  const percent = Number.isFinite(best.percentage) ? best.percentage : 0;
  const margin = percent - (Number(second.percentage) || 0);
  return {
    code: best.language,
    percent,
    margin,
    reliable: result.isReliable === true && best.language !== 'und' && percent >= RELIABLE_PERCENT && margin >= RELIABLE_MARGIN,
  };
}

// Codes pages declare that the voice catalog files under another code.
const DECLARED_LANGUAGE_ALIASES = { nb: 'no', nn: 'no', iw: 'he' };

/** Supported language a page declares in <html lang>, or null. @param {unknown} lang */
export function getDeclaredPageLanguage(lang) {
  const value = String(lang || '').trim().toLowerCase();
  if (!value) return null;
  const primary = value.split(/[-_]/u)[0];
  return getOmniVoiceLanguage(DECLARED_LANGUAGE_ALIASES[primary] || value)?.code
    || getOmniVoiceLanguage(DECLARED_LANGUAGE_ALIASES[primary] || primary)?.code || null;
}

/** Chrome's text detection; the page's declared language when detection is unknown or unreliable. */
export async function detectArticleLanguage({ pageLanguage, text } = {}, options = {}) {
  const detected = await detectPageLanguage(text, options);
  if (detected.reliable) return { ...detected, source: 'text' };
  // Template defaults like lang="en" are often wrong, so the declared language only backs up detection.
  const declared = getDeclaredPageLanguage(pageLanguage);
  return declared ? { code: declared, percent: 100, margin: 100, reliable: true, source: 'page' } : { ...detected, source: 'text' };
}

export function shouldAutoSelectDetectedLanguage(detected) {
  return Boolean(detected?.reliable && detected.percent >= RELIABLE_PERCENT && detected.margin >= RELIABLE_MARGIN);
}

function createUnknownDetection() {
  return {
    code: 'und',
    percent: 0,
    margin: 0,
    reliable: false,
  };
}
