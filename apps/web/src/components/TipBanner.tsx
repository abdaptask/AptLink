// v0.10.92 — Floating tip banner.
//
// Shows one feature tip at a time in a compact floating card pinned to the
// bottom-right corner of the dialer. Visible on every screen (mounted at
// Layout level). Cycles through enabled tips one-by-one, each visible for
// at least 12 seconds (the user-specified floor is 10s — we add a small
// buffer so users with the auto-rotate disabled have time to read).
//
// Suppressed when:
//   - An active call is in progress (don't distract during conversation)
//   - User has dismissed via the X button (this session only)
//
// Backend: GET /me/tips returns enabled tips, filtered by adminOnly for
// non-admin users. Admins also see adminOnly tips like "Send praise".
//
// Custom tips authored by admins appear in the same rotation alongside
// the built-in seeded tips, ordered isBuiltIn DESC then createdAt ASC
// (curated content first, custom appends at the end of the cycle).

import { useEffect, useRef, useState } from 'react';
import { Lightbulb, X, ChevronRight } from 'lucide-react';
import { listMyTips, type Tip } from '../api';
import { useSip } from '../contexts/SipContext';

// User-facing requirement: each tip stays at least 10s. We use a slightly
// longer auto-advance so the tip is actually readable for the full window.
const TIP_DISPLAY_MS = 12_000;
// Re-fetch the tip pool every 5 minutes so newly-authored admin tips show up
// in user sessions without a reload.
const REFETCH_INTERVAL_MS = 5 * 60 * 1000;

export default function TipBanner() {
  const [tips, setTips] = useState<Tip[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  // Dismissed flag — persists for the lifetime of this dialer session
  // (until next Electron / page reload). On the next session the tip
  // banner reappears so users see new tips without us needing to track
  // per-user-per-tip read state on the server.
  const [dismissed, setDismissed] = useState(false);
  const { callState } = useSip();

  // Don't show while on a call — same suppression rule as PraiseModal.
  const callActive =
    callState.state === 'connected' ||
    callState.state === 'ringing' ||
    callState.state === 'calling';

  // Initial fetch + periodic refetch.
  const inFlightRef = useRef(false);
  useEffect(() => {
    async function fetchNow() {
      if (inFlightRef.current) return;
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      inFlightRef.current = true;
      try {
        const rows = await listMyTips(token);
        setTips(rows);
      } finally {
        inFlightRef.current = false;
      }
    }
    void fetchNow();
    const id = window.setInterval(fetchNow, REFETCH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Auto-rotate one tip at a time, 12s each. Pauses if dismissed,
  // call-active, or the tip pool is empty.
  useEffect(() => {
    if (dismissed || callActive || tips.length <= 1) return;
    const id = window.setInterval(() => {
      setCurrentIdx((i) => (i + 1) % tips.length);
    }, TIP_DISPLAY_MS);
    return () => window.clearInterval(id);
  }, [dismissed, callActive, tips.length]);

  // Reset currentIdx if it goes out of bounds (e.g. admin disabled the tip
  // we were showing and the pool shrank).
  useEffect(() => {
    if (currentIdx >= tips.length && tips.length > 0) {
      setCurrentIdx(0);
    }
  }, [currentIdx, tips.length]);

  if (dismissed || callActive || tips.length === 0) return null;

  const current = tips[currentIdx % tips.length];
  if (!current) return null;

  function handleNext() {
    setCurrentIdx((i) => (i + 1) % Math.max(tips.length, 1));
  }
  function handleDismiss() {
    setDismissed(true);
  }

  return (
    <div
      className="tip-banner"
      role="region"
      aria-label="Feature tip"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 950,            // below modals (z 1000+), above main content
        width: 320,
        maxWidth: 'calc(100vw - 40px)',
        background: 'var(--bg, #ffffff)',
        color: 'var(--text, #0f172a)',
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 12,
        boxShadow: '0 8px 24px rgba(15, 23, 42, 0.14)',
        padding: '14px 16px 14px 18px',
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <div style={{ flexShrink: 0, fontSize: 22, lineHeight: 1, paddingTop: 2 }}>
        {current.icon || <Lightbulb size={20} aria-hidden />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted, #64748b)', marginBottom: 4, fontWeight: 600 }}>
          Did you know?
        </div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {current.title}
        </div>
        <div style={{ color: 'var(--text-muted, #475569)' }}>
          {current.body}
        </div>
        {tips.length > 1 && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted, #94a3b8)' }}>
            Tip {currentIdx + 1} of {tips.length}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss tips for this session"
          title="Hide tips for this session"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted, #64748b)',
            cursor: 'pointer',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={16} />
        </button>
        {tips.length > 1 && (
          <button
            type="button"
            onClick={handleNext}
            aria-label="Next tip"
            title="Next tip"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted, #64748b)',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
