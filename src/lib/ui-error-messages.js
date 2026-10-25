import { ERROR_REGISTRY, getErrorRecord } from './error-registry.js';

const ERROR_CODE_ALIASES = Object.freeze({
  PAGENARRATOR_STORAGE_QUOTA: 'storage_quota',
  PAGENARRATOR_TAB_URL_HIDDEN: 'tab_url_hidden',
  PAGENARRATOR_UNSCRIPTABLE_URL: 'unscriptable_url',
});

export function getPopupRecoveryMessage(error) {
  const code = error?.code || '';
  if (code) {
    if (ERROR_CODE_ALIASES[code]) return getErrorRecord(ERROR_CODE_ALIASES[code]).recoveryHint;
    if (ERROR_REGISTRY[code]) return getErrorRecord(code).recoveryHint || getErrorRecord(code).message;
  }
  const raw = typeof error === 'string' ? error : error?.message || '';
  if (/manifest must request permission|cannot access contents/i.test(raw)) {
    return getErrorRecord('host_permission_required').recoveryHint;
  }
  if (/quota|storage/i.test(raw)) {
    return getErrorRecord('storage_quota').recoveryHint;
  }
  if (/closed|No tab/i.test(raw)) {
    return getErrorRecord('tab_closed').recoveryHint;
  }
  return raw || 'Could not access this page.';
}
