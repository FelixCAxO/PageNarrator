import { t } from './i18n.js';

export const ERROR_REGISTRY = Object.freeze({
  tab_url_hidden: {
    code: 'tab_url_hidden',
    title: 'Open from the page',
    cause: 'Chrome did not grant access to the active tab.',
    message: 'Open the page, click the PageNarrator icon, then choose Read page.',
    actionLabel: 'Open from page',
    recoveryHint: 'Open the page, click the PageNarrator icon, then choose Read page.',
  },
  unscriptable_url: {
    code: 'unscriptable_url',
    message: 'Protected Chrome pages cannot be read. Open a webpage or PDF.',
    actionLabel: 'Open page',
    recoveryHint: 'Protected Chrome pages cannot be read. Open a webpage or PDF.',
  },
  host_permission_required: {
    code: 'host_permission_required',
    title: 'Page access needed',
    cause: 'PageNarrator needs access to this site.',
    message: 'Allow site access from the PageNarrator icon, then retry.',
    actionLabel: 'Grant access',
    recoveryHint: 'Allow site access from the PageNarrator icon, then retry.',
  },
  storage_quota: {
    code: 'storage_quota',
    message: 'Free browser storage, then retry.',
    actionLabel: 'Free storage',
    recoveryHint: 'Free browser storage, then retry.',
  },
  voice_language_mismatch: {
    code: 'voice_language_mismatch',
    message: 'Choose a voice for this page’s language.',
    actionLabel: 'Choose voice',
    recoveryHint: 'Choose a voice for this page’s language.',
  },
  tab_closed: {
    code: 'tab_closed',
    cause: 'The active tab closed before reading could start.',
    message: 'The tab closed. Reopen the page and retry.',
    actionLabel: 'Try again',
    recoveryHint: 'The tab closed. Reopen the page and retry.',
  },
  empty_selection: {
    code: 'empty_selection',
    title: 'No selected text',
    cause: 'No text is selected.',
    message: 'No text is selected.',
    actionLabel: 'Select text',
    recoveryHint: 'Select the text you want to hear, then choose Read selected.',
  },
  scanned_pdf_unsupported: {
    code: 'scanned_pdf_unsupported',
    title: 'Text recognition required',
    cause: 'Some PDF text could not be read reliably.',
    message: 'Some PDF text could not be read reliably.',
    actionLabel: 'Use a text-based PDF',
    recoveryHint: 'Use text recognition (OCR) or a PDF with a complete text layer.',
  },
  captcha: {
    code: 'captcha',
    message: 'Complete the CAPTCHA on the page, then retry.',
    actionLabel: 'Try again',
    recoveryHint: 'Complete the CAPTCHA on the page, then retry.',
  },
  login_wall: {
    code: 'login_wall',
    message: 'Sign in to the site, then retry.',
    actionLabel: 'Sign in',
    recoveryHint: 'Sign in to the site, then retry.',
  },
  article_text_not_found: {
    code: 'article_text_not_found',
    title: 'No readable article found',
    cause: 'No readable article text was found.',
    message: 'No readable article text was found.',
    actionLabel: 'Try another page',
    recoveryHint: 'Select a passage and choose Read selected, or open another article.',
  },
  model_setup_failed: {
    code: 'model_setup_failed',
    title: 'Voice setup failed',
    cause: 'The voice did not finish loading.',
    message: 'The voice did not finish loading.',
    actionLabel: 'Try again',
    recoveryHint: 'Choose Prepare voice to retry setup.',
  },
  tts_generation_failed: {
    code: 'tts_generation_failed',
    title: 'Speech generation failed',
    cause: 'Speech generation stopped before audio was ready.',
    message: 'Speech generation stopped before audio was ready.',
    actionLabel: 'Try again',
    recoveryHint: 'Retry, or choose another voice.',
  },
  pdf_corrupt: {
    code: 'pdf_corrupt',
    title: 'Unsupported PDF',
    cause: 'This PDF is damaged or unsupported.',
    message: 'This PDF is damaged or unsupported.',
    actionLabel: 'Try another PDF',
    recoveryHint: 'This PDF is damaged or unsupported.',
  },
  pdf_network: {
    code: 'pdf_network',
    message: 'Could not download the PDF. Check the link and your connection.',
    actionLabel: 'Retry',
    recoveryHint: 'Could not download the PDF. Check the link and your connection.',
  },
  pdf_unknown: {
    code: 'pdf_unknown',
    message: 'Could not open this PDF.',
    actionLabel: 'Retry',
    recoveryHint: 'Could not open this PDF.',
  },
});

export function getErrorRecord(code, fallback = {}) {
  const record = ERROR_REGISTRY[code];
  if (record) return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, key === 'code' ? value : t(value)]));
  const message = fallback.message ? t(fallback.message) : t('Could not complete this action.');
  return {
    code: code || 'unknown',
    cause: fallback.cause ? t(fallback.cause) : message,
    message,
    actionLabel: t(fallback.actionLabel || ''),
    recoveryHint: fallback.recoveryHint ? t(fallback.recoveryHint) : message,
  };
}
