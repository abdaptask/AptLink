// Phase 5.6 — Voicemail list. Populated by webhook when Telnyx finishes
// recording an unanswered call.
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Phone,
  Trash2,
  RefreshCcw,
  Play,
  Voicemail as VoicemailIcon,
  Search,
  X,
  Circle,
  CheckCircle2,
  CheckSquare,
  Square,
  MessageSquare,
  ArrowLeft,
} from 'lucide-react';
import {
  getVoicemails,
  markVoicemailListened,
  bulkMarkVoicemails,
  deleteVoicemail,
  getVoicemailRetentionDays,
  type VoicemailRecord,
} from '../api';
import { useSip } from '../contexts/SipContext';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { formatPhone } from '../lib/phone';
import { getFavoriteName } from '../lib/userPrefs';

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
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Voicemail() {
  const [items, setItems] = useState<VoicemailRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Re-render rows when the user adds/removes a favorite so the friendly
  // name on each voicemail row updates without a manual refresh. (#161)
  const [, setFavTick] = useState(0);
  useEffect(() => {
    const refresh = () => setFavTick((t) => t + 1);
    window.addEventListener('ace:favoritesChanged', refresh);
    return () => window.removeEventListener('ace:favoritesChanged', refresh);
  }, []);
  // Server tells us how many days voicemails are retained. Cached once
  // per session. Used to render the "Auto-deletes in X days" countdown.
  const [retentionDays, setRetentionDays] = useState(30);
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    getVoicemailRetentionDays(token).then(setRetentionDays).catch(() => undefined);
  }, []);
  const { sipState, call } = useSip();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Contact-filter mode (entered via ?phone=...&from=...)
  const contactFilter = searchParams.get('phone');
  const fromUrl = searchParams.get('from');
  const contactWant = contactFilter ? (contactFilter.replace(/[^\d]/g, '').slice(-10)) : '';

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllFiltered(ids: number[]) {
    setSelected(new Set(ids));
  }
  function clearSelection() {
    setSelected(new Set());
  }
  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  // Client-side filter: contact-filter (if ?phone= present) + search.
  const filtered = useMemo(() => {
    let base = items;
    if (contactWant) {
      base = items.filter((vm) => (vm.fromNumber || '').replace(/[^\d]/g, '').slice(-10) === contactWant);
    }
    const q = search.trim().toLowerCase();
    if (!q) return base;
    const qDigits = q.replace(/[^\d]/g, '');
    return base.filter((vm) => {
      const digits = (vm.fromNumber || '').replace(/[^\d]/g, '');
      if (qDigits && digits.includes(qDigits)) return true;
      if ((vm.transcription ?? '').toLowerCase().includes(q)) return true;
      // Match against the user-saved favorite name so searching "Adam"
      // finds a voicemail from a starred contact. (#161)
      const favName = getFavoriteName(vm.fromNumber);
      if (favName && favName.toLowerCase().includes(q)) return true;
      const cachedName = getCachedJobDivaName(vm.fromNumber);
      if (cachedName && cachedName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [items, search, contactWant]);

  const contactLabel = contactFilter
    ? getFavoriteName(contactFilter)
      ?? getCachedJobDivaName(contactFilter)
      ?? formatNumber(contactFilter)
    : '';

  function goBack() {
    if (fromUrl) navigate(fromUrl);
    else navigate('/voicemail');
  }

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

  // Auto-poll the list while any voicemail is still missing a transcript.
  // Deepgram typically returns within 3-5 sec of the voicemail webhook;
  // we poll every 4 sec for up to 60 sec, then stop. Hand-edited refresh
  // (e.g. switching tabs and back) restarts the loop naturally via the
  // load() effect above.
  useEffect(() => {
    const missing = items.some((vm) => !vm.transcription);
    if (!missing) return;
    let cancelled = false;
    let elapsed = 0;
    const id = window.setInterval(() => {
      elapsed += 4000;
      if (elapsed > 60_000 || cancelled) {
        window.clearInterval(id);
        return;
      }
      // Only refetch — don't show the loading spinner, this is silent.
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      getVoicemails(token).then(setItems).catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [items]);

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

  async function handleBulkDelete() {
    const token = sessionStorage.getItem('ace_token');
    if (!token || selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} voicemail${selected.size === 1 ? '' : 's'}?`)) return;
    const ids = Array.from(selected);
    // Optimistic — remove from UI, then fire deletes in parallel.
    setItems((prev) => prev.filter((p) => !selected.has(p.id)));
    setSelected(new Set());
    await Promise.allSettled(ids.map((id) => deleteVoicemail(token, id)));
  }

  async function handleBulkMark(listened: boolean) {
    const token = sessionStorage.getItem('ace_token');
    if (!token || selected.size === 0) return;
    const ids = Array.from(selected);
    // Optimistic UI flip first.
    const nowIso = listened ? new Date().toISOString() : null;
    setItems((prev) =>
      prev.map((p) => (selected.has(p.id) ? { ...p, listenedAt: nowIso } : p)),
    );
    setSelected(new Set());
    try {
      await bulkMarkVoicemails(token, ids, listened);
    } catch {
      /* ignore — list reloads on next poll */
    }
  }

  async function handleToggleUnread(vm: VoicemailRecord) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const nowListened = !vm.listenedAt;
    try {
      await markVoicemailListened(token, vm.id, nowListened);
      setItems((prev) =>
        prev.map((p) =>
          p.id === vm.id
            ? { ...p, listenedAt: nowListened ? new Date().toISOString() : null }
            : p,
        ),
      );
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

  function handleSendSms(vm: VoicemailRecord) {
    if (!vm.fromNumber) return;
    navigate(`/messages?to=${encodeURIComponent(vm.fromNumber)}`);
  }

  return (
    <div className="voicemail">
      {contactFilter && (
        <button
          type="button"
          className="contact-filter-bar"
          onClick={goBack}
          aria-label={`Back to ${contactLabel || 'previous page'}`}
        >
          <ArrowLeft size={16} />
          <span className="contact-filter-text">
            <span className="contact-filter-tag">Showing voicemails from</span>
            <span className="contact-filter-name">{contactLabel}</span>
          </span>
          <span className="contact-filter-back">← Back</span>
        </button>
      )}
      <div className="voicemail-header">
        <h2>{contactFilter ? 'Voicemails' : 'Voicemail'}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {!selectMode && items.length > 0 && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSelectMode(true)}
              aria-label="Select"
              title="Select multiple"
            >
              <CheckSquare size={18} />
            </button>
          )}
          {selectMode && (
            <button
              type="button"
              className="icon-btn"
              onClick={exitSelectMode}
              aria-label="Cancel selection"
              title="Cancel"
            >
              <X size={18} />
            </button>
          )}
          <button className="icon-btn" onClick={load} disabled={loading} aria-label="Refresh">
            <RefreshCcw size={18} className={loading ? 'spin' : ''} />
          </button>
        </div>
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

      {selectMode && (
        <div className="vm-select-bar">
          <span className="vm-select-count">
            {selected.size} selected
          </span>
          <div className="vm-select-actions">
            <button
              type="button"
              className="device-action"
              onClick={() => selectAllFiltered(filtered.map((v) => v.id))}
            >
              Select all
            </button>
            <button
              type="button"
              className="device-action"
              onClick={clearSelection}
              disabled={selected.size === 0}
            >
              Clear
            </button>
            <button
              type="button"
              className="device-action"
              onClick={() => handleBulkMark(true)}
              disabled={selected.size === 0}
              title="Mark selected as read"
            >
              <CheckCircle2 size={14} /> Mark read
            </button>
            <button
              type="button"
              className="device-action"
              onClick={() => handleBulkMark(false)}
              disabled={selected.size === 0}
              title="Mark selected as unread"
            >
              <Circle size={14} /> Mark unread
            </button>
            <button
              type="button"
              className="device-action primary danger"
              onClick={handleBulkDelete}
              disabled={selected.size === 0}
            >
              <Trash2 size={14} /> Delete ({selected.size})
            </button>
          </div>
        </div>
      )}

      <ul className="vm-list">
        {filtered.map((vm) => (
          <VoicemailRow
            key={vm.id}
            vm={vm}
            retentionDays={retentionDays}
            expanded={expandedId === vm.id}
            selectMode={selectMode}
            checked={selected.has(vm.id)}
            onToggleSelect={() => toggleSelected(vm.id)}
            onExpand={() => handleExpand(vm)}
            onCallBack={() => handleCallBack(vm)}
            onSendSms={() => handleSendSms(vm)}
            onDelete={() => handleDelete(vm)}
            onToggleUnread={() => handleToggleUnread(vm)}
          />
        ))}
      </ul>
    </div>
  );
}

function VoicemailRow({
  vm,
  retentionDays,
  expanded,
  selectMode,
  checked,
  onToggleSelect,
  onExpand,
  onCallBack,
  onSendSms,
  onDelete,
  onToggleUnread,
}: {
  vm: VoicemailRecord;
  retentionDays: number;
  expanded: boolean;
  selectMode: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  onExpand: () => void;
  onCallBack: () => void;
  onSendSms: () => void;
  onDelete: () => void;
  onToggleUnread: () => void;
}) {
  const jd = useJobDivaContact(vm.fromNumber);
  // Favorite-saved name wins over JobDiva so the user's own label shows. (#161)
  const label = getFavoriteName(vm.fromNumber) ?? jd?.name ?? formatNumber(vm.fromNumber);
  const unread = !vm.listenedAt;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  // Actual duration discovered from the audio file once it loads. The
  // server-stored `durationSeconds` is sometimes 0/1 because Telnyx Hosted
  // Voicemail's webhook payload doesn't always include duration; the audio
  // element itself knows the right answer once metadata loads.
  const [actualDuration, setActualDuration] = useState<number | null>(null);

  // Apply playback rate whenever it changes (and after the audio element mounts).
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate, expanded]);

  // When the row expands, start playback automatically and capture the
  // real duration from the audio element's metadata.
  useEffect(() => {
    if (!expanded || !audioRef.current) return;
    const el = audioRef.current;
    const onLoaded = () => {
      if (isFinite(el.duration) && el.duration > 0) {
        setActualDuration(el.duration);
      }
    };
    el.addEventListener('loadedmetadata', onLoaded);
    // Auto-play on expand so a single click on the row's play button
    // both opens the player AND starts playing.
    el.play().catch(() => { /* autoplay may be blocked; user can press play */ });
    return () => el.removeEventListener('loadedmetadata', onLoaded);
  }, [expanded]);

  // Lightweight pre-fetch of duration for the *collapsed* row too. We hide
  // the audio element off-screen, ask for metadata only, and update state
  // when the duration arrives. No data downloaded beyond the headers.
  useEffect(() => {
    if (!vm.recordingUrl || actualDuration !== null) return;
    const probe = document.createElement('audio');
    probe.preload = 'metadata';
    probe.src = vm.recordingUrl;
    const onLoaded = () => {
      if (isFinite(probe.duration) && probe.duration > 0) {
        setActualDuration(probe.duration);
      }
    };
    probe.addEventListener('loadedmetadata', onLoaded);
    // Cleanup so we don't leak audio elements.
    return () => {
      probe.removeEventListener('loadedmetadata', onLoaded);
      probe.src = '';
    };
  }, [vm.recordingUrl, actualDuration]);

  // Prefer the discovered duration over the (possibly bad) stored one.
  const displaySeconds = actualDuration ?? vm.durationSeconds;

  return (
    <li className={`vm-row${unread ? ' unread' : ''}${expanded ? ' expanded' : ''}${selectMode ? ' select-mode' : ''}${checked ? ' selected' : ''}`}>
      <div
        className="vm-row-main"
        onClick={selectMode ? onToggleSelect : onExpand}
      >
        {selectMode && (
          <span className="vm-checkbox" aria-hidden="true">
            {checked ? <CheckSquare size={18} /> : <Square size={18} />}
          </span>
        )}
        <div className="vm-left">
          {!selectMode && unread && <span className="vm-dot" aria-label="Unread" />}
          <div className="vm-text">
            <div className="vm-number">{label}</div>
            <div className="vm-meta">
              {formatTime(vm.receivedAt)}
              {displaySeconds > 0 && ` · ${formatDuration(Math.round(displaySeconds))}`}
            </div>
            {(() => {
              // Days remaining until server auto-deletes this voicemail.
              // Color-coded: gray > 7 days, amber 2–7, red 0–1.
              const expiresAt =
                new Date(vm.receivedAt).getTime() +
                retentionDays * 24 * 60 * 60 * 1000;
              const msLeft = expiresAt - Date.now();
              const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
              if (daysLeft <= 0) return null;
              const cls =
                daysLeft <= 1
                  ? 'vm-expires danger'
                  : daysLeft <= 7
                    ? 'vm-expires warn'
                    : 'vm-expires';
              const text =
                daysLeft === 1
                  ? 'Auto-deletes tomorrow'
                  : `Auto-deletes in ${daysLeft} days`;
              return <div className={cls}>{text}</div>;
            })()}
          </div>
        </div>
        {!selectMode && (
          <div className="vm-right">
            <button type="button" className="vm-action" aria-label="Play" onClick={(e) => { e.stopPropagation(); onExpand(); }}>
              <Play size={16} />
            </button>
            <button
              type="button"
              className="vm-action"
              aria-label={unread ? 'Mark as read' : 'Mark as unread'}
              title={unread ? 'Mark as read' : 'Mark as unread'}
              onClick={(e) => { e.stopPropagation(); onToggleUnread(); }}
            >
              {unread ? <CheckCircle2 size={16} /> : <Circle size={16} />}
            </button>
            <button type="button" className="vm-action callback" aria-label="Call back" onClick={(e) => { e.stopPropagation(); onCallBack(); }}>
              <Phone size={16} />
            </button>
            <button type="button" className="vm-action" aria-label="Send message" title="Send message" onClick={(e) => { e.stopPropagation(); onSendSms(); }}>
              <MessageSquare size={16} />
            </button>
            <button type="button" className="vm-action delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </div>
      {expanded && !selectMode && (
        <div className="vm-body">
          <audio
            ref={audioRef}
            controls
            src={vm.recordingUrl}
            preload="metadata"
            style={{ width: '100%' }}
          />
          <div className="vm-player-controls">
            <span className="vm-controls-label">Speed</span>
            <div className="vm-rate-group" role="group" aria-label="Playback speed">
              {[0.5, 1, 1.5, 2].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`vm-rate-btn${playbackRate === r ? ' active' : ''}`}
                  onClick={() => setPlaybackRate(r)}
                >
                  {r}×
                </button>
              ))}
            </div>
          </div>
          {vm.transcription ? (
            <p className="vm-transcript">
              <span className="vm-transcript-tag">Transcript</span>
              {vm.transcription}
            </p>
          ) : (
            <p className="vm-transcript vm-transcript-pending">
              <span className="vm-transcript-tag">Transcript</span>
              <em style={{ opacity: 0.7 }}>Transcribing…</em>
            </p>
          )}
        </div>
      )}
    </li>
  );
}
