# Support mailbox

Last updated: 2026-05-10

Use `support@pagenarrator.com` for support. Forward mail to a role or helpdesk mailbox set outside Git as `SUPPORT_FORWARD_TO`.

## Inbound mail

Use Cloudflare Email Routing with the checked-in Email Worker at `website/workers/support-mailbox.js`.

1. Set `SUPPORT_FORWARD_TO` to the production role or helpdesk mailbox.

   ```bash
   npx wrangler secret put SUPPORT_FORWARD_TO -c website/workers/support-mailbox.wrangler.jsonc
   ```

2. Deploy the Worker:

   ```bash
   npm run deploy:support-mailbox
   ```

3. Enable Email Routing and confirm the Cloudflare DNS records for `pagenarrator.com`:

   ```bash
   npx wrangler email routing enable pagenarrator.com
   npx wrangler email routing dns get pagenarrator.com
   ```

4. Add the destination inbox and confirm Cloudflare’s verification email:

   ```bash
   npx wrangler email routing addresses create <SUPPORT_FORWARD_TO mailbox>
   ```

5. Route only the support address to the Worker:

   ```bash
   npx wrangler email routing rules create pagenarrator.com --name "PageNarrator support mailbox" --match-type literal --match-field to --match-value support@pagenarrator.com --action-type worker --action-value pagenarrator-support-mailbox --priority 0
   ```

6. Test from an external address. The message must reach `SUPPORT_FORWARD_TO` and show `support@pagenarrator.com` as the original recipient.

   Do not validate forwarding by sending from the same mailbox configured in `SUPPORT_FORWARD_TO` to `support@pagenarrator.com`. Some mailboxes hide duplicate self-sends. If Worker logs show receipt but the inbox does not, retry from another address before changing routing.

The Worker rejects unsupported recipients and oversized mail, drops automated/bounce traffic, and adds `X-PageNarrator-Forwarded` loop markers.

`Auto-Submitted: no` remains eligible for forwarding when it includes valid comments or optional parameters, as defined by [RFC 3834 sections 5.1–5.2](https://www.rfc-editor.org/rfc/rfc3834.html#section-5.1). Automated, unknown, or malformed `Auto-Submitted` values remain blocked.

Valid folded header lines are unfolded before parsing, following [RFC 2822 section 2.2.3](https://www.rfc-editor.org/rfc/rfc2822.html#section-2.2.3). Separators accept spaces and tabs; bare line breaks and other separator whitespace are blocked.

Cloudflare reference: https://developers.cloudflare.com/email-routing/email-workers/

## Send replies

Read and compose in the mailbox UI. Send through Resend SMTP as `PageNarrator Support <support@pagenarrator.com>`.

Use the separate `SUPPORT_RESEND_SMTP_API_KEY` credential.

1. Verify `pagenarrator.com` in Resend. Keep SPF, DKIM, and DMARC passing. If both services need root SPF, merge their sender includes into one TXT record.
2. In Gmail or the chosen helpdesk mailbox, open the account settings for Send mail as or SMTP aliases, then add another email address.
3. Add:

   ```text
   Name: PageNarrator Support
   Email address: support@pagenarrator.com
   SMTP server: smtp.resend.com
   Port: 587
   Security: TLS
   Username: resend
   Password: SUPPORT_RESEND_SMTP_API_KEY
   ```

4. Confirm the verification email delivered through Cloudflare to `SUPPORT_FORWARD_TO`.
5. Keep `PageNarrator Support <support@pagenarrator.com>` listed under Send mail as, select Make default if support mail should always use the support sender, and set When replying to a message to Reply from the same address the message was sent to.
6. When replying to a support message, expand the reply details before sending. If the reply composer shows a personal mailbox, change the From dropdown to `PageNarrator Support <support@pagenarrator.com>` and then send. The Cloudflare inbound Worker cannot change the From address on outbound replies.
7. Send a live reply test to a separate inbox and confirm the recipient must see `PageNarrator Support <support@pagenarrator.com>` as the sender.

Resend SMTP reference: https://resend.com/docs/send-with-smtp
Gmail Send mail as reference: https://support.google.com/mail/answer/22370
