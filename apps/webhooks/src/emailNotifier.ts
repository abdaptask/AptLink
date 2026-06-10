// v0.10.79 — Email notifier. Parallel to teamsNotifier.ts.
//
// Per-user opt-in via User.emailNotifyOn (CSV of 'missed_call', 'sms',
// 'voicemail'). Default NULL/empty = OFF for everyone — users self-enable
// via Settings → Email notifications.
//
// Trigger points (called from the same places as teamsNotifier):
//   - Inbound call hangup with answeredAt==null → notifyMissedCallByEmail
//   - Voicemail row created + transcribed (or timeout) → notifyVoicemailByEmail
//   - Inbound SMS message.received → notifyInboundSmsByEmail
//
// Like Teams, every entry is fire-and-forget from the webhook handler's
// POV. Failures never throw upward. We log every outcome with structured
// fields so triage is easy: [email] sent / failed / skipped + userId +
// eventType + sourceId.
//
// SMS coalescing: NONE. Per product decision (v0.10.79), one email per
// inbound SMS. Users who don't want this can disable the 'sms' event type.
//
// Missed-call vs voicemail dedup: mirrors teamsNotifier. Both events can
// fire for the same call (call.hangup AND voicemail.completed). We accept
// the duplicate rather than introduce a fragile setTimeout that dies on
// Render hibernation. Same trade-off Teams ships with since v0.10.2.

import { prisma } from '@ace/db';
import { send, escapeHtml, formatDidForDisplay } from './email/sendgrid.js';

type LogFn = (obj: Record<string, unknown>, msg: string) => void;
const consoleLog: LogFn = (obj, msg) => console.info(msg, obj);
const consoleWarn: LogFn = (obj, msg) => console.warn(msg, obj);

type EventType = 'missed_call' | 'sms' | 'voicemail';

const APP_URL = (process.env.WEB_BASE_URL ?? 'https://ace-dialer.vercel.app').replace(/\/+$/, '');

/**
 * Build a deep-link URL that opens the Electron desktop app via the
 * ace-dialer:// protocol handler when one is installed, with the web app
 * as the fallback. Mirrors what the Teams cards do (see teamsCards/types.ts):
 * we point the CTA at /auto/call or /auto/sms on the web app, and the
 * AutoRoute page does the protocol launch + close-tab dance.
 *
 * - 'call' opens the Electron app's dialpad with the to= number prefilled.
 *   Used for missed-call AND voicemail emails (call back is more useful
 *   than listening once the transcript is already in the email).
 * - 'sms' opens the Electron app's compose pane with the to= prefilled.
 *
 * If the from-number isn't usable (anonymous caller, malformed),
 * returns the plain root URL — Electron protocol won't launch but the
 * user still gets the web app and can navigate from there.
 */
function buildDeepLink(action: 'call' | 'sms', toNumber: string | null | undefined): string {
  const cleaned = (toNumber ?? '').replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 4) {
    return APP_URL;
  }
  return `${APP_URL}/auto/${action}?to=${encodeURIComponent(cleaned)}`;
}

// ─────────────────────────────────────────────────────────────────
// Opt-in lookup.
// ─────────────────────────────────────────────────────────────────

interface EmailConfig {
  email: string;
  firstName: string | null;
  events: Set<EventType>;
  /** Does this user own > 1 DID? Used to decide whether to include
   *  the "on your X line" tag in the email body. */
  multiLine: boolean;
}

async function loadEmailConfig(userId: number): Promise<EmailConfig | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      firstName: true,
      emailNotifyOn: true,
      isActive: true,
    },
  });
  if (!user) return null;
  if (!user.isActive) return null;
  if (!user.email) {
    consoleWarn({ userId }, '[email] user has no email; cannot send notification');
    return null;
  }
  const events = new Set<EventType>(
    (user.emailNotifyOn ?? []).filter((s): s is EventType =>
      s === 'missed_call' || s === 'sms' || s === 'voicemail',
    ),
  );
  if (events.size === 0) return null;

  const lineCount = await prisma.userDid.count({ where: { userId } });
  return {
    email: user.email,
    firstName: user.firstName ?? null,
    events,
    multiLine: lineCount > 1,
  };
}

async function resolveLineLabel(
  userId: number,
  userDidId: number | null,
  multiLine: boolean,
): Promise<string | null> {
  if (!userDidId || !multiLine) return null;
  const did = await prisma.userDid.findUnique({
    where: { id: userDidId },
    select: { label: true },
  });
  return did?.label ?? null;
}

// ─────────────────────────────────────────────────────────────────
// Dedup sets — per-process. Matches teamsNotifier's design exactly.
// ─────────────────────────────────────────────────────────────────

const sentMissedCallEmails = new Set<number>(); // callDbId
const sentVoicemailEmails = new Set<number>();  // voicemailId
// NOTE: no sentSmsEmails set — per product decision, every inbound SMS
// gets its own email.

// ─────────────────────────────────────────────────────────────────
// Shared HTML chrome.
// ─────────────────────────────────────────────────────────────────

interface EmailChrome {
  headerTitle: string;
  headerSubtitle: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  /** Plain-text body. */
  text: string;
}

function renderEmail(chrome: EmailChrome): { html: string; text: string } {
  const supportEmail = (process.env.ACE_SUPPORT_EMAIL ?? 'it@aptask.com').trim();
  const settingsUrl = `${APP_URL}/settings/email-notifications`;
  const cta = chrome.ctaLabel && chrome.ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0 0;">
         <tr><td>
           <a href="${escapeHtml(chrome.ctaUrl)}"
              style="display:inline-block;background:#0a84ff;color:#ffffff;font-weight:600;
                     font-size:14px;padding:10px 18px;border-radius:6px;text-decoration:none;">
             ${escapeHtml(chrome.ctaLabel)}
           </a>
         </td></tr>
       </table>`
    : '';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
        <tr><td style="padding:24px 28px 12px 28px;border-bottom:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;">ACE Dialer</p>
          <h1 style="margin:6px 0 0 0;font-size:20px;font-weight:600;color:#0f172a;">${escapeHtml(chrome.headerTitle)}</h1>
          <p style="margin:4px 0 0 0;font-size:14px;color:#64748b;">${escapeHtml(chrome.headerSubtitle)}</p>
        </td></tr>
        <tr><td style="padding:20px 28px 8px 28px;">
          ${chrome.bodyHtml}
          ${cta}
        </td></tr>
        <tr><td style="padding:16px 28px 22px 28px;border-top:1px solid #e2e8f0;background:#fafbfc;">
          <p style="margin:0;font-size:12px;color:#64748b;">
            You're getting this because email notifications are enabled on your ACE Dialer account.
            <a href="${escapeHtml(settingsUrl)}" style="color:#0284c7;text-decoration:none;">Manage your preferences</a>
            or contact <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(supportEmail)}</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { html, text: chrome.text };
}

// ─────────────────────────────────────────────────────────────────
// Public: notifyMissedCallByEmail
// ─────────────────────────────────────────────────────────────────

export async function notifyMissedCallByEmail(opts: {
  userId: number;
  callDbId: number;
  telnyxCallId: string;
}): Promise<void> {
  if (sentMissedCallEmails.has(opts.callDbId)) {
    consoleLog(
      { userId: opts.userId, callDbId: opts.callDbId },
      '[email] missed-call already sent — skipping duplicate',
    );
    return;
  }
  sentMissedCallEmails.add(opts.callDbId);

  // Voicemail-supersedes is BEST EFFORT here — same as Teams since v0.10.2.
  // We check the voicemail table once at fire time; if a voicemail was
  // created in the next few seconds we still send a missed-call email AND
  // a voicemail email. That's the same trade-off Teams notifications ship
  // with on Render's hibernating tier.
  const vm = await prisma.voicemail.findFirst({
    where: { telnyxCallId: opts.telnyxCallId },
    select: { id: true },
  });
  if (vm) {
    consoleLog(
      { userId: opts.userId, callDbId: opts.callDbId, voicemailId: vm.id },
      '[email] missed-call suppressed (voicemail email will fire instead)',
    );
    return;
  }

  const cfg = await loadEmailConfig(opts.userId);
  if (!cfg) return;
  if (!cfg.events.has('missed_call')) {
    consoleLog({ userId: opts.userId, eventType: 'missed_call' }, '[email] skipped — user opted out');
    return;
  }

  const call = await prisma.call.findUnique({
    where: { id: opts.callDbId },
    select: {
      fromNumber: true,
      userDidId: true,
      startedAt: true,
      answeredAt: true,
      status: true,
      direction: true,
    },
  });
  if (!call) return;
  if (call.direction !== 'inbound') return;
  if (call.answeredAt) return;
  if (call.status === 'blocked') return;

  const lineLabel = await resolveLineLabel(opts.userId, call.userDidId, cfg.multiLine);
  const fromDisplay = formatDidForDisplay(call.fromNumber) ?? call.fromNumber ?? 'Unknown';
  const occurredAt = call.startedAt ?? new Date();
  const when = formatLocal(occurredAt);
  const firstName = (cfg.firstName?.trim() || '').split(/\s+/)[0] || 'there';

  const subject = `Missed call from ${fromDisplay}`;
  const lineSuffix = lineLabel ? ` on your ${lineLabel} line` : '';
  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 16px 0;font-size:15px;color:#0f172a;">
      You missed a call from <strong>${escapeHtml(fromDisplay)}</strong>${escapeHtml(lineSuffix)}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;width:100%;background:#f8fafc;border-radius:8px;">
      <tr><td style="padding:14px 16px;font-size:13px;color:#475569;">
        <strong style="color:#0f172a;">Caller:</strong> ${escapeHtml(fromDisplay)}<br>
        ${lineLabel ? `<strong style="color:#0f172a;">Line:</strong> ${escapeHtml(lineLabel)}<br>` : ''}
        <strong style="color:#0f172a;">When:</strong> ${escapeHtml(when)}
      </td></tr>
    </table>`;

  // v0.10.80 — CTA goes through /auto/call so the Electron desktop app
  // opens via the ace-dialer:// protocol when installed (with web
  // fallback). Previously the CTA opened the web dialer even when
  // Electron was already running.
  const callBackUrl = buildDeepLink('call', call.fromNumber);
  const text = [
    `Hi ${firstName},`,
    ``,
    `Missed call from ${fromDisplay}${lineSuffix} at ${when}.`,
    ``,
    `Call back in ACE Dialer: ${callBackUrl}`,
    ``,
    `Manage email notifications: ${APP_URL}/settings/email-notifications`,
  ].join('\n');

  const { html } = renderEmail({
    headerTitle: 'Missed call',
    headerSubtitle: when,
    bodyHtml,
    ctaLabel: 'Call back in ACE Dialer',
    ctaUrl: callBackUrl,
    text,
  });

  const result = await send({
    toEmail: cfg.email,
    toName: cfg.firstName ?? undefined,
    subject,
    html,
    text,
  });
  if (result.ok) {
    consoleLog(
      { userId: opts.userId, callDbId: opts.callDbId, recipient: cfg.email, status: result.status, messageId: result.messageId },
      '[email] missed-call sent',
    );
  } else {
    sentMissedCallEmails.delete(opts.callDbId);
    consoleWarn(
      { userId: opts.userId, callDbId: opts.callDbId, recipient: cfg.email, status: result.status, error: result.error },
      '[email] missed-call send failed',
    );
  }
}

export function scheduleMissedCallEmail(opts: {
  userId: number;
  callDbId: number;
  telnyxCallId: string;
}): void {
  void notifyMissedCallByEmail(opts).catch((e) =>
    consoleWarn({ err: e instanceof Error ? e.message : String(e), ...opts }, '[email] missed-call scheduler threw'),
  );
}

// ─────────────────────────────────────────────────────────────────
// Public: notifyInboundSmsByEmail
// ─────────────────────────────────────────────────────────────────

export async function notifyInboundSmsByEmail(opts: {
  userId: number;
  messageDbId: number;
}): Promise<void> {
  const cfg = await loadEmailConfig(opts.userId);
  if (!cfg) return;
  if (!cfg.events.has('sms')) {
    consoleLog({ userId: opts.userId, eventType: 'sms' }, '[email] skipped — user opted out');
    return;
  }

  const msg = await prisma.message.findUnique({
    where: { id: opts.messageDbId },
    select: {
      fromNumber: true,
      body: true,
      userDidId: true,
      sentAt: true,
      direction: true,
    },
  });
  if (!msg || msg.direction !== 'inbound') return;

  const lineLabel = await resolveLineLabel(opts.userId, msg.userDidId, cfg.multiLine);
  const fromDisplay = formatDidForDisplay(msg.fromNumber) ?? msg.fromNumber ?? 'Unknown';
  const when = formatLocal(msg.sentAt ?? new Date());
  const firstName = (cfg.firstName?.trim() || '').split(/\s+/)[0] || 'there';
  const body = msg.body ?? '';
  // Cap preview length so attachment-heavy MMS doesn't blow up the email.
  const preview = body.length > 800 ? body.slice(0, 800) + '…' : body;

  const subject = `New text from ${fromDisplay}`;
  const lineSuffix = lineLabel ? ` on your ${lineLabel} line` : '';
  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">
      <strong>${escapeHtml(fromDisplay)}</strong>${escapeHtml(lineSuffix)} just texted you:
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;width:100%;">
      <tr><td style="padding:14px 16px;background:#f0f9ff;border-left:4px solid #0284c7;border-radius:6px;font-size:14px;color:#0c4a6e;white-space:pre-wrap;word-break:break-word;">
        ${escapeHtml(preview || '(no message body — likely an MMS attachment)')}
      </td></tr>
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;color:#64748b;">${escapeHtml(when)}</p>`;

  // v0.10.80 — CTA via /auto/sms so Electron opens the compose pane with
  // the sender prefilled, instead of falling back to the web app.
  const replyUrl = buildDeepLink('sms', msg.fromNumber);
  const text = [
    `Hi ${firstName},`,
    ``,
    `New text from ${fromDisplay}${lineSuffix} at ${when}:`,
    ``,
    preview || '(no message body — likely an MMS attachment)',
    ``,
    `Reply in ACE Dialer: ${replyUrl}`,
    ``,
    `Manage email notifications: ${APP_URL}/settings/email-notifications`,
  ].join('\n');

  const { html } = renderEmail({
    headerTitle: `New text from ${fromDisplay}`,
    headerSubtitle: when,
    bodyHtml,
    ctaLabel: 'Reply in ACE Dialer',
    ctaUrl: replyUrl,
    text,
  });

  const result = await send({
    toEmail: cfg.email,
    toName: cfg.firstName ?? undefined,
    subject,
    html,
    text,
  });
  if (result.ok) {
    consoleLog(
      { userId: opts.userId, messageDbId: opts.messageDbId, recipient: cfg.email, status: result.status, messageId: result.messageId },
      '[email] sms sent',
    );
  } else {
    consoleWarn(
      { userId: opts.userId, messageDbId: opts.messageDbId, recipient: cfg.email, status: result.status, error: result.error },
      '[email] sms send failed',
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Public: notifyVoicemailByEmail
// ─────────────────────────────────────────────────────────────────

export async function notifyVoicemailByEmail(opts: {
  userId: number;
  voicemailId: number;
  reason: 'transcribed' | 'timeout';
}): Promise<void> {
  if (sentVoicemailEmails.has(opts.voicemailId)) {
    consoleLog(
      { voicemailId: opts.voicemailId, reason: opts.reason },
      '[email] voicemail already sent — skipping duplicate',
    );
    return;
  }
  sentVoicemailEmails.add(opts.voicemailId);

  try {
    const cfg = await loadEmailConfig(opts.userId);
    if (!cfg) return;
    if (!cfg.events.has('voicemail')) {
      consoleLog({ userId: opts.userId, eventType: 'voicemail' }, '[email] skipped — user opted out');
      return;
    }

    const vm = await prisma.voicemail.findUnique({
      where: { id: opts.voicemailId },
      select: {
        fromNumber: true,
        userDidId: true,
        receivedAt: true,
        durationSeconds: true,
        transcription: true,
      },
    });
    if (!vm) return;

    const lineLabel = await resolveLineLabel(opts.userId, vm.userDidId, cfg.multiLine);
    const fromDisplay = formatDidForDisplay(vm.fromNumber) ?? vm.fromNumber ?? 'Unknown';
    const when = formatLocal(vm.receivedAt ?? new Date());
    const firstName = (cfg.firstName?.trim() || '').split(/\s+/)[0] || 'there';
    const duration = vm.durationSeconds
      ? (vm.durationSeconds >= 60
          ? `${Math.floor(vm.durationSeconds / 60)}m ${vm.durationSeconds % 60}s`
          : `${vm.durationSeconds}s`)
      : null;
    const transcript = vm.transcription?.trim() || '';

    const subject = `New voicemail from ${fromDisplay}`;
    const lineSuffix = lineLabel ? ` on your ${lineLabel} line` : '';
    const transcriptHtml = transcript
      ? `<p style="margin:14px 0 6px 0;font-size:13px;font-weight:600;color:#0f172a;">Transcript</p>
         <p style="margin:0;padding:12px 14px;background:#f8fafc;border-radius:8px;font-size:14px;color:#334155;white-space:pre-wrap;word-break:break-word;">${escapeHtml(transcript)}</p>`
      : `<p style="margin:14px 0 0 0;font-size:13px;color:#64748b;font-style:italic;">Transcript still processing — open ACE Dialer to listen.</p>`;

    const bodyHtml = `
      <p style="margin:0 0 12px 0;font-size:15px;color:#0f172a;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 8px 0;font-size:15px;color:#0f172a;">
        <strong>${escapeHtml(fromDisplay)}</strong>${escapeHtml(lineSuffix)} left you a voicemail${duration ? ` (${escapeHtml(duration)})` : ''}.
      </p>
      <p style="margin:0 0 0 0;font-size:13px;color:#64748b;">${escapeHtml(when)}</p>
      ${transcriptHtml}`;

    // v0.10.80 — CTA via /auto/call (not /auto/voicemail — AutoRoute only
    // supports call/sms today). The transcript is already in the email
    // body, so the most useful action from the email is "call back" rather
    // than "listen again." Opens Electron's dialpad prefilled with the
    // caller's number.
    const callBackUrl = buildDeepLink('call', vm.fromNumber);
    const text = [
      `Hi ${firstName},`,
      ``,
      `Voicemail from ${fromDisplay}${lineSuffix} at ${when}${duration ? ` (${duration})` : ''}.`,
      ``,
      transcript ? `Transcript:` : `Transcript still processing — open ACE Dialer to listen.`,
      transcript || '',
      ``,
      `Call back in ACE Dialer: ${callBackUrl}`,
      ``,
      `Manage email notifications: ${APP_URL}/settings/email-notifications`,
    ].filter(Boolean).join('\n');

    const { html } = renderEmail({
      headerTitle: `New voicemail`,
      headerSubtitle: `${fromDisplay} · ${when}`,
      bodyHtml,
      ctaLabel: 'Call back in ACE Dialer',
      ctaUrl: callBackUrl,
      text,
    });

    const result = await send({
      toEmail: cfg.email,
      toName: cfg.firstName ?? undefined,
      subject,
      html,
      text,
    });
    if (result.ok) {
      consoleLog(
        { userId: opts.userId, voicemailId: opts.voicemailId, recipient: cfg.email, reason: opts.reason, hasTranscript: Boolean(transcript), status: result.status, messageId: result.messageId },
        '[email] voicemail sent',
      );
    } else {
      sentVoicemailEmails.delete(opts.voicemailId);
      consoleWarn(
        { userId: opts.userId, voicemailId: opts.voicemailId, reason: opts.reason, status: result.status, error: result.error },
        '[email] voicemail send failed',
      );
    }
  } catch (e) {
    sentVoicemailEmails.delete(opts.voicemailId);
    consoleWarn(
      { userId: opts.userId, voicemailId: opts.voicemailId, err: e instanceof Error ? e.message : String(e) },
      '[email] voicemail handler threw',
    );
  }
}

export function scheduleVoicemailEmailTimeoutFallback(opts: {
  userId: number;
  voicemailId: number;
}): void {
  void notifyVoicemailByEmail({ ...opts, reason: 'timeout' }).catch((e) =>
    consoleWarn({ err: e instanceof Error ? e.message : String(e), ...opts }, '[email] voicemail timeout scheduler threw'),
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Format a Date for human display in email subject/body. Uses the server's
 * timezone (UTC on Render). We append " UTC" so users in IST / EST aren't
 * confused. Future enhancement: use User.country to format in their TZ.
 */
function formatLocal(d: Date): string {
  try {
    const datePart = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `${datePart}, ${timePart} UTC`;
  } catch {
    return d.toISOString();
  }
}
