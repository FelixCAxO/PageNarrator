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

  const result = await i18n.detectLanguage(sample);
  const [best, second = { percentage: 0 }] = result?.languages || [];

  if (!best?.language) return createUnknownDetection();

  const percent = Number.isFinite(best.percentage) ? best.percentage : 0;
  const margin = percent - (Number(second.percentage) || 0);
  return {
    code: best.language,
    percent,
    margin,
    reliable: best.language !== 'und' && percent >= RELIABLE_PERCENT && margin >= RELIABLE_MARGIN,
  };
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
