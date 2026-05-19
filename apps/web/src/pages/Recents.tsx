import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone, RefreshCcw, Play, Search, X, MessageSquare, ArrowLeft } from 'lucide-react';
import { getCalls, type CallRecord } from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone } from '../lib/phone';

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
            onToggleRecording={() => setExpandedId(expandedId === c.id ? null : c.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function RecentRow({
  c,
  expanded,
  onCallBack,
  onSendSms,
  onToggleRecording,
}: {
  c: CallRecord;
  expanded: boolean;
  onCallBack: () => void;
  onSendSms: () => void;
  onToggleRecording: () => void;
}) {
  const number = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
  const missed = isMissed(c);
  // Calling this hook here warms the JobDiva cache as the rows render, so
  // the parent's name-based filter starts matching on subsequent keystrokes.
  const jd = useJobDivaContact(number);
  const displayName = jd?.name ?? formatNumber(number);
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
