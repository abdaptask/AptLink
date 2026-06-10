import { useEffect, useState } from 'react';

// v0.10.117 - read isAdmin from the JWT in sessionStorage. Avoids prop
// drilling or a context dependency; the token already carries this claim.
function isCurrentUserAdmin(): boolean {
  try {
    const t = sessionStorage.getItem('ace_token');
    if (!t) return false;
    const payload = JSON.parse(atob(t.split('.')[1] ?? ''));
    return payload?.isAdmin === true;
  } catch {
    return false;
  }
}

const WEBHOOKS_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WEBHOOKS_URL
  || 'https://ace-dialer-webhooks.onrender.com';

interface TelnyxStatus {
  indicator: string;
  description: string;
  updatedAt: string;
  fetchedAt: string;
  incidents: Array<{
    id: string;
    name: string;
    status: string;
    impact: string;
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;
}

function colorFor(indicator: string): { bg: string; fg: string } | null {
  switch (indicator) {
    case 'minor':
    case 'maintenance':
      return { bg: '#f59e0b', fg: '#1f2937' };
    case 'major':
      return { bg: '#dc2626', fg: '#ffffff' };
    case 'critical':
      return { bg: '#7f1d1d', fg: '#ffffff' };
    default:
      return null;
  }
}

export default function TelnyxStatusBanner() {
  // v0.10.117 - only show this banner to admins. Regular users don't
  // need (or want) to see Telnyx outage info; it's noise for them.
  // Returns null BEFORE any state/effect hooks so the component is a
  // complete no-op for non-admin users (no fetches, no timers).
  if (!isCurrentUserAdmin()) return null;

  const [status, setStatus] = useState<TelnyxStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const r = await fetch(WEBHOOKS_URL + '/telnyx-status');
        if (!r.ok) return;
        const j = (await r.json()) as TelnyxStatus;
        if (cancelled) return;
        setStatus(j);
      } catch {
        /* network errors silent */
      }
    }
    void poll();
    const interval = setInterval(poll, 60_000);
    const onFocus = () => { void poll(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    setDismissed(false);
  }, [status?.indicator]);

  if (!status || dismissed) return null;
  const color = colorFor(status.indicator);
  if (!color) return null;

  const headline = status.incidents.length > 0
    ? status.incidents[0].name
    : status.description;

  const bannerStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    background: color.bg,
    color: color.fg,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
  };

  const linkStyle: React.CSSProperties = {
    color: color.fg,
    textDecoration: 'underline',
    fontSize: 12,
    opacity: 0.9,
  };

  const closeStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: color.fg,
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '0 4px',
  };

  const icon = status.indicator === 'maintenance' ? 'M' : '!';
  const label = status.indicator === 'maintenance' ? 'maintenance' : 'degraded';

  return (
    <div role="alert" style={bannerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <strong>Telnyx {label}:</strong> {headline}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <a href="https://status.telnyx.com" target="_blank" rel="noopener noreferrer" style={linkStyle} onClick={(e) => e.stopPropagation()}>Details</a>
        <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" style={closeStyle}>x</button>
      </div>
    </div>
  );
}