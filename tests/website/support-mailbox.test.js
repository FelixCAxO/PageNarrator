import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import supportMailboxWorker, {
  SUPPORT_EMAIL,
  SUPPORT_FORWARD_TO_ENV,
  SUPPORT_FROM,
  SUPPORT_MAX_RAW_SIZE_BYTES,
  SUPPORT_SMTP,
  isSupportForwardSelfTest,
  routeSupportEmail,
} from '../../website/workers/support-mailbox.js';

const SUPPORT_ENV = {
  SUPPORT_FORWARD_TO: ' helpdesk@pagenarrator.com ',
};

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function createMessage(overrides = {}) {
  return {
    from: 'customer@example.com',
    to: ' Support@PageNarrator.com ',
    rawSize: 1024,
    headers: new Headers(),
    forward: vi.fn().mockResolvedValue(),
    setReject: vi.fn(),
    ...overrides,
  };
}

describe('support mailbox routing', () => {
  it('forwards inbound support mail to the env-bound helpdesk inbox', async () => {
    const message = createMessage();

    const result = await routeSupportEmail(message, SUPPORT_ENV);

    expect(result).toEqual({
      forwarded: true,
      rejected: false,
      dropped: false,
      recipient: SUPPORT_EMAIL,
      destination: 'helpdesk@pagenarrator.com',
      supportForwardSelfTest: false,
    });
    expect(message.forward).toHaveBeenCalledWith('helpdesk@pagenarrator.com', expect.any(Headers));
    const [, headers] = message.forward.mock.calls[0];
    expect(headers.get('X-PageNarrator-Mailbox')).toBe(SUPPORT_EMAIL);
    expect(headers.get('X-PageNarrator-Forward-To')).toBe('helpdesk@pagenarrator.com');
    expect(headers.get('X-PageNarrator-Forwarded')).toBe('support-mailbox');
    expect(headers.get('X-PageNarrator-Self-Test')).toBeNull();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('flags tests sent from the configured destination because some mailboxes suppress self-forwarded copies', async () => {
    const message = createMessage({
      from: ' Helpdesk@PageNarrator.com ',
    });

    expect(isSupportForwardSelfTest(message.from, SUPPORT_ENV.SUPPORT_FORWARD_TO)).toBe(true);

    const result = await routeSupportEmail(message, SUPPORT_ENV);

    expect(result).toEqual({
      forwarded: true,
      rejected: false,
      dropped: false,
      recipient: SUPPORT_EMAIL,
      destination: 'helpdesk@pagenarrator.com',
      supportForwardSelfTest: true,
    });
    expect(message.forward).toHaveBeenCalledWith('helpdesk@pagenarrator.com', expect.any(Headers));
    const [, headers] = message.forward.mock.calls[0];
    expect(headers.get('X-PageNarrator-Self-Test')).toBe('true');
  });

  it('fails closed when SUPPORT_FORWARD_TO is missing', async () => {
    const message = createMessage();

    const result = await routeSupportEmail(message, {});

    expect(result).toEqual({
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient: SUPPORT_EMAIL,
      reason: 'missing-forward-destination',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledWith(expect.stringContaining(SUPPORT_FORWARD_TO_ENV));
  });

  it('rejects non-support recipients if the Worker is bound too broadly', async () => {
    const message = createMessage({
      to: 'billing@pagenarrator.com',
    });

    const result = await routeSupportEmail(message, SUPPORT_ENV);

    expect(result).toEqual({
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient: 'billing@pagenarrator.com',
      reason: 'unsupported-recipient',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledWith(expect.stringContaining('billing@pagenarrator.com'));
  });

  it('rejects oversized inbound mail before forwarding', async () => {
    const message = createMessage({
      rawSize: SUPPORT_MAX_RAW_SIZE_BYTES + 1,
    });

    const result = await routeSupportEmail(message, SUPPORT_ENV);

    expect(result).toEqual({
      forwarded: false,
      rejected: true,
      dropped: false,
      recipient: SUPPORT_EMAIL,
      reason: 'message-too-large',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('drops auto-generated messages before forwarding while allowing Auto-Submitted: no', async () => {
    const autoMessage = createMessage({
      headers: new Headers({ 'Auto-Submitted': 'auto-replied' }),
    });
    const humanMessage = createMessage({
      headers: new Headers({ 'Auto-Submitted': 'no' }),
    });

    const autoResult = await routeSupportEmail(autoMessage, SUPPORT_ENV);
    const humanResult = await routeSupportEmail(humanMessage, SUPPORT_ENV);

    expect(autoResult).toMatchObject({
      forwarded: false,
      rejected: false,
      dropped: true,
      reason: 'auto-submitted',
    });
    expect(autoMessage.forward).not.toHaveBeenCalled();
    expect(autoMessage.setReject).not.toHaveBeenCalled();
    expect(humanResult.forwarded).toBe(true);
    expect(humanMessage.forward).toHaveBeenCalledOnce();
  });

  it.each([
    'no; x-origin=human',
    'no (sent by a person)',
    '(human) no',
    '(comment) NO (nested (manual)); (origin) x-origin = (chosen) human (trailing)',
    'no (escaped \\) parenthesis)',
    'no; x-note="text; (not a comment)"',
    'no; x-note="quoted \\"value\\""',
    'no; x-note=""; x-origin=human',
  ])('forwards the manual Auto-Submitted keyword with valid comments or parameters: %s', async (value) => {
    const message = createMessage({ headers: new Headers({ 'Auto-Submitted': value }) });

    expect(await routeSupportEmail(message, SUPPORT_ENV)).toMatchObject({
      forwarded: true, rejected: false, dropped: false,
    });
    expect(message.forward).toHaveBeenCalledOnce();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each([
    'auto-generated; x-origin=scheduled',
    '(automatic) auto-replied (vacation); x-origin=mailbox',
    'x-unknown; x-origin=human',
    'nope',
    'no;',
    'no; x-origin',
    'no; x-origin=',
    'no; x-origin="unterminated',
    'no (unterminated',
    'no )',
    'no; x-origin=human junk',
    'no; x-origin="human"junk',
  ])('keeps automated, unknown, and malformed Auto-Submitted values blocked: %s', async (value) => {
    const message = createMessage({ headers: new Headers({ 'Auto-Submitted': value }) });

    expect(await routeSupportEmail(message, SUPPORT_ENV)).toMatchObject({
      forwarded: false, rejected: false, dropped: true, reason: 'auto-submitted',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('unfolds a manual Auto-Submitted quoted parameter before parsing', async () => {
    const message = createMessage({
      headers: { 'Auto-Submitted': 'no; x-note="first\r\n second"' },
    });

    expect(await routeSupportEmail(message, SUPPORT_ENV)).toMatchObject({
      forwarded: true, rejected: false, dropped: false,
    });
    expect(message.forward).toHaveBeenCalledOnce();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each([
    'no\u000b; x-origin=human',
    'no\u00a0; x-origin=human',
    '\u000bno',
    'no\u00a0',
    'no\n; x-origin=human',
    'no\r; x-origin=human',
    'no\r\n; x-origin=human',
    'no (invalid\ncomment)',
    'no; x-note="first\n second"',
  ])('rejects invalid whitespace or bare line breaks in Auto-Submitted: %j', async (value) => {
    const message = createMessage({ headers: { 'Auto-Submitted': value } });

    expect(await routeSupportEmail(message, SUPPORT_ENV)).toMatchObject({
      forwarded: false, rejected: false, dropped: true, reason: 'auto-submitted',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('drops mailer-daemon and null-return-path bounce traffic', async () => {
    const daemonMessage = createMessage({
      from: 'mailer-daemon@example.com',
    });
    const bounceMessage = createMessage({
      from: '<>',
      headers: new Headers({ 'Return-Path': '<>' }),
    });

    const daemonResult = await routeSupportEmail(daemonMessage, SUPPORT_ENV);
    const bounceResult = await routeSupportEmail(bounceMessage, SUPPORT_ENV);

    expect(daemonResult).toMatchObject({ dropped: true, reason: 'bounce-message' });
    expect(bounceResult).toMatchObject({ dropped: true, reason: 'bounce-message' });
    expect(daemonMessage.forward).not.toHaveBeenCalled();
    expect(bounceMessage.forward).not.toHaveBeenCalled();
  });

  it('drops messages already carrying PageNarrator forward markers', async () => {
    const message = createMessage({
      headers: new Headers({
        'x-pagenarrator-forwarded': 'support-mailbox',
      }),
    });

    const result = await routeSupportEmail(message, SUPPORT_ENV);

    expect(result).toMatchObject({
      forwarded: false,
      rejected: false,
      dropped: true,
      reason: 'forwarding-loop',
    });
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('exports the Cloudflare Email Worker handler and passes env through', async () => {
    const message = createMessage();

    expect(typeof supportMailboxWorker.email).toBe('function');
    await supportMailboxWorker.email(message, SUPPORT_ENV);

    expect(message.forward).toHaveBeenCalledWith('helpdesk@pagenarrator.com', expect.any(Headers));
  });

  it('keeps the inbound route and outbound reply-as setup documented together', () => {
    const docs = read('docs/support-mailbox.md');
    const checklist = read('docs/launch-checklist.md');
    const readme = read('README.md');
    const packageJson = JSON.parse(read('package.json'));

    expect(SUPPORT_EMAIL).toBe('support@pagenarrator.com');
    expect(SUPPORT_FORWARD_TO_ENV).toBe('SUPPORT_FORWARD_TO');
    expect(SUPPORT_FROM).toBe('PageNarrator Support <support@pagenarrator.com>');
    expect(SUPPORT_SMTP).toMatchObject({
      host: 'smtp.resend.com',
      port: 587,
      username: 'resend',
      passwordSecret: 'SUPPORT_RESEND_SMTP_API_KEY',
    });

    expect(docs).toContain('support@pagenarrator.com');
    expect(docs).toContain('SUPPORT_FORWARD_TO');
    expect(checklist).toContain('independent support mailbox Worker');
    expect(readme).toContain('website/workers/support-mailbox.js');
    for (const text of [docs, checklist, readme]) expect(text).not.toMatch(/[a-z0-9._+-]+@gmail\.com/i);

    expect(docs).toContain('Cloudflare Email Routing');
    expect(docs).toContain('pagenarrator-support-mailbox');
    expect(docs).toContain('role or helpdesk mailbox');
    expect(docs).toContain('Do not validate forwarding by sending from the same mailbox configured in `SUPPORT_FORWARD_TO`');
    expect(docs).toContain('npx wrangler email routing rules create pagenarrator.com');
    expect(docs).toContain('--action-type worker');
    expect(docs).toContain('--action-value pagenarrator-support-mailbox');
    expect(docs).toContain('Gmail');
    expect(docs).toContain('Send mail as');
    expect(docs).toContain('smtp.resend.com');
    expect(docs).toContain('SUPPORT_RESEND_SMTP_API_KEY');
    expect(docs).not.toContain('Password: RESEND_API_KEY');
    expect(docs).toContain('Reply from the same address');
    expect(docs).toContain('If the reply composer shows a personal mailbox');
    expect(docs).toContain('change the From dropdown to `PageNarrator Support <support@pagenarrator.com>`');
    expect(docs).toContain('the recipient must see `PageNarrator Support <support@pagenarrator.com>` as the sender');
    expect(checklist).toContain('the Gmail reply composer opens with `PageNarrator Support <support@pagenarrator.com>` in From');
    expect(checklist).toContain('docs/support-mailbox.md');
    expect(readme).toContain('reply as `support@pagenarrator.com`');
    expect(packageJson.scripts['deploy:support-mailbox']).toBe(
      'wrangler deploy -c website/workers/support-mailbox.wrangler.jsonc'
    );
    expect(read('website/workers/support-mailbox.wrangler.jsonc')).toContain('pagenarrator-support-mailbox');
  });
});
