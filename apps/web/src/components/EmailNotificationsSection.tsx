// v0.10.79 — Settings section for personal email notifications. Parallel
// to TeamsNotificationsSection but using User.emailNotifyOn instead of
// teamsNotifyOn. Sends through ApTask's existing SendGrid sender (the
// same one used for welcome / line-assigned emails).
//
// Per product decision: every user starts OPTED OUT (DB default is NULL
// for emailNotifyOn — no migration backfill). The empty state for an
// opted-out user shows the three checkboxes (all unchecked) so they can
// opt in event-by-event.
//
// Test button: POSTs to /me/email-notifications/test, which sends a
// sample email to the user's own address. Lets the user verify
// deliverability + spam filtering BEFORE relying on email for real
// notifications.
//
// Per CLAUDE.md UI rule #3, the parent Settings page handles scroll-to-
// top on section change; we just render content here.

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Send, Info, Loader2, Mail } from 'lucide-react';
import {
  getEmailNotifications,
  updateEmailNotifications,
  testEmailNotification,
  type EmailNotifyEventType,
} from '../api';

const EVENT_LABELS: Record<EmailNotifyEventType, string> = {
  missed_call: 'Missed call',
  sms: 'New text message (SMS)',
  voicemail: 'New voicemail',
};

const EVENT_DESCRIPTIONS: Record<EmailNotifyEventType, string> = {
  missed_call:
    'When someone calls you and you don\'t answer — get an email with caller info + a link to call back in ACE.',
  sms: 'When someone texts you — get an email with the message preview. Note: this sends ONE email per inbound text, no batching.',
  voicemail:
    'When a caller leaves a voicemail — get an email with the transcript + a link to listen in ACE.',
};

export default function EmailNotificationsSection() {
  const [emailConfigured, setEmailConfigured] = useState<boolean>(false);
  const [recipientEmail, setRecipientEmail] = useState<string | null>(null);
  // Start with an empty Set — matches "opted out by default" so unchecked
  // is the right initial state until the load returns.
  const [enabled, setEnabled] = useState<Set<EmailNotifyEventType>>(new Set());
  const [originalEvents, setOriginalEvents] = useState<EmailNotifyEventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true } | { ok: false; message: string } | null
  >(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    getEmailNotifications(token)
      .then((cfg) => {
        setEmailConfigured(cfg.emailConfigured);
        setRecipientEmail(cfg.email);
        const evts = cfg.events;
        setEnabled(new Set(evts));
        setOriginalEvents(evts);
      })
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const dirty = !sameSet(enabled, new Set(originalEvents));

  function toggle(evt: EmailNotifyEventType) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(evt)) next.delete(evt);
      else next.add(evt);
      return next;
    });
  }

  async function handleSave() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    const res = await updateEmailNotifications(token, {
      events: Array.from(enabled),
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? 'Save failed');
      return;
    }
    setOriginalEvents(Array.from(enabled));
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
  }

  async function handleTest() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (dirty) {
      // Save first so future events use whatever the user just changed.
      await handleSave();
    }
    setTesting(true);
    setTestResult(null);
    const res = await testEmailNotification(token);
    setTesting(false);
    if (res.ok) {
      setTestResult({ ok: true });
    } else {
      setTestResult({ ok: false, message: res.error ?? 'Test failed' });
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  if (!emailConfigured) {
    return (
      <div className="settings-section-body teams-settings">
        <div className="teams-settings-empty">
          <Info size={18} aria-hidden />
          <div>
            <p>
              <strong>Email notifications aren't enabled in your organization yet.</strong>
            </p>
            <p className="muted small">
              Once your admin configures the email sender for ACE Dialer,
              you'll be able to receive missed-call, SMS, and voicemail
              notifications by email. Ask IT or your dialer admin to set the
              SendGrid integration.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section-body teams-settings">
      <p className="muted teams-settings-intro">
        Get an email whenever you have a missed call, a new text, or a voicemail.
        {recipientEmail ? (
          <>
            {' '}Emails go to <strong>{recipientEmail}</strong>.
          </>
        ) : null}
        {' '}Email notifications are off by default — turn on only the events you want.
      </p>

      <fieldset className="teams-settings-events">
        <legend>Send me an email when…</legend>
        {(['missed_call', 'sms', 'voicemail'] as EmailNotifyEventType[]).map((evt) => (
          <label key={evt} className="teams-settings-checkbox">
            <input
              type="checkbox"
              checked={enabled.has(evt)}
              onChange={() => toggle(evt)}
              disabled={saving || testing}
            />
            <div>
              <span className="teams-settings-checkbox-label">{EVENT_LABELS[evt]}</span>
              <span className="teams-settings-checkbox-desc">{EVENT_DESCRIPTIONS[evt]}</span>
            </div>
          </label>
        ))}
      </fieldset>

      <div className="teams-settings-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={handleSave}
          disabled={saving || testing || !dirty}
        >
          {saving ? <Loader2 size={14} className="spin" /> : null}
          Save
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          onClick={handleTest}
          disabled={saving || testing}
          title="Send a sample notification email so you can confirm it lands in your inbox (not spam)"
        >
          {testing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          Send test email
        </button>
        {savedFlash && (
          <span className="teams-settings-saved" role="status">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
      </div>

      {testResult?.ok && (
        <div className="teams-settings-result teams-settings-result-ok" role="status">
          <CheckCircle2 size={16} />
          <span>
            Test email sent. Check your inbox{recipientEmail ? ` at ${recipientEmail}` : ''} —
            it should arrive within a minute. If it lands in spam, add the sender to
            your contacts so future notifications don't get filtered.
          </span>
        </div>
      )}
      {testResult && !testResult.ok && (
        <div className="teams-settings-result teams-settings-result-err" role="alert">
          <AlertCircle size={16} />
          <span>{testResult.message}</span>
        </div>
      )}
      {error && (
        <div className="teams-settings-result teams-settings-result-err" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <p className="muted small" style={{ marginTop: 18 }}>
        <Mail size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        These are email-only notifications — you can't reply from your inbox to call back or text.
        Use the ACE Dialer app for that.
      </p>
    </div>
  );
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
