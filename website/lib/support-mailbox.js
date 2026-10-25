export const SUPPORT_EMAIL = 'support@pagenarrator.com';
export const SUPPORT_FORWARD_TO_ENV = 'SUPPORT_FORWARD_TO';
export const SUPPORT_MAX_RAW_SIZE_BYTES = 5 * 1024 * 1024;
export const SUPPORT_FROM_NAME = 'PageNarrator Support';
export const SUPPORT_FROM = `${SUPPORT_FROM_NAME} <${SUPPORT_EMAIL}>`;

export const SUPPORT_SMTP = Object.freeze({
  host: 'smtp.resend.com',
  port: 587,
  username: 'resend',
  passwordSecret: 'SUPPORT_RESEND_SMTP_API_KEY',
});

export function normalizeMailboxAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function resolveSupportForwardTo(env = {}) {
  const destination = normalizeMailboxAddress(env?.[SUPPORT_FORWARD_TO_ENV]);
  if (!isMailboxAddress(destination)) return null;
  return destination;
}

export function isSupportForwardSelfTest(value, destination) {
  const normalizedDestination = normalizeMailboxAddress(destination);
  return Boolean(normalizedDestination) && normalizeMailboxAddress(value) === normalizedDestination;
}

export function createSupportForwardHeaders({ sender, mailbox = SUPPORT_EMAIL, destination } = {}) {
  const headers = new Headers();
  headers.set('X-PageNarrator-Mailbox', normalizeMailboxAddress(mailbox));
  headers.set('X-PageNarrator-Forward-To', normalizeMailboxAddress(destination));
  headers.set('X-PageNarrator-Forwarded', 'support-mailbox');

  if (isSupportForwardSelfTest(sender, destination)) {
    headers.set('X-PageNarrator-Self-Test', 'true');
  }

  return headers;
}

export function classifyInboundSupportMessage(message, { maxRawSize = SUPPORT_MAX_RAW_SIZE_BYTES } = {}) {
  if (Number(message?.rawSize || 0) > maxRawSize) {
    return { action: 'reject', reason: 'message-too-large', rejectMessage: 'PageNarrator support message is too large.' };
  }

  if (hasForwardingLoopHeaders(message?.headers)) {
    return { action: 'drop', reason: 'forwarding-loop' };
  }

  if (isAutoSubmitted(message?.headers)) {
    return { action: 'drop', reason: 'auto-submitted' };
  }

  if (isBounceMessage(message)) {
    return { action: 'drop', reason: 'bounce-message' };
  }

  return null;
}

export function getMessageHeader(headers, name) {
  if (!headers || !name) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';

  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === expected) return String(value || '');
  }
  return '';
}

function isMailboxAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function isAutoSubmitted(headers) {
  // Unfold CRLF followed by SP/HTAB before inspecting comments or quoted text.
  const value = getMessageHeader(headers, 'Auto-Submitted').replace(/\r\n(?=[ \t])/g, '');
  if (/^[ \t]*$/.test(value)) return false;
  if (/[\r\n]/.test(value)) return true;

  // RFC 3834 permits comments and MIME parameters after the submission keyword.
  // Keep unknown or malformed values blocked rather than guessing their intent.
  const uncommented = stripAutoSubmittedComments(value);
  if (uncommented === null) return true;
  const token = "[!#$%&'*+.^_`|~\\w{}-]+";
  const quoted = '"(?:[\\t\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t\\x20-\\x7e])*"';
  return !new RegExp(`^[ \\t]*no[ \\t]*(?:;[ \\t]*${token}[ \\t]*=[ \\t]*(?:${token}|${quoted})[ \\t]*)*$`, 'i').test(uncommented);
}

function stripAutoSubmittedComments(value) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let result = '';
  for (const character of value) {
    if (escaped) {
      if (depth === 0) result += character;
      escaped = false;
    } else if (character === '\\' && (depth > 0 || quoted)) {
      if (depth === 0) result += character;
      escaped = true;
    } else if (character === '(' && !quoted) {
      if (depth === 0) result += ' ';
      depth += 1;
    } else if (depth > 0) {
      if (character === ')') depth -= 1;
    } else {
      if (character === ')' && !quoted) return null;
      if (character === '"') quoted = !quoted;
      result += character;
    }
  }
  return depth > 0 || quoted || escaped ? null : result;
}

function hasForwardingLoopHeaders(headers) {
  return Boolean(
    getMessageHeader(headers, 'X-PageNarrator-Forwarded')
    || getMessageHeader(headers, 'X-PageNarrator-Mailbox')
    || getMessageHeader(headers, 'X-PageNarrator-Forward-To')
  );
}

function isBounceMessage(message) {
  const from = normalizeMailboxAddress(message?.from);
  const returnPath = normalizeHeaderValue(getMessageHeader(message?.headers, 'Return-Path'));
  if (!from || from === '<>' || returnPath === '<>') return true;
  return from.startsWith('mailer-daemon@') || from.startsWith('postmaster@');
}

function normalizeHeaderValue(value) {
  return String(value || '').trim().toLowerCase();
}
