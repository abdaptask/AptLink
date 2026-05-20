import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone, RefreshCcw, Play, Search, X, MessageSquare, ArrowLeft, Star } from 'lucide-react';
import { getCalls, type CallRecord } from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone, toE164 } from '../lib/phone';
import { addFavorite, isFavorite, removeFavorite, getFavoriteName } from '../lib/userPrefs';

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
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
    c.status === 'failed'
  );
}

function callIcon(c: CallRecord) {
  if (isMissed(c)) return <PhoneMissed size={18} className="ico missed" />;
  if (c.direction === 'inbound') return <PhoneIncoming size={18} className="ico in" />;
  return <PhoneOutgoing size={18} className="ico out" />;
}

function statusLabel(c: CallRecord): string {
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

  return (
    <div className="recents">
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
        {filtered.map((c) => (
          <RecentRow
            key={c.id}
            c={c}
            expanded={expandedId === c.id}
            onCallBack={() => handleCallBack(c)}
            onSendSms={() => handleSendSms(c)}
            onToggleFavorite={() => handleToggleFavorite(c)}
            onToggleRecording={() => setExpandedId(expandedId === c.id ? null : c.id)}
          />
        ))}
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
  onCallBack,
  onSendSms,
  onToggleFavorite,
  onToggleRecording,
}: {
  c: CallRecord;
  expanded: boolean;
  onCallBack: () => void;
  onSendSms: () => void;
  onToggleFavorite: () => void;
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
      <div className="call-row-main" onClick={onCallBack}>
        <div className="call-left">
          {callIcon(c)}
          <div className="call-text">
            <div className="call-number">{displayName}</div>
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
          <Phone size={18} className="callback-ico" aria-hidden="true" />
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
