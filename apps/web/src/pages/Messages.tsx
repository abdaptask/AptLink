// Phase 5.3 — SMS/MMS conversations. iMessage-style two-pane layout:
// thread list on the left (or full screen on narrow), thread detail on the right.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Send, ArrowLeft, RefreshCcw, MessageSquarePlus, Image as ImageIcon, Search, X } from 'lucide-react';
import {
  getThreads,
  getThread,
  sendMessage,
  uploadMedia,
  type ThreadSummary,
  type MessageRecord,
} from '../api';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';

function formatNumber(raw: string): string {
  const d = (raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+1') && d.length === 12) {
    return `(${d.slice(2, 5)}) ${d.slice(5, 8)}-${d.slice(8)}`;
  }
  return d;
}

function formatRelative(iso: string): string {
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

export default function Messages() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [search, setSearch] = useState('');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Open a thread if ?to=+1... was passed (used by InCall Message button).
  useEffect(() => {
    const to = searchParams.get('to');
    if (to) setActive(to);
  }, [searchParams]);

  const loadThreads = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getThreads(token)
      .then(setThreads)
      .catch((e) => setError(e.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // For each thread, which side number is "the other party"?
  const otherParty = (t: ThreadSummary) => t.threadKey;

  // Client-side thread filter: digits, cached JobDiva name, and the
  // last-message preview body.
  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    const qDigits = q.replace(/[^\d]/g, '');
    return threads.filter((t) => {
      const digits = (t.threadKey || '').replace(/[^\d]/g, '');
      if (qDigits && digits.includes(qDigits)) return true;
      if ((t.body ?? '').toLowerCase().includes(q)) return true;
      const cachedName = getCachedJobDivaName(t.threadKey);
      if (cachedName && cachedName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [threads, search]);

  return (
    <div className="messages">
      {!active ? (
        <div className="msg-list">
          <div className="msg-header">
            <h2>Messages</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="icon-btn"
                onClick={() => setShowCompose(true)}
                aria-label="New message"
              >
                <MessageSquarePlus size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={loadThreads}
                disabled={loading}
                aria-label="Refresh"
              >
                <RefreshCcw size={18} className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>

          <div className="search-bar">
            <Search size={16} className="search-icon" aria-hidden="true" />
            <input
              type="search"
              className="search-input"
              placeholder="Search conversations"
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

          {!loading && threads.length === 0 && !error && (
            <div className="empty-state">
              <p>No conversations yet.</p>
              <p className="muted">Tap the compose icon to start one.</p>
            </div>
          )}

          {!loading && threads.length > 0 && filteredThreads.length === 0 && (
            <div className="empty-state">
              <p>No conversations match “{search}”.</p>
            </div>
          )}

          <ul className="thread-list">
            {filteredThreads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                onOpen={() => setActive(otherParty(t))}
              />
            ))}
          </ul>
        </div>
      ) : (
        <ThreadDetail
          number={active}
          onBack={() => {
            setActive(null);
            loadThreads();
          }}
          onCallClick={() => navigate('/keypad')}
        />
      )}

      {showCompose && (
        <div className="compose-modal">
          <div className="compose-box">
            <h3>New message</h3>
            <input
              className="ict-input"
              placeholder="To: +1 555 123 4567"
              value={composeTo}
              onChange={(e) => setComposeTo(e.target.value)}
              autoFocus
            />
            <div className="ict-actions">
              <button className="ict-cancel" onClick={() => { setShowCompose(false); setComposeTo(''); }}>
                Cancel
              </button>
              <button
                className="ict-confirm"
                disabled={!composeTo.trim()}
                onClick={() => {
                  setActive(composeTo.trim());
                  setShowCompose(false);
                  setComposeTo('');
                }}
              >
                Open
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ThreadDetailProps {
  number: string;
  onBack: () => void;
  onCallClick: () => void;
}

function ThreadDetail({ number, onBack }: ThreadDetailProps) {
  const jd = useJobDivaContact(number);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getThread(token, number)
      .then(setMessages)
      .catch((e) => setError(e.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [number]);

  useEffect(() => {
    load();
    // Soft poll every 8s so inbound replies show up without refresh.
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    // Auto-scroll to the bottom on new messages.
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSend = async () => {
    if (!draft.trim() && attached.length === 0) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSending(true);
    try {
      const saved = await sendMessage(token, {
        to: number,
        body: draft.trim() || undefined,
        mediaUrls: attached.length > 0 ? attached : undefined,
      });
      setMessages((m) => [...m, saved]);
      setDraft('');
      setAttached([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleAttach = () => {
    fileRef.current?.click();
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be picked again
    if (!file) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setUploading(true);
    try {
      const { url } = await uploadMedia(token, file);
      setAttached((a) => [...a, url]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="thread-detail">
      <div className="thread-header">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="thread-header-name">{jd?.name ?? formatNumber(number)}</div>
        <div style={{ width: 28 }} />
      </div>

      {error && <div className="error" style={{ margin: '0 1rem' }}>{error}</div>}

      <div className="msg-stream" ref={scrollRef}>
        {loading && messages.length === 0 && <div className="muted">Loading…</div>}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`bubble ${m.direction === 'outbound' ? 'out' : 'in'}`}
          >
            {m.body && <div className="bubble-text">{m.body}</div>}
            {m.mediaUrls?.length > 0 && (
              <div className="bubble-media">
                {m.mediaUrls.map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noreferrer">
                    <img src={u} alt="attachment" />
                  </a>
                ))}
              </div>
            )}
            <div className="bubble-meta">
              {formatRelative(m.createdAt)}
              {m.direction === 'outbound' && (
                <span className="bubble-status"> · {m.status}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <input
        type="file"
        accept="image/*"
        ref={fileRef}
        onChange={handleFile}
        style={{ display: 'none' }}
      />
      <div className="compose-row">
        <button
          type="button"
          className="icon-btn"
          onClick={handleAttach}
          disabled={uploading}
          aria-label="Attach image"
        >
          <ImageIcon size={20} />
        </button>
        <input
          className="compose-input"
          placeholder="Text message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        {uploading && <span className="muted" style={{ fontSize: 12 }}>uploading…</span>}
        {attached.length > 0 && (
          <span className="attach-pill" title={attached.join('\n')}>
            📎 {attached.length}
          </span>
        )}
        <button
          type="button"
          className="send-btn"
          onClick={handleSend}
          disabled={sending || (!draft.trim() && attached.length === 0)}
          aria-label="Send"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: ThreadSummary;
  onOpen: () => void;
}) {
  const jd = useJobDivaContact(thread.threadKey);
  const label = jd?.name ?? formatNumber(thread.threadKey);
  return (
    <li className="thread-row" onClick={onOpen}>
      <div className="thread-text">
        <div className="thread-name">{label}</div>
        <div className="thread-preview">
          {thread.direction === 'outbound' ? 'You: ' : ''}
          {thread.body || (thread.mediaUrls?.length ? '\u{1F4CE} attachment' : '')}
        </div>
      </div>
      <div className="thread-time">{formatRelative(thread.createdAt)}</div>
    </li>
  );
}
