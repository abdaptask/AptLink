// v0.10.47 — "While you were away yesterday" banner.
//
// Shown at the top of the app on the first sign-in of each calendar day
// (local time). Pulls counts for the previous calendar day from the
// /me/activity-summary endpoint. If everything is zero, the banner is
// hidden — we don't want to nag users with "yesterday: 0 missed calls".
//
// Dismissible. Records today's date in localStorage so it won't reappear
// for the rest of the day even if the user reloads the app.
//
// Privacy note: this banner shows aggregate counts only. No message
// bodies, no contact names. Nothing leaves the browser beyond the
// authenticated API request to ACE's own backend.

import { useEffect, useState } from 'react';
import { PhoneMissed, MessageSquare, Voicemail, X } from 'lucide-react';
import { getActivitySummary, type ActivitySummary } from '../api';

const SHOWN_KEY = 'ace_daily_summary_last_shown';

// Returns today's date as YYYY-MM-DD in the user's local timezone.
// Used as the once-per-day suppression key.
function todayLocalKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Compute yesterday's window in the user's local time.
// since = yesterday 00:00:00 local
// until = today 00:00:00 local
function yesterdayWindow(): { since: Date; until: Date } {
  const now = new Date();
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  return { since, until };
}

function formatRange(since: Date): string {
  // E.g. "Mon, Jun 1"
  return since.toLocaleDateString('en-US', { timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export default function DailyActivityBanner() {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [windowSince, setWindowSince] = useState<Date | null>(null);

  useEffect(() => {
    // Only fetch + show if we haven't shown the banner yet today.
    const last = localStorage.getItem(SHOWN_KEY);
    const today = todayLocalKey();
    if (last === today) return;

    const token = sessionStorage.getItem('ace_token');
    if (!token) return;

    const { since, until } = yesterdayWindow();
    setWindowSince(since);

    let cancelled = false;
    getActivitySummary(token, { since, until })
      .then((s) => {
        if (cancelled) return;
        if (!s.ok) return;
        const total = (s.missedCalls ?? 0) + (s.newSms ?? 0) + (s.voicemails ?? 0);
        // Don't show the banner if there was nothing to summarize.
        if (total === 0) {
          // Still mark as shown so we don't re-fetch every render.
          localStorage.setItem(SHOWN_KEY, today);
          return;
        }
        setSummary(s);
      })
      .catch(() => {
        // Silent — the banner is non-essential, don't surface API errors.
      });

    return () => { cancelled = true; };
  }, []);

  function handleDismiss() {
    localStorage.setItem(SHOWN_KEY, todayLocalKey());
    setDismissed(true);
  }

  if (!summary || dismissed) return null;

  const missed = summary.missedCalls ?? 0;
  const sms = summary.newSms ?? 0;
  const vms = summary.voicemails ?? 0;
  const dateLabel = windowSince ? formatRange(windowSince) : 'Yesterday';

  return (
    <div
      className="daily-summary-banner"
      role="status"
      aria-label="Yesterday's activity summary"
    >
      <div className="daily-summary-content">
        <span className="daily-summary-label">{dateLabel}:</span>
        {missed > 0 && (
          <span className="daily-summary-pill daily-summary-pill-missed">
            <PhoneMissed size={14} />
            {missed} missed call{missed === 1 ? '' : 's'}
          </span>
        )}
        {sms > 0 && (
          <span className="daily-summary-pill daily-summary-pill-sms">
            <MessageSquare size={14} />
            {sms} new SMS
          </span>
        )}
        {vms > 0 && (
          <span className="daily-summary-pill daily-summary-pill-voicemail">
            <Voicemail size={14} />
            {vms} voicemail{vms === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <button
        type="button"
        className="daily-summary-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
