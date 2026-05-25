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
export function sendWelcomeEmail(input: WelcomeEmailInput): Promise<SendGridResult> {
  const firstName = (input.firstName?.trim() || '').split(/\s+/)[0] || 'there';
  const niceDid = formatDidForDisplay(input.didNumber);
  const subject = `Welcome to ACE Dialer — sign-in instructions inside`;

  // Plaintext version (for clients that strip HTML, screen readers, spam scoring)
  const text = [
    `Hi ${firstName},`,
    ``,
    `Your ACE Dialer account is ready. Our IT team will install the app on`,
    `your computer shortly — you don't need to download or install anything`,
    `yourself.`,
    ``,
    `*** IMPORTANT ***`,
    `The old dialer will be uninstalled at the same time. ACE Dialer replaces it;`,
    `running both at once causes duplicate ringing and dropped calls.`,
    ``,
    `WHAT TO DO ONCE IT'S INSTALLED:`,
    `  1. Look for the "ACE Dialer" icon on your desktop.`,
    `  2. Open it. You'll see a "Sign in with Microsoft" button.`,
    `  3. Sign in with your @aptask.com account (same as Outlook).`,
    `  4. That's it — the dialer is ready to use.`,
    ``,
    niceDid ? `YOUR PHONE NUMBER: ${niceDid}` : `Your assigned phone number will appear in the app once you sign in.`,
    ``,
    `Need help? Reply to this email or contact ${config.aceSupportEmail ?? 'IT'}.`,
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

        <!-- IT-install heads up -->
        <tr><td style="padding:24px 32px 8px 32px;">
          <p style="margin:0;font-size:15px;color:#0f172a;">
            Our IT team will install the ACE Dialer app on your computer shortly.
            <strong>You don't need to download or install anything yourself.</strong>
          </p>
        </td></tr>

        <!-- The bold warning -->
        <tr><td style="padding:16px 32px;">
          <div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;padding:16px;">
            <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#991b1b;">
              ⚠ Important: the old dialer will be uninstalled
            </p>
            <p style="margin:0;font-size:14px;color:#7f1d1d;">
              ACE Dialer replaces it and uses the same phone credentials.
              Running both at once causes <strong>duplicate ringing on every
              incoming call</strong>. IT will remove the old dialer when they
              install ACE.
            </p>
          </div>
        </td></tr>

        <!-- What to do once installed -->
        <tr><td style="padding:16px 32px 8px 32px;">
          <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#0f172a;">
            What to do once it's installed
          </h2>
          <ol style="margin:0;padding-left:20px;font-size:14px;color:#0f172a;">
            <li style="margin-bottom:6px;">Look for the <strong>ACE Dialer</strong> icon on your desktop.</li>
            <li style="margin-bottom:6px;">Open it. You'll see a <strong>"Sign in with Microsoft"</strong> button.</li>
            <li style="margin-bottom:6px;">Sign in with your <strong>@aptask.com</strong> account — same one you use for Outlook.</li>
            <li>That's it. The dialer is ready to make and receive calls.</li>
          </ol>
        </td></tr>

        ${niceDid ? `<!-- Phone number -->
        <tr><td style="padding:16px 32px;">
          <div style="background:#f0f9ff;border-left:4px solid #0284c7;border-radius:6px;padding:16px;">
            <p style="margin:0 0 4px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#075985;font-weight:600;">
              Your phone number
            </p>
            <p style="margin:0;font-size:18px;font-weight:600;color:#0c4a6e;font-variant-numeric:tabular-nums;">
              ${escapeHtml(niceDid)}
            </p>
          </div>
        </td></tr>` : ''}

        <!-- Support -->
        <tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:13px;color:#64748b;">
            Need help or have questions? Reply to this email or contact
            <a href="mailto:${escapeHtml(config.aceSupportEmail ?? '')}" style="color:#0284c7;text-decoration:none;">${escapeHtml(config.aceSupportEmail ?? 'IT')}</a>.
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
