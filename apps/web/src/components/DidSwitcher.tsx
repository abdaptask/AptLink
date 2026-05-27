// v0.10.0 — Multi-DID dropdown switcher in the dialer top header.
//
// Renders a clickable pill showing the user's currently-active phone
// number (color swatch + label + formatted E.164). Clicking opens a
// popover dropdown listing all the DIDs they own. Selecting a different
// option fires POST /me/active-did, which (a) updates the server-side
// User.activeUserDidId pointer so the choice persists across sessions
// and devices, and (b) PATCHes the matching Telnyx Credential Connection
// so outbound calls switch caller ID within ~1 second.
//
// UX rules:
//   - When the user owns 0 or 1 DIDs, the component renders inline as a
//     static display (no dropdown affordance) so we don't clutter the
//     header for single-DID users.
//   - Active DID is marked with a checkmark in the dropdown.
//   - During the in-flight switch, the picker is locked and the pill
//     shows a subtle spinner; revert visually on failure with a toast.
//   - Closes on outside-click + Escape key.
//
// Data sourcing:
//   - GET /me/dids on mount + on a window 'ace:dids-updated' event so
//     admin-initiated DID changes (new invite, label edit) reflect
//     without a page reload.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Loader2 } from 'lucide-react';
import { getMyDids, switchActiveDid, type UserDidRow } from '../api';
import { formatPhone } from '../lib/phone';

interface Props {
  /**
   * Callback fired after a successful switch so the parent (Layout) can
   * propagate the new caller number into SipContext + send-SMS paths if
   * it caches anything DID-derived locally. Pure notification — the
   * authoritative state lives server-side in User.activeUserDidId.
   */
  onSwitch?: (did: UserDidRow) => void;
}

export default function DidSwitcher({ onSwitch }: Props) {
  const [dids, setDids] = useState<UserDidRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Load (and refresh on the custom event).
  const reload = useCallback(async () => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    try {
      const rows = await getMyDids(token);
      setDids(rows);
      // v0.10.0 Task 5 — share the DID count globally so LineBadge can
      // decide whether to render. Single-DID users get no value from a
      // badge that always shows "Main" on every row.
      window.__aceUserDidCount = rows.length;
    } catch {
      // Silently swallow — single-DID users see static fallback; multi-DID
      // users see nothing different on transient failure. Next reload tick
      // or app-mount cycle will retry.
    }
  }, []);

  useEffect(() => {
    void reload();
    const onEvt = () => { void reload(); };
    window.addEventListener('ace:dids-updated', onEvt);
    return () => window.removeEventListener('ace:dids-updated', onEvt);
  }, [reload]);

  // Outside-click + Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Don't render anything until we know the user's DID count — avoids the
  // 'pill flashes static then becomes dropdown' visual.
  if (dids === null) return null;
  // Zero DIDs: render nothing (the header will fall back to the user's
  // legacy User.didNumber via Layout's existing display). Edge case
  // mostly affects pre-v0.10.0 backfill stragglers.
  if (dids.length === 0) return null;

  const active = dids.find((d) => d.isActiveOutbound) ?? dids[0];

  // Single DID: render the same look as the old static display so single-
  // DID users don't see any change. No interactive affordance.
  if (dids.length === 1) {
    return (
      <span className="did-switcher did-switcher-static" title="Your phone number">
        <span
          className="did-color-swatch"
          style={{ background: active.colorHex }}
          aria-hidden="true"
        />
        <span className="did-label">{active.label}</span>
        <span className="did-sep" aria-hidden="true">·</span>
        <span className="did-number">{formatPhone(active.didNumber)}</span>
      </span>
    );
  }

  // Multi-DID: clickable pill + popover.
  async function handlePick(row: UserDidRow) {
    if (switching) return;
    if (row.id === active.id) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    setError(null);
    const token = sessionStorage.getItem('ace_token');
    if (!token) {
      setSwitching(false);
      setError('Not signed in');
      return;
    }
    const result = await switchActiveDid(token, row.id);
    setSwitching(false);
    setOpen(false);
    if (!result.ok) {
      setError(result.error ?? 'Switch failed');
      return;
    }
    // Optimistic state update so the pill flips instantly; then reload
    // from server so isActiveOutbound flag is authoritative.
    setDids((prev) =>
      prev
        ? prev.map((d) => ({ ...d, isActiveOutbound: d.id === row.id }))
        : prev,
    );
    void reload();
    onSwitch?.(row);
    if (result.warning) {
      // Soft warning: switch landed in DB but Telnyx PATCH didn't.
      // Caller-ID for OUTBOUND calls won't update until Telnyx catches
      // up (admin re-sync or next invite). SMS path uses the new DID
      // already, so this is rarely user-visible.
      console.warn('[did-switcher] partial switch:', result.warning);
    }
  }

  return (
    <div className="did-switcher did-switcher-interactive" ref={rootRef}>
      <button
        type="button"
        className={`did-switcher-pill${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        title={`Active line: ${active.label} (${active.didNumber}). Click to switch.`}
      >
        <span
          className="did-color-swatch"
          style={{ background: active.colorHex }}
          aria-hidden="true"
        />
        <span className="did-label">{active.label}</span>
        <span className="did-sep" aria-hidden="true">·</span>
        <span className="did-number">{formatPhone(active.didNumber)}</span>
        {switching ? (
          <Loader2 size={12} className="did-spinner" aria-hidden="true" />
        ) : (
          <ChevronDown size={12} className="did-caret" aria-hidden="true" />
        )}
      </button>

      {open && (
        <ul
          className="did-switcher-menu"
          role="listbox"
          aria-label="Switch outbound phone number"
        >
          {dids.map((d) => {
            const isActive = d.id === active.id;
            return (
              <li
                key={d.id}
                role="option"
                aria-selected={isActive}
                className={`did-switcher-option${isActive ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="did-switcher-option-btn"
                  onClick={() => void handlePick(d)}
                  disabled={switching}
                >
                  <span
                    className="did-color-swatch"
                    style={{ background: d.colorHex }}
                    aria-hidden="true"
                  />
                  <span className="did-switcher-option-text">
                    <span className="did-switcher-option-label">{d.label}</span>
                    <span className="did-switcher-option-number">
                      {formatPhone(d.didNumber)}
                    </span>
                  </span>
                  {isActive && (
                    <Check
                      size={14}
                      className="did-switcher-option-check"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div className="did-switcher-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
