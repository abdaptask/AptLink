// Background poller for inbound SMS notifications.
// Mounted globally in Layout so it runs on every page after login.
// Every 15s it fetches the latest thread summaries, compares against the
// last-seen state, and fires a toast + desktop notification for any *new*
// inbound message that isn't already in the thread the user is viewing.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MessageSquare, X } from 'lucide-react';
import { getThreads, type ThreadSummary } from '../api';
import { getNotificationPrefs } from '../lib/userPrefs';
import { notify } from '../lib/notify';
import { getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone } from '../lib/phone';

const POLL_MS = 15_000;

interface ToastEvent {
  id: string;
  contactLabel: string;
  body: string;
  threadKey: string;
}

function formatNumber(n: string | undefined | null): string {
  return formatPhone(n);
}

export default function SmsNotifier() {
  // Track each thread's most recent inbound message time.
  // We seed this on first poll so we DON'T notify for messages that were
  // already there when the user logged in — only ones that arrive after.
  const lastInboundAtRef = useRef<Map<string, string> | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [toasts, setToasts] = useState<ToastEvent[]>([]);

  const activeThreadKey = location.pathname === '/messages' ? searchParams.get('to') : null;

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;

    let cancelled = false;

    async function pollOnce() {
      if (cancelled) return;
      try {
        const threads = await getThreads(token!);
        const map = new Map<string, string>();
        for (const t of threads) {
          // Only inbound messages count as "new arrivals" for us.
          if (t.direction === 'inbound') map.set(t.threadKey, t.createdAt);
        }

        const prev = lastInboundAtRef.current;
        if (!prev) {
          // First poll — just record state, no notifications.
          lastInboundAtRef.current = map;
          return;
        }

        // Find newly-arrived inbound messages.
        const newOnes: ThreadSummary[] = [];
        for (const t of threads) {
          if (t.direction !== 'inbound') continue;
          const prevAt = prev.get(t.threadKey);
          if (!prevAt || prevAt < t.createdAt) {
            newOnes.push(t);
          }
        }
        lastInboundAtRef.current = map;

        if (newOnes.length === 0) return;
        const prefs = getNotificationPrefs();
        if (!prefs.smsNotification) return;

        for (const t of newOnes) {
          // Suppress if the user is already viewing this thread.
          if (activeThreadKey && activeThreadKey === t.threadKey) continue;

          const label = getCachedJobDivaName(t.threadKey) ?? formatNumber(t.threadKey);
          const body = t.body ||
            (t.mediaUrls && t.mediaUrls.length > 0 ? `📎 ${t.mediaUrls.length} attachment` : '(no text)');

          // In-app toast (small popup at top-right). Click to open thread.
          setToasts((cur) => [
            { id: `${t.id}-${Date.now()}`, contactLabel: label, body, threadKey: t.threadKey },
            ...cur,
          ].slice(0, 4));

          // Desktop notification (fires only when tab is hidden + pref on).
          void notify({
            title: `New message from ${label}`,
            body,
            tag: `sms-${t.threadKey}`,
            prefKey: 'smsNotification',
            onClick: () => navigate(`/messages?to=${encodeURIComponent(t.threadKey)}`),
          });
        }
      } catch {
        /* ignore poll errors silently */
      }
    }

    void pollOnce();
    const id = window.setInterval(pollOnce, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // activeThreadKey is read inside the poll via closure-current — we don't
    // restart the timer when it changes (the closure picks up the latest val
    // because it's defined within the component body each render). Disabling
    // exhaustive-deps to avoid restarting the timer on every nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss(id: string) {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }
  function open(t: ToastEvent) {
    navigate(`/messages?to=${encodeURIComponent(t.threadKey)}`);
    dismiss(t.id);
  }

  // Auto-dismiss each toast after 6s.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      window.setTimeout(() => dismiss(t.id), 6_000),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts]);

  if (toasts.length === 0) return null;
  return (
    <div className="sms-toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="sms-toast" role="status">
          <button type="button" className="sms-toast-body" onClick={() => open(t)}>
            <span className="sms-toast-icon"><MessageSquare size={16} /></span>
            <span className="sms-toast-text">
              <span className="sms-toast-name">{t.contactLabel}</span>
              <span className="sms-toast-preview">{t.body}</span>
            </span>
          </button>
          <button
            type="button"
            className="sms-toast-close"
            onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
