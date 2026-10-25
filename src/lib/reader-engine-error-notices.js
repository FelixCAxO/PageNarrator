import { ERROR_REGISTRY, getErrorRecord } from './error-registry.js';

const ERROR_CODE_ALIASES = Object.freeze({
  PAGENARRATOR_STORAGE_QUOTA: 'storage_quota',
  PAGENARRATOR_TAB_URL_HIDDEN: 'tab_url_hidden',
  PAGENARRATOR_UNSCRIPTABLE_URL: 'unscriptable_url',
});

const RECOVERY_ACTIONS_BY_CODE = Object.freeze({
  article_text_not_found: [
    { label: 'Read selected text', action: 'read-selected' },
  ],
  empty_selection: [
    { label: 'Read selected', action: 'read-selected' },
  ],
  tts_generation_failed: [
    { label: 'Try again', action: 'try-again' },
  ],
  model_setup_failed: [
    { label: 'Try again', action: 'try-again' },
  ],
  host_permission_required: [
    { label: 'Grant site access', action: 'grant-access' },
  ],
});

function getReaderEngineErrorRecord(error) {
  const code = String(error?.code || '').trim();
  if (code) {
    if (ERROR_CODE_ALIASES[code]) return getErrorRecord(ERROR_CODE_ALIASES[code]);
    if (/^voice_model_/.test(code)) return getErrorRecord('model_setup_failed');
    if (/^(speech_preload_|tts_|speech_generation_)/.test(code)) return getErrorRecord('tts_generation_failed');
    if (Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, code)) return getErrorRecord(code);
  }

  const raw = error?.message || String(error || '').trim();
  if (/quota|storage/i.test(raw)) return getErrorRecord('storage_quota');
  if (/language.+mismatch|voice.+language/i.test(raw)) return getErrorRecord('voice_language_mismatch');
  if (/tts|speech generation|synthesis|audio playback/i.test(raw)) return getErrorRecord('tts_generation_failed');
  if (/setup|voice model|model.+prepar/i.test(raw)) return getErrorRecord('model_setup_failed');
  return raw ? getErrorRecord('', { message: raw, actionLabel: 'Try again', recoveryHint: raw }) : null;
}

export function getReaderEngineRecoveryActions(error) {
  const record = getReaderEngineErrorRecord(error);
  return [...(RECOVERY_ACTIONS_BY_CODE[record?.code] || [])];
}

export function hideReaderEngineErrorNotice(els = {}) {
  if (els.errorNotice) els.errorNotice.hidden = true;
  renderRecoveryActionButton(els.errorPrimaryAction, null);
  renderRecoveryActionButton(els.errorSecondaryAction, null);
  if (els.errorActions) {
    els.errorActions.hidden = true;
    delete els.errorActions.dataset.count;
  }
}

export function renderReaderEngineErrorNotice(els = {}, error) {
  const record = getReaderEngineErrorRecord(error);
  if (!record) return false;
  const message = record.recoveryHint;
  const actions = getReaderEngineRecoveryActions(error);

  if (els.errorNotice) {
    els.errorNotice.hidden = false;
    if (els.errorTitle) els.errorTitle.textContent = record.title || 'Needs attention';
    if (els.errorMessage) els.errorMessage.textContent = record.cause || record.message;
    if (els.errorAction) els.errorAction.textContent = message;
    renderRecoveryActionButton(els.errorPrimaryAction, actions[0]);
    renderRecoveryActionButton(els.errorSecondaryAction, actions[1]);
    if (els.errorActions) {
      els.errorActions.hidden = actions.length === 0;
      els.errorActions.dataset.count = String(actions.length);
    }
    if (els.errorDetails) els.errorDetails.hidden = !record.code;
    if (els.errorCode) els.errorCode.textContent = record.code || '';
    return true;
  }

  const target = els.statusLabel || els.languageStatus;
  if (!target) return false;
  target.textContent = message;
  target.setAttribute?.('role', 'status');
  target.setAttribute?.('aria-live', 'polite');
  target.dataset.tone = 'error';
  return true;
}

function renderRecoveryActionButton(button, action) {
  if (!button) return;
  if (!action) {
    button.hidden = true;
    button.textContent = '';
    delete button.dataset.errorAction;
    return;
  }
  button.hidden = false;
  button.textContent = action.label;
  button.dataset.errorAction = action.action;
}
