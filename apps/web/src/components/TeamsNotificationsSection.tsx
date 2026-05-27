// v0.10.0 Pillar 2 / Task 6 — Settings section for personal Microsoft Teams
// notifications. User pastes their Incoming Webhook URL (created in Teams
// via channel → Connectors → Incoming Webhook, or via Power Automate)
// and opts in to which event types should ping them: missed call, new
// inbound SMS, voicemail completed.
//
// Live test button: POSTs a sample Adaptive Card to the saved URL so
// the user can verify reachability + correct formatting BEFORE relying
// on it for real production missed-call alerts.
//
// Rendered as a Settings section (mounted via SECTIONS array in
// Settings.tsx). Per CLAUDE.md UI rule #3, the parent Settings page
// handles scroll-to-top on section change; we just render content here.

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Send, ExternalLink, Loader2 } from 'lucide-react';
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
  missed_call: 'When someone calls you and you don\'t answer — Teams card with caller info + call-back button.',
  sms: 'When someone texts you — Teams card with message preview + reply button.',
  voicemail: 'When a caller leaves a voicemail — Teams card with transcript + play link + call-back button.',
};

export default function TeamsNotificationsSection() {
  const [url, setUrl] = useState<string>('');
  const [enabled, setEnabled] = useState<Set<TeamsEventType>>(
    new Set(['missed_call', 'sms', 'voicemail']),
  );
  const [originalUrl, setOriginalUrl] = useState<string>('');
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
        const u = cfg.teamsWebhookUrl ?? '';
        const evts = cfg.events.length > 0
          ? cfg.events
          : (['missed_call', 'sms', 'voicemail'] as TeamsEventType[]);
        setUrl(u);
        setOriginalUrl(u);
        setEnabled(new Set(evts));
        setOriginalEvents(evts);
      })
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const dirty =
    url.trim() !== originalUrl.trim() ||
    !sameSet(enabled, new Set(originalEvents));

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
      teamsWebhookUrl: url.trim() || null,
      events: Array.from(enabled),
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? 'Save failed');
      return;
    }
    setOriginalUrl(url.trim());
    setOriginalEvents(Array.from(enabled));
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
  }

  async function handleTest() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (dirty) {
      // Save first so the test hits the URL the user actually wants to verify.
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

  function handleRemove() {
    if (!window.confirm('Remove the Teams webhook URL? You will stop receiving Teams notifications immediately.')) return;
    setUrl('');
    setEnabled(new Set(['missed_call', 'sms', 'voicemail']));
    // Don't auto-save — let the user click Save so they can change their mind.
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="settings-section-body teams-settings">
      <p className="muted teams-settings-intro">
        Get instant pings in Microsoft Teams when something hits your dialer —
        missed calls, new SMS, voicemails. Cards include caller info, transcript
        (for voicemails), and one-click action buttons that open the dialer back
        on your desktop.
      </p>

      <details className="teams-settings-help">
        <summary>How to get your Teams webhook URL <ExternalLink size={12} aria-hidden /></summary>
        <ol>
          <li>
            Open Microsoft Teams. Go to the channel where you want notifications
            (e.g. your personal DMs with yourself, or a private "Dialer alerts"
            channel).
          </li>
          <li>
            Click the three-dot menu next to the channel name → <strong>Connectors</strong>
            (or in newer Teams: <strong>Workflows</strong> → "Post to a channel when
            a webhook request is received").
          </li>
          <li>
            Find <strong>Incoming Webhook</strong> → <strong>Add</strong>. Name it
            "ACE Dialer", optionally upload an icon, click <strong>Create</strong>.
          </li>
          <li>
            Copy the generated URL (it'll look like
            <code> https://outlook.office.com/webhook/... </code> or
            <code> https://prod-xx.westus.logic.azure.com:443/workflows/... </code>).
          </li>
          <li>Paste it into the field below + click <strong>Test</strong>.</li>
        </ol>
      </details>

      <div className="teams-settings-field">
        <label htmlFor="teams-webhook-url">Webhook URL</label>
        <input
          id="teams-webhook-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://outlook.office.com/webhook/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={saving || testing}
        />
        <p className="muted small">
          Empty = Teams notifications off. We POST Adaptive Cards to this URL when one of
          the events you've opted into (below) happens.
        </p>
      </div>

      <fieldset className="teams-settings-events">
        <legend>Send a Teams card when…</legend>
        {(['missed_call', 'sms', 'voicemail'] as TeamsEventType[]).map((evt) => (
          <label key={evt} className="teams-settings-checkbox">
            <input
              type="checkbox"
              checked={enabled.has(evt)}
              onChange={() => toggle(evt)}
              disabled={saving || testing || !url.trim()}
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
          disabled={saving || testing || !url.trim()}
          title="Send a sample Adaptive Card to verify the URL works"
        >
          {testing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          Test
        </button>
        {url.trim() && (
          <button
            type="button"
            className="settings-btn-secondary teams-settings-remove"
            onClick={handleRemove}
            disabled={saving || testing}
          >
            Remove
          </button>
        )}
        {savedFlash && (
          <span className="teams-settings-saved" role="status">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
      </div>

      {testResult?.ok && (
        <div className="teams-settings-result teams-settings-result-ok" role="status">
          <CheckCircle2 size={16} />
          <span>Test card sent. Check the Teams channel — should appear within a second or two.</span>
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
