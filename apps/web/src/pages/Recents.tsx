import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone, RefreshCcw } from 'lucide-react';
import { getCalls, type CallRecord } from '../api';
import { useSip } from '../contexts/SipContext';

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(raw: string): string {
  const d = (raw || '').replace(/[^\d+]/g, '');
  if (!d) return '—';
  if (d.startsWith('+1') && d.length === 12) {
    return `(${d.slice(2, 5)}) ${d.slice(5, 8)}-${d.slice(8)}`;
  }
  return d;
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

function callIcon(c: CallRecord) {
  const missed =
    c.direction === 'inbound' &&
    (c.status === 'no_answer' || c.status === 'missed' || c.status === 'failed');
  if (missed) return <PhoneMissed size={18} className="ico missed" />;
  if (c.direction === 'inbound') return <PhoneIncoming size={18} className="ico in" />;
  return <PhoneOutgoing size={18} className="ico out" />;
}

export default function Recents() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { sipState, call } = useSip();
  const navigate = useNavigate();

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

  return (
    <div className="recents">
      <div className="recents-header">
        <h2>Recents</h2>
        <button className="icon-btn" onClick={load} disabled={loading} aria-label="Refresh">
          <RefreshCcw size={18} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {error && <div className="error" style={{ margin: '0 1rem 1rem' }}>{error}</div>}

      {!loading && calls.length === 0 && !error && (
        <div className="empty-state">
          <p>No calls yet.</p>
          <p className="muted">Calls you make will show up here.</p>
        </div>
      )}

      <ul className="call-list">
        {calls.map((c) => {
          const number = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
          return (
            <li key={c.id} className="call-row" onClick={() => handleCallBack(c)}>
              <div className="call-left">
                {callIcon(c)}
                <div className="call-text">
                  <div className="call-number">{formatNumber(number)}</div>
                  <div className="call-meta">
                    {c.direction === 'inbound' ? 'Incoming' : 'Outgoing'}
                    {c.durationSeconds > 0 && ` · ${formatDuration(c.durationSeconds)}`}
                  </div>
                </div>
              </div>
              <div className="call-right">
                <span className="call-time">{formatTime(c.startedAt)}</span>
                <Phone size={18} className="callback-ico" />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
