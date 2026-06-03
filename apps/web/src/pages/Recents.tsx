import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone, RefreshCcw, Play, Search, X, MessageSquare, ArrowLeft, Star, Ban } from 'lucide-react';
import { getCalls, addBlockedNumber, type CallRecord } from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone, toE164 } from '../lib/phone';
import { addFavorite, isFavorite, removeFavorite, getFavoriteName } from '../lib/userPrefs';
import LineBadge from '../components/LineBadge';

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(raw: string): string {
  return formatPhone(raw) || '—';
}

function formatTime(iso: string): string {
  // v0.10.55 — Always include time-of-day so users can tell WHEN a call/SMS/VM
  // landed, not just which day. Previously "Yesterday" and "Jun 1" carried no
  // time, which made it impossible to scan recents for the latest activity.
  // Today  → "9:37 AM"
  // Y'day  → "Yesterday, 9:37 AM"
  // Older  → "Jun 1, 9:37 AM"
  const date = new Date(iso);
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return timeStr;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday, ${timeStr}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
}

function isMissed(c: CallRecord): boolean {
  // Any inbound call that didn't connect counts as red:
  // - missed (rang out)
  // - no_answer (Telnyx-side timeout)
  // - rejected (user clicked Decline)
  // - failed
  if (c.direction !== 'inbound') return false;
  return (
    c.status === 'missed' ||
    c.status === 'no_answer' ||
    c.status === 'rejected' ||
    c.status === 'failed' ||
    c.status === 'blocked'
  );
}

function callIcon(c: CallRecord) {
  if (c.status === 'blocked') return <Ban size={18} className="ico blocked" />;
  if (isMissed(c)) return <PhoneMissed size={18} className="ico missed" />;
  if (c.direction === 'inbound') return <PhoneIncoming size={18} className="ico in" />;
  return <PhoneOutgoing size={18} className="ico out" />;
}

function statusLabel(c: CallRecord): string {
  if (c.status === 'blocked') return 'Blocked';
  if (c.direction === 'inbound') {
    if (c.status === 'rejected') return 'Declined';
    if (c.status === 'missed' || c.status === 'no_answer') return 'Missed';
    if (c.status === 'failed') return 'Failed';
    return 'Incoming';
  }
  return 'Outgoing';
}

// Last-10-digit normalization for phone matching (matches the API's helper).
function last10(s: string | undefined | null): string {
  return (s ?? '').replace(/[^\d]/g, '').slice(-10);
}

export default function Recents() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // "Add to favorites" modal — pre-filled with the row's phone + (when known)
  // first/last name parsed from the JobDiva contact. User can edit before
  // saving so favorites always carry friendly names.
  const [addFavTarget, setAddFavTarget] = useState<
    | null
    | { phone: string; firstName: string; lastName: string }
  >(null);
  // Bumped whenever favorites change so star icons re-render their state.
  const [, setFavTick] = useState(0);
  useEffect(() => {
    const refresh = () => setFavTick((t) => t + 1);
    window.addEventListener('ace:favoritesChanged', refresh);
    return () => window.removeEventListener('ace:favoritesChanged', refresh);
  }, []);
  // Set of last-10-digit numbers the user blocked in this session, so we
  // can hide the Block button on those rows without waiting for a reload.
  // (The CallRecord rows themselves don't know about the blocklist — that
  // status is server-side and only applies to FUTURE inbound calls.) (#159)
  const [blockedThisSession, setBlockedThisSession] = useState<Set<string>>(new Set());
  // v0.10.55 — Copy-on-tap toast.
  // Tapping a row used to immediately dial the contact, which is dangerous
  // (accidental call) and unhelpful when the user just wants to grab the
  // number. New behavior: row tap copies the number to clipboard and
  // briefly shows a "Copied X" pill. The Phone icon on the right of the
  // row is now an actual button for placing the call.
  const [copiedNumber, setCopiedNumber] = useState<string | null>(null);
  const { sipState, call } = useSip();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Contact-filter mode (entered via ?phone=...&from=...). Filters the
  // list to just that contact and shows a back bar that returns to `from`.
  const contactFilter = searchParams.get('phone');
  const fromUrl = searchParams.get('from');
  const contactWant = contactFilter ? last10(contactFilter) : '';

  const load = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getCalls(token)
      .then(setCalls)
      .catch((e) => setError(e.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Client-side filter. Matches against:
  //   - phone digits (both fromNumber + toNumber so single-direction works)
  //   - status label ("Missed", "Outgoing", etc.)
  //   - hangup cause
  //   - cached JobDiva contact name (instantly for contacts we've already
  //     looked up; first-time searches need the cache to warm via row render)
  const filtered = useMemo(() => {
    // First narrow by contact filter (?phone=...) if present.
    let base = calls;
    if (contactWant) {
      base = calls.filter((c) => {
        const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
        return last10(other) === contactWant;
      });
    }
    const q = search.trim().toLowerCase();
    if (!q) return base;
    const qDigits = q.replace(/[^\d]/g, '');
    return base.filter((c) => {
      const number = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
      const fromDigits = (c.fromNumber || '').replace(/[^\d]/g, '');
      const toDigits = (c.toNumber || '').replace(/[^\d]/g, '');
      if (qDigits && (fromDigits.includes(qDigits) || toDigits.includes(qDigits))) return true;
      if (statusLabel(c).toLowerCase().includes(q)) return true;
      if ((c.hangupCause ?? '').toLowerCase().includes(q)) return true;
      const cachedName = getCachedJobDivaName(number);
      if (cachedName && cachedName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [calls, search, contactWant]);

  // Contact label for the back bar — use the cached JobDiva name if available,
  // otherwise fall back to a formatted phone number.
  const contactLabel = contactFilter
    ? getCachedJobDivaName(contactFilter) ?? formatNumber(contactFilter)
    : '';

  function goBack() {
    if (fromUrl) {
      navigate(fromUrl);
    } else {
      navigate('/recents');
    }
  }

  function handleCallBack(c: CallRecord) {
    const target = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!target) return;
    if (sipState !== 'registered') {
      alert(`SIP not ready (${sipState}). Try again in a moment.`);
      return;
    }
    call(target);
    navigate('/in-call');
  }

  // v0.10.55 — Row-tap copy. Writes to system clipboard (when available)
  // and shows a brief floating toast. Falls back to a hidden textarea
  // execCommand-copy on browsers without async clipboard. Toast lives in
  // state and auto-dismisses after 1800ms.
  function handleCopyNumber(c: CallRecord) {
    const target = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!target) return;
    const pretty = formatPhone(target) || target;
    const writePromise = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(target)
      : Promise.reject(new Error('no async clipboard'));
    writePromise
      .catch(() => {
        // Fallback for older browsers / non-secure contexts.
        try {
          const ta = document.createElement('textarea');
          ta.value = target;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch {
          /* swallow — user can still long-press to copy manually */
        }
      })
      .finally(() => {
        setCopiedNumber(pretty);
        window.setTimeout(() => {
          setCopiedNumber((current) => (current === pretty ? null : current));
        }, 1800);
      });
  }

  function handleSendSms(c: CallRecord) {
    const target = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!target) return;
    navigate(`/messages?to=${encodeURIComponent(target)}`);
  }

  // Star toggle. If already a favorite → remove silently. Otherwise → pop
  // the same Add Favorite modal Favorites uses, pre-filling phone + first/
  // last name parsed from the JobDiva contact when available.
  function handleToggleFavorite(c: CallRecord) {
    const target = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!target) return;
    if (isFavorite(target)) {
      removeFavorite(target);
      return;
    }
    // Try to seed first/last from cached JobDiva name like "First Last".
    const cached = getCachedJobDivaName(target) ?? '';
    const parts = cached.trim().split(/\s+/);
    const firstName = parts[0] ?? '';
    const lastName = parts.slice(1).join(' ');
    setAddFavTarget({
      phone: toE164(target),
      firstName,
      lastName,
    });
  }

  function saveAddFav() {
    if (!addFavTarget) return;
    addFavorite(addFavTarget.phone, {
      firstName: addFavTarget.firstName.trim() || null,
      lastName: addFavTarget.lastName.trim() || null,
    });
    setAddFavTarget(null);
  }

  // Block the other party on this call. Confirms first; on success we just
  // show a quick alert so the user knows it took. The webhook will start
  // dropping their calls/SMS immediately. Manage in Settings → Blocked. (#159)
  async function handleBlock(c: CallRecord) {
    const target = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!target) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const friendly = getFavoriteName(target) ?? getCachedJobDivaName(target) ?? formatNumber(target);
    if (
      !confirm(
        `Block ${friendly}?\n\nThey won't be able to call or text you. ` +
          'Unblock anytime in Settings → Blocked numbers.',
      )
    ) {
      return;
    }
    try {
      await addBlockedNumber(token, { number: target, reason: 'Blocked from Recents' });
      // Remember this number for the session so the Block button disappears
      // from every row that shares the same last-10 digits.
      const key = last10(target);
      if (key) {
        setBlockedThisSession((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
      alert(`${friendly} has been blocked.`);
    } catch (e) {
      alert(`Could not block: ${(e as Error).message}`);
    }
  }

  return (
    <div className="recents">
      {/* v0.10.55 — Copy-number toast. Mounted at the page level (not per
          row) so it lives in a single fixed position and doesn't shift the
          row layout. Auto-dismisses via the setTimeout in handleCopyNumber. */}
      {copiedNumber && (
        <div className="copy-toast" role="status" aria-live="polite">
          Copied {copiedNumber}
        </div>
      )}
      {contactFilter && (
        <button
          type="button"
          className="contact-filter-bar"
          onClick={goBack}
          aria-label={`Back to ${contactLabel || 'previous page'}`}
        >
          <ArrowLeft size={16} />
          <span className="contact-filter-text">
            <span className="contact-filter-tag">Showing calls with</span>
            <span className="contact-filter-name">{contactLabel}</span>
          </span>
          <span className="contact-filter-back">← Back</span>
        </button>
      )}
      <div className="recents-header">
        <h2>{contactFilter ? 'Calls' : 'Recents'}</h2>
        <button className="icon-btn" onClick={load} disabled={loading} aria-label="Refresh">
          <RefreshCcw size={18} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="search-bar">
        <Search size={16} className="search-icon" aria-hidden="true" />
        <input
          type="search"
          className="search-input"
          placeholder="Search by number or status"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="search-clear"
            onClick={() => setSearch('')}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {error && <div className="error" style={{ margin: '0 1rem 1rem' }}>{error}</div>}

      {!loading && calls.length === 0 && !error && (
        <div className="empty-state">
          <p>No calls yet.</p>
          <p className="muted">Calls you make will show up here.</p>
        </div>
      )}

      {!loading && calls.length > 0 && filtered.length === 0 && (
        <div className="empty-state">
          <p>No results for “{search}”.</p>
        </div>
      )}

      <ul className="call-list">
        {filtered.map((c) => {
          const num = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
          const sessionBlocked = !!num && blockedThisSession.has(last10(num));
          return (
            <RecentRow
              key={c.id}
              c={c}
              expanded={expandedId === c.id}
              blockedHere={sessionBlocked}
              onCallBack={() => handleCallBack(c)}
              onCopy={() => handleCopyNumber(c)}
              onSendSms={() => handleSendSms(c)}
              onToggleFavorite={() => handleToggleFavorite(c)}
              onBlock={() => handleBlock(c)}
              onToggleRecording={() => setExpandedId(expandedId === c.id ? null : c.id)}
            />
          );
        })}
      </ul>

      {addFavTarget && (
        <div className="compose-modal" onClick={() => setAddFavTarget(null)}>
          <div
            className="fav-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="fav-modal-title"
          >
            <div className="fav-modal-header">
              <Star size={18} fill="currentColor" className="fav-modal-icon" />
              <h3 id="fav-modal-title">Add to favorites</h3>
            </div>
            <div className="fav-modal-phone">
              {formatPhone(addFavTarget.phone) || addFavTarget.phone}
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); saveAddFav(); }}
              autoComplete="off"
            >
              {/* Honeypot — keeps password managers from autofilling the real
                  fields below. Hidden but present in the DOM, which is enough
                  for 1Password / LastPass to target it instead. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                style={{ display: 'none' }}
                tabIndex={-1}
                aria-hidden="true"
              />
              <div className="fav-modal-row">
                <label className="fav-modal-field">
                  <span className="fav-modal-label">First name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    placeholder="Optional"
                    value={addFavTarget.firstName}
                    onChange={(e) =>
                      setAddFavTarget({ ...addFavTarget, firstName: e.target.value })
                    }
                    autoFocus
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    name="fav-first"
                  />
                </label>
                <label className="fav-modal-field">
                  <span className="fav-modal-label">Last name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    placeholder="Optional"
                    value={addFavTarget.lastName}
                    onChange={(e) =>
                      setAddFavTarget({ ...addFavTarget, lastName: e.target.value })
                    }
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    name="fav-last"
                  />
                </label>
              </div>
              <div className="fav-modal-actions">
                <button
                  type="button"
                  className="fav-modal-cancel"
                  onClick={() => setAddFavTarget(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="fav-modal-save">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function RecentRow({
  c,
  expanded,
  blockedHere,
  onCallBack,
  onCopy,
  onSendSms,
  onToggleFavorite,
  onBlock,
  onToggleRecording,
}: {
  c: CallRecord;
  expanded: boolean;
  blockedHere: boolean;
  onCallBack: () => void;
  // v0.10.55 — Row tap copies the number instead of dialing.
  onCopy: () => void;
  onSendSms: () => void;
  onToggleFavorite: () => void;
  onBlock: () => void;
  onToggleRecording: () => void;
}) {
  const number = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
  const missed = isMissed(c);
  const isFav = !!number && isFavorite(number);
  // Calling this hook here warms the JobDiva cache as the rows render, so
  // the parent's name-based filter starts matching on subsequent keystrokes.
  const jd = useJobDivaContact(number);
  const displayName = getFavoriteName(number) ?? jd?.name ?? formatNumber(number);
  return (
    <li className={`call-row${missed ? ' missed' : ''}${expanded ? ' expanded' : ''}`}>
      {/* v0.10.55 — Row tap now copies the number to clipboard (see onCopy).
          Dial action moved to the Phone icon button on the right so users
          can still call in one tap. Title attribute teaches users about
          the new behavior. */}
      <div className="call-row-main" onClick={onCopy} title="Tap to copy number">
        <div className="call-left">
          {callIcon(c)}
          <div className="call-text">
            <div className="call-number">
              {displayName}
              {/* v0.10.0 Task 5 — Line tag: which of the user's DIDs this
                  call touched. Inbound: the DID the caller dialed.
                  Outbound: the DID the user called from. Auto-hidden when
                  the user owns only 1 DID. */}
              <LineBadge userDid={c.userDid} />
            </div>
            <div className="call-meta">
              {statusLabel(c)}
              {jd?.company ? ` · ${jd.company}` : ''}
              {c.durationSeconds > 0 && ` · ${formatDuration(c.durationSeconds)}`}
              {c.recordingUrl && ' · Recorded'}
            </div>
          </div>
        </div>
        <div className="call-right">
          {c.recordingUrl && (
            <button
              type="button"
              className="callback-ico recording-toggle"
              aria-label={expanded ? 'Hide recording' : 'Play recording'}
              title={expanded ? 'Hide recording' : 'Play recording'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleRecording();
              }}
            >
              <Play size={16} />
            </button>
          )}
          <span className="call-time">{formatTime(c.startedAt)}</span>
          <button
            type="button"
            className="callback-ico sms-ico"
            aria-label="Send message"
            title="Send message"
            onClick={(e) => {
              e.stopPropagation();
              onSendSms();
            }}
          >
            <MessageSquare size={16} />
          </button>
          <button
            type="button"
            className={`callback-ico fav-ico${isFav ? ' active' : ''}`}
            aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
            title={isFav ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
          >
            <Star size={16} fill={isFav ? 'currentColor' : 'none'} />
          </button>
          {/* "Block this number" — hidden on calls that came in blocked AND
              on numbers the user just blocked this session. (#159) */}
          {c.status !== 'blocked' && !blockedHere && number && (
            <button
              type="button"
              className="callback-ico block-ico"
              aria-label="Block this number"
              title="Block this number"
              onClick={(e) => {
                e.stopPropagation();
                onBlock();
              }}
            >
              <Ban size={16} />
            </button>
          )}
          {/* v0.10.55 — Phone icon is now a real button (was decorative).
              Previously the row tap dialed; now the row tap copies, so the
              call action moved here. stopPropagation so we don't also fire
              the row's copy handler. */}
          <button
            type="button"
            className="callback-ico call-ico"
            aria-label="Call this number"
            title="Call this number"
            onClick={(e) => {
              e.stopPropagation();
              onCallBack();
            }}
          >
            <Phone size={18} />
          </button>
        </div>
      </div>
      {expanded && c.recordingUrl && (
        <div className="call-recording">
          <audio controls src={c.recordingUrl} preload="none" style={{ width: '100%' }} />
        </div>
      )}
    </li>
  );
}
