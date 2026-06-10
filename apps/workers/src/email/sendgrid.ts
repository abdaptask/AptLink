// v0.10.79 — Low-level SendGrid send() helper used by emailNotifier.ts.
//
// Why this file duplicates the one in apps/api/src/email/sendgrid.ts:
//   The webhooks service and the API service are separate Render services
//   that don't share imports. Rather than extract a shared @ace/email
//   package for ~50 lines of code, we duplicate the tiny low-level helper.
//   If a third service ever needs to send mail we'll extract.
//
// Env vars (same names as apps/api — keep them in sync):
//   SENDGRID_API_KEY        — Mail Send-scoped API key from app.sendgrid.com.
//   SENDGRID_FROM_EMAIL     — Verified sender (default: noreply@aptask.com).
//   SENDGRID_FROM_NAME      — Display name (default: "ACE Dialer").
//   ACE_SUPPORT_EMAIL       — Reply-to address (default: it@aptask.com).
//
// API reference: https://docs.sendgrid.com/api-reference/mail-send/mail-send

const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

export interface SendGridResult {
  ok: boolean;
  status: number;
  messageId?: string;
  error?: unknown;
}

export interface SendOptions {
  toEmail: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

function readEnv() {
  const apiKey = (process.env.SENDGRID_API_KEY ?? '').trim();
  const fromEmail = (process.env.SENDGRID_FROM_EMAIL ?? 'noreply@aptask.com').trim();
  const fromName = (process.env.SENDGRID_FROM_NAME ?? 'ACE Dialer').trim();
  const supportEmail = (process.env.ACE_SUPPORT_EMAIL ?? 'it@aptask.com').trim();
  return { apiKey, fromEmail, fromName, supportEmail };
}

/**
 * Fire-and-forget SendGrid POST. Returns ok:false (rather than throwing)
 * so callers can log + move on without breaking the webhook handler.
 */
export async function send(opts: SendOptions): Promise<SendGridResult> {
  const { apiKey, fromEmail, fromName, supportEmail } = readEnv();
  if (!apiKey) return { ok: false, status: 0, error: 'SENDGRID_API_KEY not set' };
  if (!fromEmail) return { ok: false, status: 0, error: 'SENDGRID_FROM_EMAIL not set' };

  const body = {
    personalizations: [{
      to: [{ email: opts.toEmail, ...(opts.toName ? { name: opts.toName } : {}) }],
      subject: opts.subject,
    }],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: opts.replyTo ?? supportEmail ?? fromEmail },
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
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const messageId = res.headers.get('x-message-id') ?? undefined;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, messageId };
    }
    const errorBody = (await res.json().catch(() => ({}))) as unknown;
    return { ok: false, status: res.status, error: errorBody };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** HTML-escape user-supplied strings going into the template (firstName, body, etc.). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an E.164 number for human display.
 *   "+17325551234" → "(732) 555-1234"
 *   "+44..."       → "+44..."  (leave international as-is)
 *   null / empty   → null
 */
export function formatDidForDisplay(raw?: string | null): string | null {
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
  return raw.startsWith('+') ? raw : `+${digits}`;
}
