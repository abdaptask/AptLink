// Phase 5.6 — Voicemail list. Populated by webhook when Telnyx finishes
// recording an unanswered call.
import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Trash2, RefreshCcw, Play, Voicemail as VoicemailIcon, Search, X } from 'lucide-react';
import {
  getVoicemails,
  markVoicemailListened,
  deleteVoicemail,
  type VoicemailRecord,
} from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';

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
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Voicemail() {
  const [items, setItems] = useState<VoicemailRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const { sipState, call } = useSip();
  const navigate = useNavigate();

  // Client-side filter: phone digits, transcription text, and cached
  // JobDiva contact name.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    const qDigits = q.replace(/[^\d]/g, '');
    return items.filter((vm) => {
      const digits = (vm.fromNumber || '').replace(/[^\d]/g, '');
      if (qDigits && digits.includes(qDigits)) return true;
      if ((vm.transcription ?? '').toLowerCase().includes(q)) return true;
      const cachedName = getCachedJobDivaName(vm.fromNumber);
      if (cachedName && cachedName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [items, search]);

  const load = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getVoicemails(token)
      .then(setItems)
      .catch((e) => setError(e.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleExpand(vm: VoicemailRecord) {
    const next = expandedId === vm.id ? null : vm.id;
    setExpandedId(next);
    if (next && !vm.listenedAt) {
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      try {
        await markVoicemailListened(token, vm.id, true);
        setItems((prev) =>
          prev.map((p) => (p.id === vm.id ? { ...p, listenedAt: new Date().toISOString() } : p)),
        );
      } catch {
        /* ignore */
      }
    }
  }

  async function handleDelete(vm: VoicemailRecord) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!confirm('Delete this voicemail?')) return;
    try {
      await deleteVoicemail(token, vm.id);
      setItems((prev) => prev.filter((p) => p.id !== vm.id));
    } catch {
      /* ignore */
    }
  }

  function handleCallBack(vm: VoicemailRecord) {
    if (!vm.fromNumber) return;
    if (sipState !== 'registered') {
      alert(`SIP not ready (${sipState}). Try again in a moment.`);
      return;
    }
    call(vm.fromNumber);
    navigate('/in-call');
  }

  return (
    <div className="voicemail">
      <div className="voicemail-header">
        <h2>Voicemail</h2>
        <button className="icon-btn" onClick={load} disabled={loading} aria-label="Refresh">
          <RefreshCcw size={18} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="search-bar">
        <Search size={16} className="search-icon" aria-hidden="true" />
        <input
          type="search"
          className="search-input"
          placeholder="Search voicemails"
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

      {!loading && items.length === 0 && !error && (
        <div className="empty-state">
          <VoicemailIcon size={32} style={{ opacity: 0.4, marginBottom: '0.5rem' }} />
          <p>No voicemails yet.</p>
          <p className="muted">Missed-call voicemails will appear here.</p>
        </div>
      )}

      {!loading && items.length > 0 && filtered.length === 0 && (
        <div className="empty-state">
          <p>No voicemails match “{search}”.</p>
        </div>
      )}

      <ul className="vm-list">
        {filtered.map((vm) => (
          <VoicemailRow
            key={vm.id}
            vm={vm}
            expanded={expandedId === vm.id}
            onExpand={() => handleExpand(vm)}
            onCallBack={() => handleCallBack(vm)}
            onDelete={() => handleDelete(vm)}
          />
        ))}
      </ul>
    </div>
  );
}

function VoicemailRow({
  vm,
  expanded,
  onExpand,
  onCallBack,
  onDelete,
}: {
  vm: VoicemailRecord;
  expanded: boolean;
  onExpand: () => void;
  onCallBack: () => void;
  onDelete: () => void;
}) {
  const jd = useJobDivaContact(vm.fromNumber);
  const label = jd?.name ?? formatNumber(vm.fromNumber);
  const unread = !vm.listenedAt;
  return (
    <li className={`vm-row${unread ? ' unread' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="vm-row-main" onClick={onExpand}>
        <div className="vm-left">
          {unread && <span className="vm-dot" aria-label="Unread" />}
          <div className="vm-text">
            <div className="vm-number">{label}</div>
            <div className="vm-meta">
              {formatTime(vm.receivedAt)}
              {vm.durationSeconds > 0 && ` · ${formatDuration(vm.durationSeconds)}`}
            </div>
          </div>
        </div>
        <div className="vm-right">
          <button type="button" className="vm-action" aria-label="Play" onClick={(e) => { e.stopPropagation(); onExpand(); }}>
            <Play size={16} />
          </button>
          <button type="button" className="vm-action callback" aria-label="Call back" onClick={(e) => { e.stopPropagation(); onCallBack(); }}>
            <Phone size={16} />
          </button>
          <button type="button" className="vm-action delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="vm-body">
          <audio controls src={vm.recordingUrl} preload="none" style={{ width: '100%' }} />
          {vm.transcription && (
            <p className="vm-transcript">
              <span className="vm-transcript-tag">Transcript</span>
              {vm.transcription}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
