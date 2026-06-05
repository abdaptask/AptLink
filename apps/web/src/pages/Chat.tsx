// Internal Chat — dialer-user ↔ dialer-user messaging.
//
// Distinct from Messages (which sends SMS to external phone numbers via
// Telnyx). Internal Chat lives entirely in our DB and is intended for short
// notes between teammates ("hop on Acme line", "did you call back X?").
//
// We deliberately mirror Messages.tsx's layout structure so we inherit the
// existing CSS (.messages root, .msg-list pane, .thread-list + .thread-row,
// .thread-detail, .thread-header, .bubble.in/.bubble.out, .compose-row,
// .compose-input, .send-btn). That gives us dark/light theme support for
// free. Only a few extra avatar classes are added to styles.css.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send, ArrowLeft, RefreshCcw, Search, X, Users, MessageCircle } from 'lucide-react';
import {
  getInternalChatThreads,
  getInternalChatThread,
  getInternalChatUsers,
  sendInternalChatMessage,
  markInternalChatThreadRead,
  type InternalChatThread,
  type InternalChatMessage,
  type InternalChatUser,
  type ChatPresence,
  getMe,
} from '../api';

// v0.9.15 — presence display + sort order.
// Order: on_call (red) > active (green) > recent (yellow) > idle (grey).
// The user explicitly asked for status-sorted teammates.
const PRESENCE_ORDER: Record<ChatPresence, number> = {
  on_call: 0,
  active: 1,
  recent: 2,
  idle: 3,
};
const PRESENCE_LABEL: Record<ChatPresence, string> = {
  on_call: 'On call',
  active: 'Online',
  recent: 'Away',
  idle: 'Offline',
};
// CSS class names — defined in styles.css. Map presence → dot color class.
const PRESENCE_DOT_CLASS: Record<ChatPresence, string> = {
  on_call: 'presence-dot-oncall',
  active: 'presence-dot-online',
  recent: 'presence-dot-away',
  idle: 'presence-dot-offline',
};
const ALL_PRESENCE: ChatPresence[] = ['on_call', 'active', 'recent', 'idle'];

function displayName(u: InternalChatUser | null | undefined): string {
  if (!u) return 'Unknown user';
  const first = u.firstName ?? '';
  const last = u.lastName ?? '';
  const full = `${first} ${last}`.trim();
  return full || u.email;
}

function initials(u: InternalChatUser | null | undefined): string {
  if (!u) return '?';
  if (u.firstName) {
    return ((u.firstName[0] ?? '') + (u.lastName?.[0] ?? '')).toUpperCase() || 'U';
  }
  return (u.email[0] ?? 'U').toUpperCase();
}

// Deterministic per-user hue so avatar colors are consistent across renders.
function userHue(u: InternalChatUser | null | undefined): number {
  if (!u) return 0;
  const key = (u.email ?? '') + (u.firstName ?? '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function avatarStyle(u: InternalChatUser | null | undefined) {
  const h = userHue(u);
  return {
    background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 30) % 360} 70% 45%))`,
  };
}

function formatRelative(iso: string): string {
  // v0.10.55 — Include time-of-day on every label. See Recents.tsx.
  // v0.10.60 — Invalid-date guard.
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
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
  return `${date.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}, ${timeStr}`;
}

// ─── Thread detail (inner conversation) ──────────────────────────────
interface ThreadDetailProps {
  meId: number | null;
  other: InternalChatUser | null;
  otherId: number;
  onBack: () => void;
  onSent: () => void;
}

function ThreadDetail({ meId, other, otherId, onBack, onSent }: ThreadDetailProps) {
  const [messages, setMessages] = useState<InternalChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getInternalChatThread(token, otherId)
      .then((rows) => {
        setMessages(rows);
        // Mark as read after a successful load so the badge clears.
        void markInternalChatThreadRead(token, otherId).then(() => {
          window.dispatchEvent(new Event('ace:tabVisited'));
          onSent();
        });
      })
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [otherId, onSent]);

  // Initial load + 6s polling for new messages while this thread is open.
  useEffect(() => {
    load();
    const id = window.setInterval(load, 6000);
    return () => window.clearInterval(id);
  }, [load]);

  // Stick scroll to bottom whenever the message list grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
  }, [messages.length]);

  const handleSend = async () => {
    const body = draft.trim();
    if (!body) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSending(true);
    try {
      const saved = await sendInternalChatMessage(token, otherId, body);
      // Optimistic append so the bubble lands instantly.
      setMessages((prev) => [...prev, saved]);
      setDraft('');
      onSent();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="thread-detail">
      <div className="thread-header">
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back"
          style={{ marginRight: 4 }}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="chat-avatar-wrap small">
          <span className="chat-avatar small" style={avatarStyle(other)}>
            {initials(other)}
          </span>
          {other?.presence && (
            <span
              className={`presence-dot presence-dot-overlay ${PRESENCE_DOT_CLASS[other.presence]}`}
              aria-hidden="true"
              title={PRESENCE_LABEL[other.presence]}
            />
          )}
        </span>
        <div>
          <div className="thread-header-name">{displayName(other)}</div>
          <div className="thread-header-sub">
            {other?.presence && (
              <span className="thread-header-presence">
                {PRESENCE_LABEL[other.presence]}
              </span>
            )}
            {other?.presence && other?.email && (
              <span className="thread-header-presence-sep" aria-hidden="true">
                {' · '}
              </span>
            )}
            {other?.email}
          </div>
        </div>
      </div>

      <div className="msg-list chat-bubble-scroll" ref={scrollRef}>
        {loading && messages.length === 0 && (
          <div className="empty-state muted">Loading…</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="empty-state muted">No messages yet — say hi 👋</div>
        )}
        {messages.map((m) => {
          const mine = m.senderId === meId;
          return (
            <div key={m.id} className={`bubble ${mine ? 'out' : 'in'}`}>
              <div className="bubble-text">{m.body}</div>
              <div className="bubble-meta">{formatRelative(m.createdAt)}</div>
            </div>
          );
        })}
        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      <div className="compose-row">
        <textarea
          className="compose-input"
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter for newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={1}
        />
        <button
          type="button"
          className="send-btn"
          disabled={sending || !draft.trim()}
          onClick={() => void handleSend()}
          aria-label="Send"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Top-level page ──────────────────────────────────────────────────
export default function Chat() {
  const [searchParams] = useSearchParams();
  const [meId, setMeId] = useState<number | null>(null);
  const [threads, setThreads] = useState<InternalChatThread[]>([]);
  const [users, setUsers] = useState<InternalChatUser[]>([]);
  const [active, setActive] = useState<{ id: number; user: InternalChatUser | null } | null>(null);

  // v0.10.13 — When entry is via `/chat?with=<userId>` (from the unified
  // Messages list), auto-open that user's chat thread instead of showing
  // the index list. We watch searchParams + the loaded users list so the
  // auto-open fires once users have arrived.
  useEffect(() => {
    const withId = searchParams.get('with');
    if (!withId) return;
    const id = Number(withId);
    if (!Number.isFinite(id)) return;
    if (active && active.id === id) return; // already open
    const user = users.find((u) => u.id === id) ?? null;
    setActive({ id, user });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, users]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUserPicker, setShowUserPicker] = useState(false);
  const [search, setSearch] = useState('');
  // v0.9.15 — collapsible sections by presence. Empty Set = all expanded
  // (the default the user sees on first open). Members of this set are
  // currently collapsed.
  const [collapsedSections, setCollapsedSections] = useState<Set<ChatPresence>>(new Set());
  const toggleSection = (p: ChatPresence) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getMe(token).then((u) => setMeId(u.id)).catch(() => { /* noop */ });
  }, []);

  const loadThreads = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    getInternalChatThreads(token)
      .then(setThreads)
      .catch((e) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const loadUsers = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getInternalChatUsers(token).then(setUsers).catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    loadThreads();
    loadUsers();
    // Soft poll while the threads pane is up.
    // v0.9.15 — also re-fetch users on each tick so presence stays fresh
    // (otherwise a teammate would stay "Online" until next page reload
    // even if they went idle 30 min ago).
    const id = window.setInterval(() => {
      loadThreads();
      loadUsers();
    }, 15000);
    return () => window.clearInterval(id);
  }, [loadThreads, loadUsers]);

  // v0.9.15 — group filtered users by presence so the picker can render
  // collapsible Slack-style sections (On call / Online / Away / Offline).
  // Alphabetical within each section.
  const groupedUsers = useMemo(() => {
    const groups: Record<ChatPresence, InternalChatUser[]> = {
      on_call: [], active: [], recent: [], idle: [],
    };
    for (const u of users) {
      // Filter by search before grouping so an empty section disappears.
      if (search.trim()) {
        const q = search.toLowerCase();
        const name = displayName(u).toLowerCase();
        if (!name.includes(q) && !u.email.toLowerCase().includes(q)) continue;
      }
      const p = u.presence ?? 'idle';
      groups[p].push(u);
    }
    for (const key of ALL_PRESENCE) {
      groups[key].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    }
    return groups;
  }, [users, search]);

  // v0.9.15 — quick lookup of presence by user id so the threads list
  // can show a status dot on each chat's avatar without a second fetch.
  const presenceByUserId = useMemo(() => {
    const m = new Map<number, ChatPresence>();
    for (const u of users) {
      m.set(u.id, u.presence ?? 'idle');
    }
    return m;
  }, [users]);

  const filteredThreads = useMemo(() => {
    if (!search.trim()) return threads;
    const q = search.toLowerCase();
    return threads.filter((t) => {
      const name = displayName(t.otherUser).toLowerCase();
      const email = (t.otherUser?.email ?? '').toLowerCase();
      const last = (t.lastMessage ?? '').toLowerCase();
      return name.includes(q) || email.includes(q) || last.includes(q);
    });
  }, [threads, search]);

  // v0.9.15 — filteredUsers removed; user-picker now uses groupedUsers
  // which does its own per-section search filtering inline.

  return (
    <div className="messages">
      {!active ? (
        <div className="msg-list">
          <div className="msg-header">
            <h2>Chat</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className={`icon-btn${showUserPicker ? ' active' : ''}`}
                onClick={() => setShowUserPicker((v) => !v)}
                aria-label="New chat"
                title={showUserPicker ? 'Back to chats' : 'Start new chat'}
              >
                <Users size={18} />
              </button>
              <button
                type="button"
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
              placeholder={showUserPicker ? 'Search teammates' : 'Search chats'}
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

          {showUserPicker ? (
            <ul className="thread-list chat-teammates-list">
              {ALL_PRESENCE.every((p) => groupedUsers[p].length === 0) && (
                <li className="empty-state muted">No teammates found.</li>
              )}
              {ALL_PRESENCE.map((p) => {
                const list = groupedUsers[p];
                if (list.length === 0) return null;
                const collapsed = collapsedSections.has(p);
                return (
                  <li key={p} className="presence-section">
                    <button
                      type="button"
                      className="presence-section-header"
                      onClick={() => toggleSection(p)}
                      aria-expanded={!collapsed}
                    >
                      <span
                        className={`presence-dot ${PRESENCE_DOT_CLASS[p]}`}
                        aria-hidden="true"
                      />
                      <span className="presence-section-label">
                        {PRESENCE_LABEL[p]}
                      </span>
                      <span className="presence-section-count">
                        {list.length}
                      </span>
                      <span
                        className={`presence-section-caret${collapsed ? ' collapsed' : ''}`}
                        aria-hidden="true"
                      >
                        ▾
                      </span>
                    </button>
                    {!collapsed && (
                      <ul className="presence-section-list">
                        {list.map((u) => (
                          <li key={u.id}>
                            <button
                              type="button"
                              className="thread-row"
                              onClick={() => {
                                setShowUserPicker(false);
                                setSearch('');
                                setActive({ id: u.id, user: u });
                              }}
                            >
                              <span className="chat-avatar-wrap">
                                <span
                                  className="chat-avatar"
                                  style={avatarStyle(u)}
                                >
                                  {initials(u)}
                                </span>
                                <span
                                  className={`presence-dot presence-dot-overlay ${PRESENCE_DOT_CLASS[p]}`}
                                  aria-hidden="true"
                                  title={PRESENCE_LABEL[p]}
                                />
                              </span>
                              <div className="thread-text">
                                <div className="thread-name">{displayName(u)}</div>
                                <div className="thread-preview">{u.email}</div>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              {!loading && threads.length === 0 && !error && (
                <div className="empty-state">
                  <MessageCircle size={36} strokeWidth={1.2} style={{ opacity: 0.4 }} />
                  <p>No chats yet.</p>
                  <p className="muted">Tap the Users icon to start one.</p>
                </div>
              )}

              {!loading && threads.length > 0 && filteredThreads.length === 0 && (
                <div className="empty-state">
                  <p>No chats match “{search}”.</p>
                </div>
              )}

              <ul className="thread-list">
                {filteredThreads
                  // v0.9.15 — sort chats by other-party presence so the
                  // ones you can actually reach right now float to the top.
                  // Within the same presence group, newest activity first.
                  .slice()
                  .sort((a, b) => {
                    const pa = presenceByUserId.get(a.otherId) ?? 'idle';
                    const pb = presenceByUserId.get(b.otherId) ?? 'idle';
                    const orderDiff =
                      PRESENCE_ORDER[pa] - PRESENCE_ORDER[pb];
                    if (orderDiff !== 0) return orderDiff;
                    return b.lastAt.localeCompare(a.lastAt);
                  })
                  .map((t) => {
                    const isUnread = t.unreadCount > 0;
                    const otherPresence =
                      presenceByUserId.get(t.otherId) ?? 'idle';
                    return (
                      <li key={t.otherId}>
                        <button
                          type="button"
                          className={`thread-row${isUnread ? ' unread' : ''}`}
                          onClick={() => setActive({ id: t.otherId, user: t.otherUser })}
                        >
                          <span className="chat-avatar-wrap">
                            <span
                              className="chat-avatar"
                              style={avatarStyle(t.otherUser)}
                            >
                              {initials(t.otherUser)}
                            </span>
                            <span
                              className={`presence-dot presence-dot-overlay ${PRESENCE_DOT_CLASS[otherPresence]}`}
                              aria-hidden="true"
                              title={PRESENCE_LABEL[otherPresence]}
                            />
                          </span>
                          <div className="thread-text">
                            <div className="thread-name">{displayName(t.otherUser)}</div>
                            <div className="thread-preview">
                              {t.lastSenderId === meId ? 'You: ' : ''}
                              {t.lastMessage || (t.mediaUrl ? '📎 attachment' : '…')}
                            </div>
                          </div>
                          <div className="thread-time">{formatRelative(t.lastAt)}</div>
                          {isUnread && <span className="thread-unread-dot" aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </>
          )}
        </div>
      ) : (
        <ThreadDetail
          meId={meId}
          other={active.user}
          otherId={active.id}
          onBack={() => {
            setActive(null);
            loadThreads();
          }}
          onSent={loadThreads}
        />
      )}
    </div>
  );
}
