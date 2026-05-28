// v0.10.0 Pillar 2 / Task 6 — Settings section for personal Microsoft Teams
// notifications.
//
// v0.10.1 — Switched from per-user Incoming Webhook URLs to a SINGLE
// tenant-wide Power Automate flow that the admin sets up once
// (TEAMS_TENANT_WEBHOOK_URL env var). Users no longer paste a URL — they
// just toggle which event types they want cards for. Cards are
// delivered by Flow bot DMing each user in Teams 1:1.
//
// When the env var isn't set, the UI shows an "ask your admin to
// enable" empty state. When it IS set, three checkboxes (missed call,
// SMS, voicemail) appear, defaulted ON for new users (handled at the
// DB-default layer in schema.prisma so we never have to chase invite
// flows again).
//
// Live test button: POSTs a sample card via the tenant URL with the
// caller's email as recipient. User sees the card in their Teams chat
// with Flow bot within ~3 seconds.
//
// Per CLAUDE.md UI rule #3, the parent Settings page handles
// scroll-to-top on section change; we just render content here.

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Send, Info, Loader2 } from 'lucide-react';
import {
  getTeamsConfig,
  updateTeamsConfig,
  testTeamsConfig,
  type TeamsEventType,
} from '../api';

const EVENT_LABELS: Record<TeamsEventType, string> = {
  missed_call: 'Missed call',
  sms: 'New text message (SMS)',
  voicemail: 'New voicemail',
};

const EVENT_DESCRIPTIONS: Record<TeamsEventType, string> = {
  missed_call:
    'When someone calls you and you don\'t answer — Teams card with caller info + call-back button.',
  sms: 'When someone texts you — Teams card with message preview + reply button.',
  voicemail:
    'When a caller leaves a voicemail — Teams card with transcript + play link + call-back button.',
};

export default function TeamsNotificationsSection() {
  const [tenantConfigured, setTenantConfigured] = useState<boolean>(false);
  const [enabled, setEnabled] = useState<Set<TeamsEventType>>(
    new Set(['missed_call', 'sms', 'voicemail']),
  );
  const [originalEvents, setOriginalEvents] = useState<TeamsEventType[]>([]);
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
    getTeamsConfig(token)
      .then((cfg) => {
        setTenantConfigured(cfg.tenantConfigured);
        // Honour what's in the DB. New users get all three by default at
        // the schema layer, so an empty list here means the user has
        // explicitly opted out of everything — respect that.
        const evts = cfg.events;
        setEnabled(new Set(evts));
        setOriginalEvents(evts);
      })
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const dirty = !sameSet(enabled, new Set(originalEvents));

  function toggle(evt: TeamsEventType) {
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
    const res = await updateTeamsConfig(token, {
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
      // Save first so the test card reflects the user's current preferences.
      await handleSave();
    }
    setTesting(true);
    setTestResult(null);
    const res = await testTeamsConfig(token);
    setTesting(false);
    if (res.ok) {
      setTestResult({ ok: true });
    } else {
      setTestResult({ ok: false, message: res.error ?? 'Test failed' });
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  // Empty state when the admin hasn't set TEAMS_TENANT_WEBHOOK_URL.
  if (!tenantConfigured) {
    return (
      <div className="settings-section-body teams-settings">
        <div className="teams-settings-empty">
          <Info size={18} aria-hidden />
          <div>
            <p>
              <strong>Teams notifications aren't enabled in your organization yet.</strong>
            </p>
            <p className="muted small">
              Once your admin connects ACE Dialer to Microsoft Teams, you'll see
              card notifications here in Teams chat with Flow bot whenever you
              have a missed call, new text message, or voicemail. No setup
              required on your end.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section-body teams-settings">
      <p className="muted teams-settings-intro">
        Teams notifications are connected at the org level. Choose which events
        you want cards for. Cards arrive in your Teams chat with Flow bot —
        nothing else for you to set up.
      </p>

      <fieldset className="teams-settings-events">
        <legend>Send a Teams card when…</legend>
        {(['missed_call', 'sms', 'voicemail'] as TeamsEventType[]).map((evt) => (
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
          title="Send a sample card so you can confirm it lands in your Teams"
        >
          {testing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          Send test card
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
            Test card sent. Check your Teams chat with Flow bot — it should
            arrive within a few seconds.
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
    </div>
  );
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
