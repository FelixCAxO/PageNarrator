import {
  SUPPORT_EMAIL,
  SUPPORT_FORWARD_TO_ENV,
  classifyInboundSupportMessage,
  createSupportForwardHeaders,
  isSupportForwardSelfTest,
  normalizeMailboxAddress,
  resolveSupportForwardTo,
} from '../lib/support-mailbox.js';

export {
  SUPPORT_EMAIL,
  SUPPORT_FORWARD_TO_ENV,
  SUPPORT_FROM,
  SUPPORT_MAX_RAW_SIZE_BYTES,
  SUPPORT_SMTP,
  createSupportForwardHeaders,
  isSupportForwardSelfTest,
} from '../lib/support-mailbox.js';

export async function routeSupportEmail(message, env = {}) {
  const recipient = normalizeMailboxAddress(message?.to);
  if (recipient !== SUPPORT_EMAIL) {
    message?.setReject?.(`Unsupported PageNarrator mailbox: ${message?.to || 'unknown recipient'}`);
    return {
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient,
      reason: 'unsupported-recipient',
    };
  }

  const destination = resolveSupportForwardTo(env);
  if (!destination) {
    message?.setReject?.(`PageNarrator support forwarding is missing ${SUPPORT_FORWARD_TO_ENV}.`);
    return {
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient,
      reason: 'missing-forward-destination',
    };
  }

  const filter = classifyInboundSupportMessage(message);
  if (filter?.action === 'reject') {
    message?.setReject?.(filter.rejectMessage || 'PageNarrator support message rejected.');
    return {
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient,
      reason: filter.reason,
    };
  }
  if (filter?.action === 'drop') {
    return {
      forwarded: false,
      rejected: false,
      dropped: true,
      recipient,
      reason: filter.reason,
    };
  }

  const supportForwardSelfTest = isSupportForwardSelfTest(message?.from, destination);
  const forwardHeaders = createSupportForwardHeaders({
    sender: message?.from,
    mailbox: recipient,
    destination,
  });

  await message.forward(destination, forwardHeaders);
  return {
    forwarded: true,
    rejected: false,
    dropped: false,
    recipient,
    destination,
    supportForwardSelfTest,
  };
}

export default {
  async email(message, env) {
    await routeSupportEmail(message, env);
  },
};
