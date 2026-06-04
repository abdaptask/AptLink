// SendGrid client — used by the on-demand invite endpoint to send a
// "Welcome to ACE Dialer" email to newly provisioned users.
//
// Why we send via SendGrid (vs Microsoft Graph or raw SMTP):
//   • ApTask already has a SendGrid account → no new vendor onboarding.
//   • Restricted-scope API key (Mail Send only) is easy to rotate.
//   • Deliverability + bounce/spam reporting is solid out of the box.
//
// What this module does NOT do:
//   • Does NOT send anything until the invite endpoint calls sendWelcomeEmail().
//   • Does NOT throw on missing API key — returns ok:false with a clear error
//     so the invite endpoint can decide how to surface it (e.g. provisioning
//     still succeeded, but email failed → admin gets a per-row error in the
//     invite result table).
//
// API reference: https://docs.sendgrid.com/api-reference/mail-send/mail-send
import { config } from '../config.js';

const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

export interface SendGridResult {
  ok: boolean;
  status: number;
  /** SendGrid's `X-Message-Id` header — useful for tracing in logs / SG dashboard. */
  messageId?: string;
  error?: unknown;
}

interface SendOptions {
  toEmail: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;                  // plaintext fallback for clients that don't render HTML
  /** Optional reply-to override. Defaults to aceSupportEmail. */
  replyTo?: string;
}

/**
 * Low-level send. Returns ok=false (rather than throwing) if SendGrid
 * rejects the send or the API key is missing — lets the invite endpoint
 * record per-row failures without aborting a batch.
 */
async function send(opts: SendOptions): Promise<SendGridResult> {
  if (!config.sendGridApiKey) {
    return { ok: false, status: 0, error: 'SENDGRID_API_KEY not set' };
  }
  if (!config.sendGridFromEmail) {
    return { ok: false, status: 0, error: 'SENDGRID_FROM_EMAIL not set' };
  }
  const body = {
    personalizations: [{
      to: [{ email: opts.toEmail, ...(opts.toName ? { name: opts.toName } : {}) }],
      subject: opts.subject,
    }],
    from: {
      email: config.sendGridFromEmail,
      name: config.sendGridFromName,
    },
    reply_to: {
      email: opts.replyTo ?? config.aceSupportEmail ?? config.sendGridFromEmail,
    },
    content: [
      { type: 'text/plain', value: opts.text },
      { type: 'text/html', value: opts.html },
    ],
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sendGridApiKey}`,
      },
      body: JSON.stringify(body),
    });
    const messageId = res.headers.get('x-message-id') ?? undefined;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, messageId };
    }
    // SendGrid returns JSON with { errors: [{ message, field, ... }] }
    const errorBody = (await res.json().catch(() => ({}))) as unknown;
    return { ok: false, status: res.status, error: errorBody };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────── Welcome email template ─────────────────────────

export interface WelcomeEmailInput {
  /** Recipient's email (will go into the To field). */
  toEmail: string;
  /** Used in the greeting ("Hi {firstName},..."). Falls back to "there". */
  firstName?: string | null;
  /** Their assigned phone number, shown so they can confirm it's right. E.164. */
  didNumber?: string | null;
}

/**
 * Send the "Welcome to ACE Dialer" email. Called by the invite endpoint
 * AFTER the User row exists in our DB and (if applicable) Telnyx resources
 * have been provisioned.
 *
 * The email tone is heads-up + sign-in-when-ready. Users in our deployment
 * model can't install software themselves — IT handles that. So the email
 * sets expectations and includes the bold "Pulse will be uninstalled" warning.
 */
// v0.9.7 — release page hosts both the Windows .exe and the Mac .dmg
// installers. Always points at "latest" so the link doesn't go stale.
const DOWNLOAD_URL = 'https://github.com/abdaptask/acedialerv4/releases/latest';

export function sendWelcomeEmail(input: WelcomeEmailInput): Promise<SendGridResult> {
  const firstName = (input.firstName?.trim() || '').split(/\s+/)[0] || 'there';
  const niceDid = formatDidForDisplay(input.didNumber);
  const supportEmail = config.aceSupportEmail || 'it@aptask.com';
  const subject = `Welcome to ACE Dialer — install + sign-in inside`;

  // Plaintext version (for clients that strip HTML, screen readers, spam scoring)
  const text = [
    `Hi ${firstName},`,
    ``,
    niceDid
      ? `Your ACE Dialer account is ready. Your business phone number is ${niceDid}.`
      : `Your ACE Dialer account is ready.`,
    ``,
    `HOW TO INSTALL:`,
    ``,
    `The fastest way: download + run the installer yourself (takes 2 minutes).`,
    ``,
    `  Windows:  ${DOWNLOAD_URL}`,
    `  Mac:      ${DOWNLOAD_URL}`,
    ``,
    `On that page, click the .exe (Windows) or .dmg (Mac) file. Run it.`,
    `You'll see "unidentified developer" — that's expected for now. On`,
    `Windows click "More info" then "Run anyway"; on Mac right-click the`,
    `.dmg and choose Open.`,
    ``,
    `If you'd rather wait for IT: they'll reach out within 1 business day`,
    `to install it for you.`,
    ``,
    `ONCE INSTALLED:`,
    ``,
    `1. Open ACE Dialer from your desktop`,
    `2. Click "Sign in with Microsoft"`,
    `3. Sign in with your @aptask.com account (same as Outlook)`,
    `4. Done — you can make and receive calls + texts`,
    ``,
    `*** IMPORTANT ***`,
    `If you're still on the old dialer (Pulse), UNINSTALL IT FIRST. Running`,
    `both at once causes every incoming call to ring twice and possibly drop.`,
    ``,
    `Need help? Reply to this email or contact ${supportEmail}.`,
    ``,
    `— The ACE Dialer team`,
  ].join('\n');

  // HTML version — inline styles only (some email clients strip <style>).
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
        <!-- Header -->
        <tr><td style="padding:32px 32px 16px 32px;border-bottom:1px solid #e2e8f0;">
          <h1 style="margin:0;font-size:24px;font-weight:600;color:#0f172a;">Welcome to ACE Dialer</h1>
          <p style="margin:8px 0 0 0;font-size:14px;color:#64748b;">Hi ${escapeHtml(firstName)}, your account is ready.</p>
        </td></tr>

        ${niceDid ? `<!-- Phone number (prominent box) -->
        <tr><td style="padding:24px 32px 8px 32px;">
          <div style="background:#f0f9ff;border-left:4px solid #0284c7;border-radius:6px;padding:16px;">
            <p style="margin:0 0 4px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#075985;font-weight:600;">
              Your business phone number
            </p>
            <p style="margin:0;font-size:22px;font-weight:700;color:#0c4a6e;font-variant-numeric:tabular-nums;">
              ${escapeHtml(niceDid)}
            </p>
          </div>
        </td></tr>` : ''}

        <!-- How to install -->
        <tr><td style="padding:24px 32px 8px 32px;">
          <h2 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#0f172a;">
            How to install
          </h2>
          <p style="margin:0 0 16px 0;font-size:14px;color:#0f172a;">
            Fastest way: download + run the installer yourself (takes about 2 minutes).
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
            <tr>
              <td style="padding-right:10px;">
                <a href="${escapeHtml(DOWNLOAD_URL)}"
                   style="display:inline-block;background:#0a84ff;color:#ffffff;font-weight:600;font-size:14px;
                          padding:10px 18px;border-radius:6px;text-decoration:none;">
                  Download for Windows
                </a>
              </td>
              <td>
                <a href="${escapeHtml(DOWNLOAD_URL)}"
                   style="display:inline-block;background:#0a84ff;color:#ffffff;font-weight:600;font-size:14px;
                          padding:10px 18px;border-radius:6px;text-decoration:none;">
                  Download for Mac
                </a>
              </td>
            </tr>
          </table>
          <p style="margin:8px 0 0 0;font-size:13px;color:#475569;">
            On that page, click the <strong>.exe</strong> (Windows) or <strong>.dmg</strong> (Mac) file.
            You may see an "unidentified developer" warning — that's expected for now.
            On Windows click <strong>More info → Run anyway</strong>; on Mac right-click the .dmg and choose <strong>Open</strong>.
          </p>
          <p style="margin:10px 0 0 0;font-size:13px;color:#64748b;">
            Prefer to wait for IT? They'll reach out within 1 business day to install it for you.
          </p>
        </td></tr>

        <!-- Once installed (numbered) -->
        <tr><td style="padding:16px 32px 8px 32px;">
          <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#0f172a;">
            Once installed
          </h2>
          <ol style="margin:0;padding-left:20px;font-size:14px;color:#0f172a;">
            <li style="margin-bottom:6px;">Open <strong>ACE Dialer</strong> from your desktop.</li>
            <li style="margin-bottom:6px;">Click <strong>"Sign in with Microsoft"</strong>.</li>
            <li style="margin-bottom:6px;">Sign in with your <strong>@aptask.com</strong> account (same one as Outlook).</li>
            <li>Done — you can make and receive calls and texts.</li>
          </ol>
        </td></tr>

        <!-- The bold warning -->
        <tr><td style="padding:16px 32px;">
          <div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;padding:16px;">
            <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#991b1b;">
              Important: uninstall the old dialer first
            </p>
            <p style="margin:0;font-size:14px;color:#7f1d1d;">
              If you're still on the old dialer (Pulse), <strong>uninstall it before signing in to ACE</strong>.
              Running both at once causes every incoming call to <strong>ring twice and possibly drop</strong>.
            </p>
          </div>
        </td></tr>

        <!-- Support -->
        <tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:13px;color:#64748b;">
            Need help? Reply to this email or contact
            <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(supportEmail)}</a>.
          </p>
          <p style="margin:12px 0 0 0;font-size:12px;color:#94a3b8;">
            — The ACE Dialer team
          </p>
        </td></tr>
      </table>

      <p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">
        Sent by ACE Dialer · ApTask
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return send({
    toEmail: input.toEmail,
    subject,
    text,
    html,
  });
}

// ───────────────────── Line-assigned email template ────────────────────────
//
// v0.10.20 — Sent when an admin adds (or migrates) a NEW phone line to an
// EXISTING user via the Manage Lines modal. Lets the user know to expect
// calls / SMS on the new number without having to find out via surprise.

export interface LineAssignedEmailInput {
  toEmail: string;
  firstName?: string | null;
  didNumber: string;                // The newly-assigned DID (E.164).
  label: string;                    // e.g. "Sales", "Recruiting"
  isDefault?: boolean;
  /** 'added' = new purchase / unassigned pick; 'migrated' = re-bound from another connection. */
  mode?: 'added' | 'migrated';
}

export function sendLineAssignedEmail(input: LineAssignedEmailInput): Promise<SendGridResult> {
  const firstName = (input.firstName?.trim() || '').split(/\s+/)[0] || 'there';
  const niceDid = formatDidForDisplay(input.didNumber) || input.didNumber;
  const supportEmail = config.aceSupportEmail || 'it@aptask.com';
  const verb = input.mode === 'migrated' ? 'migrated' : 'assigned';
  const subject = input.mode === 'migrated'
    ? `Your phone line ${niceDid} has been migrated to ACE Dialer`
    : `A new phone line has been assigned to you: ${niceDid}`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `An admin has ${verb} a new line on your ACE Dialer account.`,
    ``,
    `  Label:      ${input.label}`,
    `  Number:     ${niceDid}`,
    input.isDefault ? `  Default:    Yes — this is now your default outbound line.` : '',
    ``,
    `Open ACE Dialer to start using it. The line will appear in your`,
    `line switcher; calls + SMS to ${niceDid} will ring through to you`,
    `automatically.`,
    ``,
    input.mode === 'migrated'
      ? `Note: this number was previously on the old dialer (Pulse). It has`
        + `\nnow been moved to ACE — calls will only ring on ACE going forward.`
      : '',
    ``,
    `Need help? Reply to this email or contact ${supportEmail}.`,
    ``,
    `— The ACE Dialer team`,
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
        <tr><td style="padding:32px 32px 16px 32px;border-bottom:1px solid #e2e8f0;">
          <h1 style="margin:0;font-size:22px;font-weight:600;color:#0f172a;">
            ${input.mode === 'migrated' ? 'Line migrated to ACE' : 'New line assigned'}
          </h1>
          <p style="margin:8px 0 0 0;font-size:14px;color:#64748b;">Hi ${escapeHtml(firstName)}, ${verb === 'migrated' ? 'your existing phone number is now on ACE Dialer.' : 'a new phone line is now on your account.'}</p>
        </td></tr>

        <tr><td style="padding:24px 32px 8px 32px;">
          <div style="background:#f0f9ff;border-left:4px solid #0284c7;border-radius:6px;padding:16px;">
            <p style="margin:0 0 4px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#075985;font-weight:600;">
              ${escapeHtml(input.label)}${input.isDefault ? ' · Default line' : ''}
            </p>
            <p style="margin:0;font-size:22px;font-weight:700;color:#0c4a6e;font-variant-numeric:tabular-nums;">
              ${escapeHtml(niceDid)}
            </p>
          </div>
        </td></tr>

        <tr><td style="padding:16px 32px 24px 32px;">
          <p style="margin:0 0 12px 0;font-size:14px;color:#0f172a;">
            Open ACE Dialer to start using it. The line will appear in your
            line switcher; calls and SMS to <strong>${escapeHtml(niceDid)}</strong>
            will ring through to you automatically.
          </p>
          ${input.mode === 'migrated' ? `<p style="margin:0;font-size:13px;color:#64748b;">
            Note: this number was previously on the old dialer (Pulse). It has now
            been moved to ACE — calls will only ring on ACE going forward.
          </p>` : ''}
        </td></tr>

        <tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #e2e8f0;background:#fafbfc;">
          <p style="margin:0;font-size:13px;color:#64748b;">
            Need help? Reply to this email or contact
            <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(supportEmail)}</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return send({
    toEmail: input.toEmail,
    subject,
    text,
    html,
  });
}

// ──────────────────── Email notifications test send (v0.10.79) ────────────
//
// Used by POST /me/email-notifications/test. Sends a small sample email to
// the user's own address using the same SendGrid sender as production
// notifications — so the user can confirm deliverability + filtering before
// turning real missed-call / SMS / voicemail emails on.

export interface TestEmailInput {
  toEmail: string;
  firstName?: string | null;
}

export function sendTestEmail(input: TestEmailInput): Promise<SendGridResult> {
  const firstName = (input.firstName?.trim() || '').split(/\s+/)[0] || 'there';
  const supportEmail = config.aceSupportEmail || 'it@aptask.com';
  const subject = `Test: ACE Dialer email notifications`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `This is a test notification from ACE Dialer to confirm email is`,
    `set up correctly for your account. If you can read this, future`,
    `missed-call / SMS / voicemail emails will land here too.`,
    ``,
    `Manage your email notifications in ACE Dialer → Settings →`,
    `Email notifications.`,
    ``,
    `Need help? Reply to this email or contact ${supportEmail}.`,
    ``,
    `— The ACE Dialer team`,
  ].join('\n');

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
        <tr><td style="padding:24px 28px 12px 28px;border-bottom:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;">ACE Dialer</p>
          <h1 style="margin:6px 0 0 0;font-size:20px;font-weight:600;color:#0f172a;">Test notification</h1>
          <p style="margin:4px 0 0 0;font-size:14px;color:#64748b;">If you can read this, email notifications are working.</p>
        </td></tr>
        <tr><td style="padding:20px 28px 12px 28px;">
          <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Hi ${escapeHtml(firstName)},</p>
          <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">
            This is a test from ACE Dialer to confirm email is set up correctly for your account.
            Future missed-call, SMS, and voicemail emails will look similar to this and land here too.
          </p>
          <div style="background:#f0f9ff;border-left:4px solid #0284c7;border-radius:6px;padding:14px 16px;font-size:14px;color:#0c4a6e;">
            <strong>Tip:</strong> If this email landed in spam, add the ACE Dialer sender to your contacts so real notifications won't miss your inbox.
          </div>
        </td></tr>
        <tr><td style="padding:16px 28px 22px 28px;border-top:1px solid #e2e8f0;background:#fafbfc;">
          <p style="margin:0;font-size:12px;color:#64748b;">
            You're getting this because you clicked "Send test" in ACE Dialer → Settings → Email notifications.
            Need help? Reply to this email or contact
            <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(supportEmail)}</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return send({
    toEmail: input.toEmail,
    subject,
    text,
    html,
  });
}

// ─────────────────────────────── Helpers ────────────────────────────────────

/**
 * Format an E.164 number for human display.
 *   "+17325551234" → "(732) 555-1234"
 *   "+44..."       → "+44..."  (leave international as-is)
 *   null / empty   → null
 */
function formatDidForDisplay(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const a = digits.slice(1, 4);
    const b = digits.slice(4, 7);
    const c = digits.slice(7, 11);
    return `(${a}) ${b}-${c}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  }
  // Non-US — return E.164 as-is.
  return raw.startsWith('+') ? raw : `+${digits}`;
}

/**
 * HTML-escape user-supplied strings going into the template. Prevents XSS
 * if a malicious firstName ever sneaks through (e.g. via a tampered CSV).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
