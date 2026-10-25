export const ESTIMATED_TIMING_CONFIDENCE = 0.35;
export const PHONEME_TIMING_CONFIDENCE = 0.55;
export const PHONEME_BOUNDARY_TOKENS = new Set(['^', '$', '_']);
export const PHONEME_LENGTH_TOKENS = new Set(['\u02d0', '\u02d1']);
export const PHONEME_STRESS_TOKENS = new Set(['\u02c8', '\u02cc']);
export const SPEECH_WINDOW_THRESHOLD_FLOOR = 0.0005;
export const SPEECH_WINDOW_THRESHOLD_RATIO = 0.015;
export const SPEECH_WINDOW_PADDING_SECONDS = 0.04;
export const SPEECH_WINDOW_MIN_TRIM_SECONDS = 0.08;
export const LANGUAGE_TIMING_PATTERNS = Object.freeze({
  de: /[aeiouy]+/g,
  fr: /eau|au|ai|ei|eu|ou|oi|ui|[aeiouy]+/g,
  nl: /aai|ooi|oei|eeuw|ieuw|ieu|aa|ee|oo|uu|ie|ei|ij|ou|au|eu|ui|oe|[aeiouy]/g,
  sv: /[aeiouy]+/g,
});
export const LANGUAGES_WITH_SILENT_FINAL_E = new Set(['en', 'fr']);
