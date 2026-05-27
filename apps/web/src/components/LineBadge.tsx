// v0.10.0 Task 5 — Line-badge pill rendered on Recents / Messages /
// Voicemail rows to show which of the user's DIDs the interaction
// landed on (inbound) or was sent from (outbound).
//
// Two render modes:
//   - "row" (default): compact pill — color swatch + label only, suitable
//     for inline use next to a phone number in a list row.
//   - "header": slightly more verbose — adds formatted phone number,
//     used in the Messages thread-detail header.
//
// Hidden automatically when:
//   - userDid is null/undefined (legacy rows, or single-DID users in some
//     queries before backfill)
//   - The current user owns only 1 DID total. Single-DID users get no
//     value from a badge that always shows "Main" on every row — it just
//     clutters the UI. We read the total DID count from a shared cache
//     (window.__aceUserDidCount) that DidSwitcher populates on every
//     /me/dids fetch. Falls back to "show" if the count isn't known yet.

import { formatPhone } from '../lib/phone';

interface UserDidLite {
  id: number;
  label: string;
  colorHex: string;
  didNumber?: string | null;
}

interface Props {
  userDid: UserDidLite | null | undefined;
  variant?: 'row' | 'header';
  /**
   * Optional override of the "hide for single-DID users" rule. Set this
   * to `true` for cases where you genuinely want the badge even when the
   * user has only one DID (e.g. a settings preview screen). Defaults to
   * the multi-DID-only rule.
   */
  alwaysShow?: boolean;
}

declare global {
  interface Window {
    /** Total UserDid count for the current user. Populated by DidSwitcher
     *  on every /me/dids fetch and read here to decide visibility. */
    __aceUserDidCount?: number;
  }
}

export default function LineBadge({ userDid, variant = 'row', alwaysShow = false }: Props) {
  if (!userDid) return null;

  // Honor the "multi-DID only" rule unless explicitly overridden. When
  // the count hasn't been populated yet (e.g. on the very first page
  // load before DidSwitcher mounts), default to showing — better to
  // briefly show badges that disappear than to briefly hide badges that
  // should be visible.
  if (!alwaysShow) {
    const count = window.__aceUserDidCount;
    if (typeof count === 'number' && count <= 1) return null;
  }

  return (
    <span
      className={`line-badge line-badge-${variant}`}
      title={
        userDid.didNumber
          ? `${userDid.label} · ${formatPhone(userDid.didNumber)}`
          : userDid.label
      }
    >
      <span
        className="line-badge-swatch"
        style={{ background: userDid.colorHex }}
        aria-hidden="true"
      />
      <span className="line-badge-label">{userDid.label}</span>
      {variant === 'header' && userDid.didNumber && (
        <>
          <span className="line-badge-sep" aria-hidden="true">·</span>
          <span className="line-badge-number">{formatPhone(userDid.didNumber)}</span>
        </>
      )}
    </span>
  );
}
