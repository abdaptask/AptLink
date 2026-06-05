// Phase 5.3 — SMS/MMS conversations. iMessage-style two-pane layout:
// thread list on the left (or full screen on narrow), thread detail on the right.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Send, ArrowLeft, RefreshCcw, MessageSquarePlus, Image as ImageIcon, Search, X, Zap, Phone, History, Star, Ban, Smile, FileText, Clock, Trash2, Pencil } from 'lucide-react';
import {
  getThreads,
  getThread,
  sendMessage,
  uploadMedia,
  getContactHistory,
  addBlockedNumber,
  // v0.10.13 — pull in the internal chat thread API so the unified
  // Messages tab can list teammate conversations alongside SMS threads.
  getInternalChatThreads,
  // v0.10.26 — server-side mark-as-read for SMS threads.
  markThreadRead,
  markThreadUnread,
  type ThreadSummary,
  type MessageRecord,
  type ContactHistory,
  type ContactTimelineEntry,
  type InternalChatThread,
  // v0.10.52 — Tenant SMS templates picker.
  listMySmsTemplates,
  type SmsTemplate,
  // v0.10.54 — Used to resolve {recruiter} placeholder to the user's
  // first name when picking a template.
  getMe,
  // v0.10.59 — Scheduled SMS.
  listMyScheduledMessages,
  createScheduledMessage,
  updateScheduledMessage,
  cancelScheduledMessage,
  type ScheduledMessage,
  // v0.10.72 — Custom error class so we can extract Telnyx codes.
  SendMessageError,
} from '../api';
import { telnyxErrorBlurb } from '../lib/telnyxErrorBlurb';
import { useJobDivaContact, getCachedJobDivaName } from '../hooks/useJobDivaContact';
import { useSip } from '../contexts/SipContext';
import {
  getQuickReplies,
  isFavorite,
  addFavorite,
  removeFavorite,
  getFavoriteName,
  getThreadLastVisit,
  markThreadVisited,
} from '../lib/userPrefs';
import { formatPhone } from '../lib/phone';
import LineBadge from '../components/LineBadge';

function formatNumber(raw: string): string {
  return formatPhone(raw);
}

// v0.10.29 — Curated emoji set for the SMS compose picker. Frequently-used
// faces + reactions + symbols. Avoids skin-tone variations to keep the grid
// compact and accessible. Two rows × 12 = 24 emojis fits well.
const EMOJI_OPTIONS = [
  '😀', '😂', '🙂', '😉', '😎', '🥲', '😊', '🤔', '😴', '🙄', '😅', '😭',
  '👍', '👎', '👌', '🙏', '👏', '🙌', '✌️', '🤝', '🔥', '🎉', '✅', '❌',
];

function formatRelative(iso: string): string {
  // v0.10.55 — Always include time-of-day so users can scan when each SMS
  // landed, not just which day. See Recents.tsx for full rationale.
  // v0.10.60 — Guard against invalid Date. Prevents "Invalid Date, Invalid
  // Date" on bubbles whose createdAt is missing/malformed (regression seen
  // after the v0.10.59 sendMessage helper refactor narrowed its select).
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

// v0.10.59 — "Will fire at..." labels for scheduled messages.
// More verbose than formatRelative: caller wants to see WHEN it goes out,
// not when it was created. Same time-of-day on every label.
function formatScheduledFor(iso: string): string {
  // v0.10.60 — Invalid-date guard. Same defensive pattern as formatRelative.
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `today, ${timeStr}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();
  if (isTomorrow) return `tomorrow, ${timeStr}`;
  return `${date.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })}, ${timeStr}`;
}

// v0.10.59 — Convert a Date to the "yyyy-MM-ddTHH:mm" format that the
// HTML <input type="datetime-local"> control expects/produces. Pad each
// component to keep the parser happy.
function toLocalDatetimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// v0.10.13 — Discriminated row type for the unified list. SMS rows
// come from the SMS messages table; chat rows come from internal-chat.
// We merge both into one sorted list in the Messages view.
type UnifiedRow =
  | { kind: 'sms'; sms: ThreadSummary; lastAt: string; preview: string }
  | { kind: 'chat'; chat: InternalChatThread; lastAt: string; preview: string };

export default function Messages() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  // v0.10.13 — internal chat threads merged into the same list.
  const [chatThreads, setChatThreads] = useState<InternalChatThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [search, setSearch] = useState('');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Re-render thread rows when the user adds/removes a favorite so the
  // friendly name on the thread row updates immediately. (#161)
  const [, setFavTick] = useState(0);
  useEffect(() => {
    const refresh = () => setFavTick((t) => t + 1);
    window.addEventListener('ace:favoritesChanged', refresh);
    return () => window.removeEventListener('ace:favoritesChanged', refresh);
  }, []);

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
    // v0.10.13 — fetch SMS + internal chat in parallel, render both as
    // one unified list. Either source can fail independently; we only
    // surface a hard error if BOTH fail.
    Promise.allSettled([
      getThreads(token),
      getInternalChatThreads(token),
    ])
      .then(([smsRes, chatRes]) => {
        if (smsRes.status === 'fulfilled') setThreads(smsRes.value);
        else setThreads([]);
        if (chatRes.status === 'fulfilled') setChatThreads(chatRes.value);
        else setChatThreads([]);
        if (smsRes.status === 'rejected' && chatRes.status === 'rejected') {
          setError('Failed to load conversations');
        }
      })
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
      // Match against the favorite name too, so searching "Adam" finds a
      // thread saved as a favorite even before JobDiva resolves. (#161)
      const favName = getFavoriteName(t.threadKey);
      if (favName && favName.toLowerCase().includes(q)) return true;
      const cachedName = getCachedJobDivaName(t.threadKey);
      if (cachedName && cachedName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [threads, search]);

  // v0.10.13 — Unified list: SMS threads + internal chat threads merged
  // and sorted by most-recent activity. Each row carries a 'kind'
  // discriminator so the row renderer can show the right avatar + label
  // and clicks route to the right detail view.
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const smsRows: UnifiedRow[] = filteredThreads.map((sms) => ({
      kind: 'sms' as const,
      sms,
      lastAt: sms.createdAt,
      preview: sms.body ?? '',
    }));
    const q = search.trim().toLowerCase();
    const chatFiltered = chatThreads.filter((c) => {
      if (!q) return true;
      const name = c.otherUser
        ? `${c.otherUser.firstName ?? ''} ${c.otherUser.lastName ?? ''} ${c.otherUser.email ?? ''}`.toLowerCase()
        : '';
      if (name.includes(q)) return true;
      if ((c.lastMessage ?? '').toLowerCase().includes(q)) return true;
      return false;
    });
    const chatRows: UnifiedRow[] = chatFiltered.map((chat) => ({
      kind: 'chat' as const,
      chat,
      lastAt: chat.lastAt,
      preview: chat.lastMessage ?? '',
    }));
    // Merge + sort by lastAt descending (newest first).
    return [...smsRows, ...chatRows].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [filteredThreads, chatThreads, search]);

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

          {!loading && (threads.length + chatThreads.length) > 0 && unifiedRows.length === 0 && (
            <div className="empty-state">
              <p>No conversations match “{search}”.</p>
            </div>
          )}

          <ul className="thread-list">
            {unifiedRows.map((row) => {
              if (row.kind === 'sms') {
                return (
                  <ThreadRow
                    key={`sms-${row.sms.id}`}
                    thread={row.sms}
                    onOpen={() => setActive(otherParty(row.sms))}
                  />
                );
              }
              // v0.10.13 — chat row. Renders with same .thread-row styling
              // but uses the teammate's initials + name. Click navigates
              // to /chat (Chat page handles the detail view since it
              // already has presence, typing indicators, etc. wired up).
              return (
                <ChatRowInList
                  key={`chat-${row.chat.otherId}`}
                  chat={row.chat}
                  onOpen={() => navigate(`/chat?with=${row.chat.otherId}`)}
                />
              );
            })}
          </ul>
        </div>
      ) : (
        <ThreadDetail
          number={active}
          onBack={() => {
            setActive(null);
            loadThreads();
          }}
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
}

function ThreadDetail({ number, onBack }: ThreadDetailProps) {
  const jd = useJobDivaContact(number);
  const navigate = useNavigate();
  const { sipState, call } = useSip();
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  // Resolve the display name with the favorites lookup taking precedence
  // over JobDiva, so a user-chosen friendly name always wins. (#161)
  const favName = getFavoriteName(number);
  const displayName = favName ?? jd?.name ?? formatNumber(number);
  // Has the user already blocked this number? Hides the Block button
  // and shows a small "Blocked" badge instead. (#159)
  const [blocked, setBlocked] = useState(false);

  // Mark this thread as visited so the unread dot disappears from the
  // threads list. Fires on mount and on every poll (so if a new inbound
  // arrives while the thread is open, it's instantly "read").
  //
  // v0.10.26 — Also call markThreadRead on the server. Old localStorage-
  // only `markThreadVisited` is kept for instant local UI feedback (no
  // network round-trip needed before the dot disappears), but the
  // authoritative state now lives in DB via Message.readAt.
  useEffect(() => {
    if (!number) return;
    markThreadVisited(number);
    const token = sessionStorage.getItem('ace_token');
    if (token) {
      void markThreadRead(token, number)
        .then(() => {
          // v0.10.67 — Refresh the Layout badge counter immediately.
          // Without this, opening a thread marks it read server-side but
          // the bottom-nav "Messages" badge stays at the old count for
          // up to 15 seconds (the next badge-poll tick).
          window.dispatchEvent(new CustomEvent('ace:unreadCountChanged'));
        })
        .catch((e) => {
          console.warn('[messages] markThreadRead failed', e);
        });
    }
  }, [number, messages.length]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Quick replies (user-editable in Settings). Re-read on the custom event
  // so edits in Settings show up immediately without a page reload.
  const [quickReplies, setLocalQuickReplies] = useState<string[]>(() => getQuickReplies());
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  // v0.10.29 — Emoji picker open/close + ref to the compose textarea so
  // we can insert at the cursor position.
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  // v0.10.52 — SMS templates picker. Loaded once when the thread opens;
  // the picker popover shows all active tenant templates grouped by
  // category. Clicking one inserts the body at caret position, with
  // {firstName} pre-filled from the contact (if known).
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  // v0.10.54 — Logged-in user's first name. Resolves {recruiter} in
  // templates so it shows up as "Hi Jean, this is Abdulla from..." rather
  // than literal "{recruiter}". Falls back to empty string until the
  // /me call resolves (template still works; recruiter just shows blank
  // for the first render after picking).
  const [recruiterFirstName, setRecruiterFirstName] = useState<string>('');

  // v0.10.59 — Scheduled-message state for this thread.
  // pendingSchedules: list of un-sent (status='pending') rows for this contact
  //                   so we can show a banner at the top of the thread.
  // showScheduleModal: opens the schedule-picker. Either null (create new)
  //                    or a ScheduledMessage row (edit existing).
  const [pendingSchedules, setPendingSchedules] = useState<ScheduledMessage[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState<
    | null
    | { mode: 'create' }
    | { mode: 'edit'; row: ScheduledMessage }
  >(null);

  // v0.10.54 — Auto-grow the compose textarea so the whole drafted
  // message is visible without scrolling. Previously rows=1 was hard-
  // coded, so picking a long template (e.g. cold outreach) clipped to
  // ~28 chars and the user had to scroll to verify what they were sending.
  // Cap at ~9 lines (200px) so the textarea doesn't dominate the screen
  // for very long drafts; at that point the user has clear scroll affordance.
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    listMySmsTemplates(token)
      .then((items) => setTemplates(items))
      .catch(() => undefined);
    getMe(token)
      .then((u) => {
        const first = (u.firstName ?? '').trim();
        if (first) setRecruiterFirstName(first);
      })
      .catch(() => undefined);
  }, []);

  // v0.10.59 — Load pending scheduled messages for THIS thread on mount and
  // whenever a new one is created/edited/canceled. Cheap query (server caps
  // at 200) so we just refetch instead of locally mutating.
  const loadPendingSchedules = useCallback(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token || !number) return;
    listMyScheduledMessages(token, { status: 'pending', threadKey: number })
      .then((rows) => setPendingSchedules(rows))
      .catch(() => undefined);
  }, [number]);
  useEffect(() => {
    loadPendingSchedules();
  }, [loadPendingSchedules]);

  const composeInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const refresh = () => setLocalQuickReplies(getQuickReplies());
    window.addEventListener('ace:quickRepliesChanged', refresh);
    return () => window.removeEventListener('ace:quickRepliesChanged', refresh);
  }, []);

  // v0.10.54 — Auto-resize the compose textarea to fit its content.
  // Fires every time `draft` changes (typing, paste, template insert,
  // emoji insert). The textarea grows to fit content up to ~9 visible
  // lines (200px); beyond that it scrolls internally. When draft empties
  // (after sending), it shrinks back to 1 line.
  useEffect(() => {
    const el = composeInputRef.current;
    if (!el) return;
    // Reset to a small height first so scrollHeight reflects the *content*
    // height, not the previous (larger) box height.
    el.style.height = 'auto';
    const maxHeightPx = 200;
    const next = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden';
  }, [draft]);

  // Unified per-contact history (messages + calls + voicemails).
  const [history, setHistory] = useState<ContactHistory | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token || !number) return;
    let cancelled = false;
    getContactHistory(token, number)
      .then((h) => { if (!cancelled) setHistory(h); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [number]);

  function handleCall() {
    if (!number) return;
    if (sipState !== 'registered') {
      alert(`SIP not ready (${sipState}). Try again in a moment.`);
      return;
    }
    call(number);
    navigate('/in-call');
  }

  // Block this contact. Confirms first, calls the backend, then sets local
  // state so the header swaps to a "Blocked" badge until the user reloads.
  // The block is fully managed in Settings → Blocked numbers. (#159)
  async function handleBlock() {
    if (!number) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const friendly = favName ?? jd?.name ?? formatNumber(number);
    if (
      !confirm(
        `Block ${friendly}?\n\nThey won't be able to call or text you. ` +
          'You can unblock them later in Settings → Blocked numbers.',
      )
    ) {
      return;
    }
    try {
      await addBlockedNumber(token, { number, reason: 'Blocked from thread header' });
      setBlocked(true);
    } catch (e) {
      alert(`Could not block: ${(e as Error).message}`);
    }
  }

  // Favorite state for this thread's contact.
  const [favorited, setFavorited] = useState<boolean>(() => isFavorite(number));
  useEffect(() => { setFavorited(isFavorite(number)); }, [number]);
  // Same Add-to-Favorites modal flow as the Recents page: prompt for first
  // and last name when adding (so the favorite carries a friendly label),
  // unfavorite silently when removing.
  const [favModal, setFavModal] = useState<
    | null
    | { firstName: string; lastName: string }
  >(null);
  function handleToggleFav() {
    if (favorited) {
      removeFavorite(number);
      setFavorited(false);
      return;
    }
    // Seed first/last from cached JobDiva name like "First Last".
    const cached = jd?.name ?? '';
    const parts = cached.trim().split(/\s+/);
    setFavModal({
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
    });
  }
  function saveFavFromModal() {
    if (!favModal) return;
    addFavorite(number, {
      firstName: favModal.firstName.trim() || null,
      lastName: favModal.lastName.trim() || null,
    });
    setFavorited(true);
    setFavModal(null);
  }

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

  // Auto-scroll to the bottom whenever the message list changes. We jump
  // immediately (so text-only threads land at the bottom on open), then
  // schedule a second jump on the next frame and again after 300ms to
  // catch images that haven't measured yet. ResizeObserver gives us a final
  // safety net for any late layout shifts (e.g. async MMS thumbnail loads).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stickToBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    stickToBottom();
    const raf = requestAnimationFrame(stickToBottom);
    const t = window.setTimeout(stickToBottom, 300);
    const ro = new ResizeObserver(stickToBottom);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      ro.disconnect();
    };
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
      // v0.10.72 — Translate Telnyx error codes to friendly blurbs.
      // SendMessageError carries the raw Telnyx error envelope as .details;
      // telnyxErrorBlurb digs out the code (e.g. 30007) and returns a
      // short human explanation. Generic Error falls back to .message.
      if (e instanceof SendMessageError) {
        const blurb = telnyxErrorBlurb(e.details ?? e.code);
        setError(`${blurb.short}. ${blurb.detail}`);
      } else {
        setError((e as Error).message);
      }
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

  // v0.10.55 — Paste-to-attach for MMS.
  // When the user copies an image (screenshot, Snipping Tool, drag from
  // browser, etc.) and pastes into the compose box, intercept the paste,
  // upload each image item via the same uploadMedia flow the file-picker
  // uses, and append to the attached list. Non-image clipboard content
  // (plain text, formatted text) falls through to default browser paste
  // behavior so typing "Ctrl+V some pasted text" still works.
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return; // not an image paste — let default fire
    e.preventDefault();
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setUploading(true);
    try {
      for (const file of imageFiles) {
        // Some browsers give pasted images a name of "image.png" without an
        // extension at all; uploadMedia + the API are tolerant of that.
        const { url } = await uploadMedia(token, file);
        setAttached((a) => [...a, url]);
      }
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
        <div className="thread-header-name">
          {/* v0.10.30 — Reorganized for clarity. Contact name on top with
              their phone number directly below; "Your line:" pill below
              that so users can tell at a glance which is theirs vs the
              contact's. Previously the line pill was sandwiched between
              the name and contact number, which looked like it belonged
              to the contact. */}
          <span className="thread-header-contact">
            <span className="thread-header-contact-name">{displayName}</span>
            {displayName !== formatNumber(number) && (
              <span className="thread-header-sub">{formatNumber(number)}</span>
            )}
          </span>
          {(() => {
            const lastWithDid = [...messages].reverse().find((m) => m.userDid);
            if (!lastWithDid?.userDid) return null;
            return (
              <span className="thread-header-your-line">
                <span className="thread-header-your-line-label">Your line:</span>
                <LineBadge userDid={lastWithDid.userDid} variant="header" />
              </span>
            );
          })()}
        </div>
        {blocked && (
          <span
            className="thread-blocked-badge"
            title="You blocked this number. Manage in Settings → Blocked numbers."
          >
            <Ban size={14} /> Blocked
          </span>
        )}
        <button
          className={`icon-btn thread-fav-btn ${favorited ? 'active' : ''}`}
          onClick={handleToggleFav}
          aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          title={favorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star size={18} fill={favorited ? 'currentColor' : 'none'} />
        </button>
        {!blocked && (
          <button
            className="icon-btn thread-block-btn"
            onClick={handleBlock}
            aria-label="Block this number"
            title="Block this number"
          >
            <Ban size={18} />
          </button>
        )}
        <button
          className="icon-btn thread-call-btn"
          onClick={handleCall}
          aria-label="Call this number"
          title="Call"
          disabled={sipState !== 'registered'}
        >
          <Phone size={18} />
        </button>
      </div>

      {favModal && (
        <div className="compose-modal" onClick={() => setFavModal(null)}>
          <div
            className="fav-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="fav-modal-title-msg"
          >
            <div className="fav-modal-header">
              <Star size={18} fill="currentColor" className="fav-modal-icon" />
              <h3 id="fav-modal-title-msg">Add to favorites</h3>
            </div>
            <div className="fav-modal-phone">
              {formatPhone(number) || number}
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); saveFavFromModal(); }}
              autoComplete="off"
            >
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
                    value={favModal.firstName}
                    onChange={(e) =>
                      setFavModal({ ...favModal, firstName: e.target.value })
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
                    value={favModal.lastName}
                    onChange={(e) =>
                      setFavModal({ ...favModal, lastName: e.target.value })
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
                  onClick={() => setFavModal(null)}
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

      {history && (history.summary.callCount > 0 || history.summary.voicemailCount > 0 || history.summary.messageCount > 0) && (
        <button
          type="button"
          className="thread-history-bar"
          onClick={() => setShowHistory(true)}
          title="See full interaction history"
        >
          <History size={14} />
          <span className="thread-history-counts">
            {history.summary.messageCount > 0 && (
              <span><strong>{history.summary.messageCount}</strong>{' '}
                {history.summary.messageCount === 1 ? 'message' : 'messages'}
              </span>
            )}
            {history.summary.callCount > 0 && (
              <span><strong>{history.summary.callCount}</strong>{' '}
                {history.summary.callCount === 1 ? 'call' : 'calls'}
              </span>
            )}
            {history.summary.voicemailCount > 0 && (
              <span><strong>{history.summary.voicemailCount}</strong>{' '}
                {history.summary.voicemailCount === 1 ? 'voicemail' : 'voicemails'}
              </span>
            )}
          </span>
          <span className="thread-history-action">View timeline</span>
        </button>
      )}

      {error && <div className="error" style={{ margin: '0 1rem' }}>{error}</div>}

      {/* v0.10.59 — Pending scheduled-message strip. Sits above the conversation
          stream so the user always sees what's queued to fire for this contact.
          Each row shows when it'll send + a preview, with edit/cancel buttons. */}
      {pendingSchedules.length > 0 && (
        <div className="pending-schedules">
          {pendingSchedules.map((row) => (
            <div key={row.id} className="pending-schedule-row">
              <Clock size={14} className="pending-schedule-icon" aria-hidden="true" />
              <div className="pending-schedule-text">
                <div className="pending-schedule-when">
                  Scheduled for {formatScheduledFor(row.scheduledFor)}
                </div>
                <div className="pending-schedule-preview" title={row.body}>
                  {row.body || (row.mediaUrls.length > 0 ? `${row.mediaUrls.length} attachment${row.mediaUrls.length === 1 ? '' : 's'}` : '(empty)')}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn pending-schedule-action"
                onClick={() => setShowScheduleModal({ mode: 'edit', row })}
                title="Edit scheduled message"
                aria-label="Edit scheduled message"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="icon-btn pending-schedule-action"
                onClick={async () => {
                  if (!window.confirm('Cancel this scheduled message?')) return;
                  const token = sessionStorage.getItem('ace_token');
                  if (!token) return;
                  const r = await cancelScheduledMessage(token, row.id);
                  if (r.ok) loadPendingSchedules();
                  else setError(r.error ?? 'Cancel failed');
                }}
                title="Cancel scheduled message"
                aria-label="Cancel scheduled message"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="msg-stream" ref={scrollRef}>
        {loading && messages.length === 0 && <div className="muted">Loading…</div>}
        {messages.map((m) => {
          // v0.10.72 — Surface a friendly blurb on failed / delivery_failed
          // bubbles. The `errors` JSON column holds the Telnyx error
          // envelope (when present); telnyxErrorBlurb extracts the code
          // and returns a short label + detail. Renders as a small red
          // info strip below the bubble text.
          const isFailedStatus =
            m.direction === 'outbound' &&
            (m.status === 'failed' || m.status === 'delivery_failed');
          const failBlurb = isFailedStatus
            ? telnyxErrorBlurb(m.errors ?? m.status)
            : null;
          return (
            <div
              key={m.id}
              className={`bubble ${m.direction === 'outbound' ? 'out' : 'in'}${isFailedStatus ? ' bubble-failed' : ''}`}
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
              {failBlurb && (
                <div
                  className="bubble-fail-blurb"
                  title={failBlurb.detail}
                >
                  <strong>{failBlurb.short}.</strong>{' '}
                  <span className="muted">{failBlurb.detail}</span>
                </div>
              )}
              <div className="bubble-meta">
                {formatRelative(m.createdAt)}
                {m.direction === 'outbound' && (
                  <span className="bubble-status"> · {m.status}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <input
        type="file"
        accept="image/*"
        ref={fileRef}
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {showQuickReplies && quickReplies.length > 0 && (
        <div className="quick-reply-popover" role="menu">
          <div className="quick-reply-popover-header">
            <span>Quick replies</span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowQuickReplies(false)}
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          <ul>
            {quickReplies.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="quick-reply-pop-item"
                  onClick={() => {
                    // Replace draft entirely if empty, otherwise append on new line.
                    setDraft((d) => (d.trim() ? `${d}\n${r}` : r));
                    setShowQuickReplies(false);
                  }}
                >
                  {r}
                </button>
              </li>
            ))}
          </ul>
          <div className="quick-reply-popover-footer muted small">
            Edit in Settings → Quick replies
          </div>
        </div>
      )}

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
        {quickReplies.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setShowQuickReplies((v) => !v)}
            aria-label="Quick replies"
            title="Quick replies"
          >
            <Zap size={20} />
          </button>
        )}
        {/* v0.10.29 — Emoji picker. Click → small grid of common emojis;
            click an emoji to insert at cursor position. */}
        <button
          type="button"
          className={`icon-btn${showEmojiPicker ? ' active' : ''}`}
          onClick={() => setShowEmojiPicker((v) => !v)}
          aria-label="Emoji"
          title="Insert emoji"
        >
          <Smile size={20} />
        </button>
        {/* v0.10.52 — SMS templates picker. Click → popover grouped by
            category. Picking a template inserts its body with
            {firstName} pre-filled from the contact (if known); other
            placeholders stay as `{varName}` for the user to fill before
            sending. Hidden if no templates exist (admin hasn't seeded). */}
        {templates.length > 0 && (
          <button
            type="button"
            className={`icon-btn${showTemplatePicker ? ' active' : ''}`}
            onClick={() => {
              setShowTemplatePicker((v) => !v);
              setShowEmojiPicker(false);
            }}
            aria-label="Templates"
            title="Insert template"
          >
            <FileText size={20} />
          </button>
        )}
        {/* v0.10.29 — Textarea (not input) for multi-line drafts.
            Enter sends; Shift+Enter inserts a newline. Browser-native
            autoCorrect / spellCheck / autoCapitalize for typing assistance. */}
        <textarea
          ref={composeInputRef}
          className="compose-input"
          placeholder="Text message"
          title="Shift+Enter for new line, Enter to send"
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck={true}
          autoComplete="on"
        />
        {uploading && <span className="muted" style={{ fontSize: 12 }}>uploading…</span>}
        {attached.length > 0 && (
          <span className="attach-pill" title={attached.join('\n')}>
            📎 {attached.length}
          </span>
        )}
        {/* v0.10.59 — Schedule button. Disabled when there's no draft +
            no attachments (nothing to schedule). Opens the date/time
            picker; on confirm, calls POST /me/scheduled-messages with the
            current draft + attached, then clears the compose row same
            as Send does. */}
        <button
          type="button"
          className="icon-btn compose-icon-btn"
          onClick={() => setShowScheduleModal({ mode: 'create' })}
          disabled={sending || (!draft.trim() && attached.length === 0)}
          aria-label="Schedule send"
          title="Schedule send"
        >
          <Clock size={18} />
        </button>
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

      {/* v0.10.29 — Emoji picker popover. Click an emoji to insert at
          the textarea's caret position, then close the popover. */}
      {showEmojiPicker && (
        <div className="emoji-picker-popover" role="dialog" aria-label="Emoji picker">
          <div className="emoji-picker-grid">
            {EMOJI_OPTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-picker-item"
                onClick={() => {
                  const el = composeInputRef.current;
                  if (el) {
                    const start = el.selectionStart ?? draft.length;
                    const end = el.selectionEnd ?? draft.length;
                    const next = draft.slice(0, start) + emoji + draft.slice(end);
                    setDraft(next);
                    // Restore caret AFTER the inserted emoji
                    requestAnimationFrame(() => {
                      el.focus();
                      const caret = start + emoji.length;
                      el.setSelectionRange(caret, caret);
                    });
                  } else {
                    setDraft(draft + emoji);
                  }
                  setShowEmojiPicker(false);
                }}
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* v0.10.52 — SMS templates picker popover. Templates are grouped
          by category. Clicking one replaces the entire draft (since
          templates are usually full SMS, not insertion snippets). The
          {firstName} variable is resolved from the contact's display
          name if known; the rest stay as `{var}` so the user can fill
          inline before sending. */}
      {showTemplatePicker && templates.length > 0 && (
        <div className="template-picker-popover" role="dialog" aria-label="SMS templates">
          {(() => {
            const grouped: Record<string, SmsTemplate[]> = {};
            for (const t of templates) {
              if (!grouped[t.category]) grouped[t.category] = [];
              grouped[t.category].push(t);
            }
            const categoryOrder = ['outreach', 'docs', 'submission', 'interview', 'followup', 'outcome', 'bgv', 'relationship', 'custom'];
            const categoryLabel: Record<string, string> = {
              outreach: 'Initial outreach',
              docs: 'Documents & profile',
              submission: 'Submission',
              interview: 'Interview',
              followup: 'Follow-ups & status',
              outcome: 'Outcomes',
              bgv: 'Onboarding & BGV',
              relationship: 'Relationship maintenance',
              custom: 'Custom',
            };
            // Extract the first word of the contact's display name as
            // a best-effort firstName. Falls back to '{firstName}' if
            // we can't resolve (e.g. unknown phone number).
            const resolveFirstName = (): string => {
              if (!displayName) return '{firstName}';
              // If displayName looks like a formatted phone (no letters),
              // leave the placeholder so the user knows to type it.
              if (!/[a-zA-Z]/.test(displayName)) return '{firstName}';
              return displayName.trim().split(/\s+/)[0];
            };
            const first = resolveFirstName();
            return (
              <div className="template-picker-content">
                {categoryOrder
                  .filter((cat) => grouped[cat] && grouped[cat].length > 0)
                  .map((cat) => (
                    <div key={cat} className="template-picker-group">
                      <div className="template-picker-group-label">
                        {categoryLabel[cat] ?? cat}
                      </div>
                      {grouped[cat].map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="template-picker-item"
                          onClick={() => {
                            // v0.10.54 — Resolve TWO auto-fill variables:
                            //   {firstName} → contact's first name
                            //   {recruiter} → logged-in user's first name
                            // Everything else stays as `{var}` for inline edit.
                            let resolved = t.body.replace(/\{firstName\}/g, first);
                            if (recruiterFirstName) {
                              resolved = resolved.replace(/\{recruiter\}/g, recruiterFirstName);
                            }
                            setDraft(resolved);
                            setShowTemplatePicker(false);
                            requestAnimationFrame(() => {
                              composeInputRef.current?.focus();
                            });
                          }}
                          title="Click to insert"
                        >
                          <div className="template-picker-item-name">{t.name}</div>
                          <div className="template-picker-item-body">
                            {t.body.length > 80 ? t.body.slice(0, 80) + '…' : t.body}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            );
          })()}
        </div>
      )}

      {showHistory && history && (
        <HistoryModal
          history={history}
          contactLabel={displayName}
          contactPhone={number}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* v0.10.59 — Schedule SMS picker. Two modes:
          - create: starts from the current draft + attached.
          - edit:   pre-fills from an existing pending row. */}
      {showScheduleModal && (
        <ScheduleMessageModal
          mode={showScheduleModal.mode}
          initial={showScheduleModal.mode === 'edit' ? showScheduleModal.row : null}
          toNumber={number}
          draftBody={draft}
          draftMediaUrls={attached}
          contactLabel={displayName}
          onClose={() => setShowScheduleModal(null)}
          onSaved={(_row, fromCreate) => {
            setShowScheduleModal(null);
            loadPendingSchedules();
            if (fromCreate) {
              // Treat scheduled-send as "draft handed off" — clear the
              // compose row so the user can't accidentally hit Send too.
              setDraft('');
              setAttached([]);
            }
          }}
        />
      )}
    </div>
  );
}

// v0.10.59 — Date/time picker modal for scheduling an SMS/MMS to send later.
//
// Two modes:
//  - 'create' starts from the current compose-row draft (body + attachments).
//    User picks a fire time, hits Schedule, we POST to /me/scheduled-messages,
//    parent clears the draft.
//  - 'edit' pre-fills from an existing pending row. User can revise body
//    and/or time. We PATCH on save.
//
// Quick-pick buttons under the time input fill common cases:
//  +1 hour, tomorrow 9am, Monday 9am. Power users can override with the
//  raw datetime-local control.
function ScheduleMessageModal({
  mode,
  initial,
  toNumber,
  draftBody,
  draftMediaUrls,
  contactLabel,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: ScheduledMessage | null;
  toNumber: string;
  draftBody: string;
  draftMediaUrls: string[];
  contactLabel: string;
  onClose: () => void;
  onSaved: (row: ScheduledMessage, fromCreate: boolean) => void;
}) {
  // Default time: +1 hour from now (rounded to next minute). For edit
  // mode, pre-fill from the existing row.
  const defaultDt = useMemo(() => {
    if (initial) return new Date(initial.scheduledFor);
    const d = new Date();
    d.setSeconds(0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }, [initial]);

  const [whenStr, setWhenStr] = useState(() => toLocalDatetimeInputValue(defaultDt));
  const [body, setBody] = useState(() => initial?.body ?? draftBody);
  const [mediaUrls] = useState<string[]>(() => initial?.mediaUrls ?? draftMediaUrls);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply a quick-pick to the input.
  const setQuick = (target: Date) => {
    target.setSeconds(0, 0);
    setWhenStr(toLocalDatetimeInputValue(target));
  };

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const canSubmit = (() => {
    if (submitting) return false;
    if (body.trim() === '' && mediaUrls.length === 0) return false;
    const when = new Date(whenStr);
    if (Number.isNaN(when.getTime())) return false;
    if (when.getTime() < Date.now() - 5_000) return false;
    return true;
  })();

  async function handleSave() {
    setError(null);
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const when = new Date(whenStr);
    if (Number.isNaN(when.getTime())) {
      setError('Pick a valid date and time');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'create') {
        const r = await createScheduledMessage(token, {
          toNumber,
          body: body.trim() || undefined,
          mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
          scheduledFor: when.toISOString(),
        });
        if ('error' in r) {
          setError(r.error);
        } else {
          onSaved(r, true);
        }
      } else if (initial) {
        const r = await updateScheduledMessage(token, initial.id, {
          body,
          scheduledFor: when.toISOString(),
        });
        if ('error' in r) {
          setError(r.error);
        } else {
          onSaved(r, false);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="compose-modal" onClick={submitting ? undefined : onClose}>
      <div
        className="fav-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="schedule-msg-title"
        style={{ maxWidth: 480 }}
      >
        <div className="fav-modal-header">
          <Clock size={18} className="fav-modal-icon" />
          <h3 id="schedule-msg-title">
            {mode === 'create' ? 'Schedule message' : 'Edit scheduled message'}
          </h3>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Will send to <strong>{contactLabel}</strong> at the time below. Fires
          within ~30 seconds of the scheduled time.
        </p>

        <label className="fav-modal-field" style={{ marginBottom: 8 }}>
          <span className="fav-modal-label">When</span>
          <input
            type="datetime-local"
            className="fav-modal-input"
            value={whenStr}
            onChange={(e) => setWhenStr(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="schedule-quickpicks">
          <button
            type="button"
            className="device-action"
            onClick={() => setQuick(new Date(Date.now() + 60 * 60_000))}
            disabled={submitting}
          >
            +1 hour
          </button>
          <button
            type="button"
            className="device-action"
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() + 1);
              d.setHours(9, 0, 0, 0);
              setQuick(d);
            }}
            disabled={submitting}
          >
            Tomorrow 9am
          </button>
          <button
            type="button"
            className="device-action"
            onClick={() => {
              // Next Monday 9am — if today is Monday, +7 days.
              const d = new Date();
              const day = d.getDay(); // 0 = Sun, 1 = Mon
              const offset = day === 1 ? 7 : ((8 - day) % 7);
              d.setDate(d.getDate() + offset);
              d.setHours(9, 0, 0, 0);
              setQuick(d);
            }}
            disabled={submitting}
          >
            Monday 9am
          </button>
        </div>

        <label className="fav-modal-field" style={{ marginTop: 12 }}>
          <span className="fav-modal-label">Message</span>
          <textarea
            className="fav-modal-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            disabled={submitting}
            placeholder={mediaUrls.length > 0 ? '(attachment only — body optional)' : 'Type your message...'}
          />
        </label>
        {mediaUrls.length > 0 && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {mediaUrls.length} attachment{mediaUrls.length === 1 ? '' : 's'} attached
            {mode === 'edit' && ' (attachments can\'t be changed when editing — cancel + reschedule to swap)'}
          </div>
        )}

        {error && (
          <div className="error" style={{ marginTop: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            className="device-action"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="device-action primary"
            onClick={handleSave}
            disabled={!canSubmit}
          >
            {submitting ? 'Saving...' : mode === 'create' ? 'Schedule' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryModal({
  history,
  contactLabel,
  contactPhone,
  onClose,
}: {
  history: ContactHistory;
  contactLabel: string;
  contactPhone: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // The `from` location these filtered views will navigate back to.
  const fromUrl = `/messages?to=${encodeURIComponent(contactPhone)}`;

  // Navigate to a filtered Recents / Voicemail view scoped to this contact.
  // The destination page reads ?phone= to filter and ?from= for its back button.
  function jumpToFilteredList(target: 'recents' | 'voicemail') {
    onClose();
    navigate(`/${target}?phone=${encodeURIComponent(contactPhone)}&from=${encodeURIComponent(fromUrl)}`);
  }

  return (
    <div className="history-modal" role="dialog" aria-label="Contact history">
      <div className="history-box">
        <div className="history-header">
          <div>
            <div className="history-title">Interaction history</div>
            <div className="history-subtitle">{contactLabel}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="history-summary">
          <button
            type="button"
            className="history-summary-item"
            onClick={onClose}
            disabled={history.summary.messageCount === 0}
            title="You're already viewing this conversation"
          >
            <strong>{history.summary.messageCount}</strong>
            <span>Messages</span>
          </button>
          <button
            type="button"
            className="history-summary-item clickable"
            onClick={() => jumpToFilteredList('recents')}
            disabled={history.summary.callCount === 0}
            title={
              history.summary.callCount > 0
                ? `View ${history.summary.callCount} call${history.summary.callCount === 1 ? '' : 's'} with this contact`
                : 'No calls with this contact'
            }
          >
            <strong>{history.summary.callCount}</strong>
            <span>Calls</span>
          </button>
          <button
            type="button"
            className="history-summary-item clickable"
            onClick={() => jumpToFilteredList('voicemail')}
            disabled={history.summary.voicemailCount === 0}
            title={
              history.summary.voicemailCount > 0
                ? `View ${history.summary.voicemailCount} voicemail${history.summary.voicemailCount === 1 ? '' : 's'} from this contact`
                : 'No voicemails from this contact'
            }
          >
            <strong>{history.summary.voicemailCount}</strong>
            <span>Voicemails</span>
          </button>
        </div>
        <ul className="history-timeline">
          {history.timeline.length === 0 && (
            <li className="muted" style={{ padding: '1rem', textAlign: 'center' }}>
              No interactions yet.
            </li>
          )}
          {history.timeline.map((entry) => (
            <TimelineRow key={`${entry.type}-${entry.id}`} entry={entry} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: ContactTimelineEntry }) {
  const when = formatRelative(entry.timestamp);
  if (entry.type === 'message') {
    const m = entry.message!;
    const label = entry.direction === 'outbound' ? 'Sent' : 'Received';
    const preview = m.body
      ? m.body.length > 140 ? m.body.slice(0, 140) + '…' : m.body
      : m.mediaUrls.length > 0 ? `📎 ${m.mediaUrls.length} attachment${m.mediaUrls.length === 1 ? '' : 's'}` : '(empty)';
    return (
      <li className={`timeline-row ${entry.direction === 'outbound' ? 'out' : 'in'}`}>
        <span className="timeline-icon" aria-hidden="true">
          <MessageSquarePlus size={14} />
        </span>
        <div className="timeline-body">
          <div className="timeline-meta">
            <span className="timeline-type">{label} message</span>
            <span className="timeline-time">{when}</span>
          </div>
          <div className="timeline-detail">{preview}</div>
        </div>
      </li>
    );
  }
  if (entry.type === 'call') {
    const c = entry.call!;
    const verb = entry.direction === 'inbound'
      ? c.status === 'missed' || c.status === 'no_answer' ? 'Missed call' : 'Incoming call'
      : 'Outgoing call';
    const detail = c.durationSeconds > 0
      ? `${Math.floor(c.durationSeconds / 60)}:${String(c.durationSeconds % 60).padStart(2, '0')}`
      : c.hangupCause || c.status;
    return (
      <li className={`timeline-row ${entry.direction === 'outbound' ? 'out' : 'in'} ${c.status === 'missed' ? 'missed' : ''}`}>
        <span className="timeline-icon" aria-hidden="true">
          <Phone size={14} />
        </span>
        <div className="timeline-body">
          <div className="timeline-meta">
            <span className="timeline-type">{verb}</span>
            <span className="timeline-time">{when}</span>
          </div>
          <div className="timeline-detail">{detail}</div>
        </div>
      </li>
    );
  }
  // voicemail
  const v = entry.voicemail!;
  return (
    <li className="timeline-row in">
      <span className="timeline-icon" aria-hidden="true">
        <Send size={14} />
      </span>
      <div className="timeline-body">
        <div className="timeline-meta">
          <span className="timeline-type">Voicemail</span>
          <span className="timeline-time">{when}</span>
        </div>
        <div className="timeline-detail">
          {v.transcription
            ? (v.transcription.length > 140 ? v.transcription.slice(0, 140) + '…' : v.transcription)
            : `${v.durationSeconds}s recording`}
        </div>
      </div>
    </li>
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
  // Favorite name takes precedence over JobDiva so the user's own label
  // wins (e.g. they saved "Adam — recruiter" but JobDiva says "Adam Smith"). (#161)
  const label = getFavoriteName(thread.threadKey) ?? jd?.name ?? formatNumber(thread.threadKey);
  // A thread is "unread" if the most recent message was inbound AND arrived
  // after the user last opened this specific thread. Outbound messages
  // (sent by the user) never count as unread.
  const unread =
    thread.direction === 'inbound' &&
    new Date(thread.createdAt) > new Date(getThreadLastVisit(thread.threadKey));
  return (
    <li
      className={`thread-row${unread ? ' unread' : ''}`}
      onClick={onOpen}
    >
      {unread && <span className="thread-unread-dot" aria-label="Unread message" />}
      <div className="thread-text">
        <div className="thread-name">
          {label}
          {/* v0.10.0 Task 5 — which of the user's DIDs this thread's
              most-recent message landed on. Hidden when single-DID. */}
          <LineBadge userDid={thread.userDid} />
        </div>
        <div className="thread-preview">
          {thread.direction === 'outbound' ? 'You: ' : ''}
          {thread.body || (thread.mediaUrls?.length ? '\u{1F4CE} attachment' : '')}
        </div>
      </div>
      <div className="thread-time">{formatRelative(thread.createdAt)}</div>
    </li>
  );
}

// v0.10.13 — Internal-chat row rendered inside the unified Messages list.
// Visually mirrors ThreadRow so the user sees a single coherent list, but
// the avatar shows initials of the teammate (not a phone-style icon) and
// clicks navigate to /chat?with=<userId> where the real-time chat detail
// view takes over (presence, typing indicators, WebSocket push). Read-state
// is communicated via the unreadCount on the InternalChatThread row.
interface ChatRowInListProps {
  chat: InternalChatThread;
  onOpen: () => void;
}
function ChatRowInList({ chat, onOpen }: ChatRowInListProps) {
  const unread = chat.unreadCount > 0;
  const u = chat.otherUser;
  const display =
    u
      ? ([u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || `User ${chat.otherId}`)
      : `User ${chat.otherId}`;
  const initials = u
    ? (`${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase() || (u.email?.[0]?.toUpperCase() ?? '?'))
    : '?';
  return (
    <li
      className={`thread-row${unread ? ' unread' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="chat-row-avatar" aria-hidden="true">{initials}</div>
      <div className="thread-text">
        <div className="thread-name">
          {display}
          <span className="thread-kind-chip" title="Internal chat with teammate">team</span>
        </div>
        <div className="thread-preview">
          {chat.lastSenderId && u && chat.lastSenderId !== u.id ? 'You: ' : ''}
          {chat.lastMessage || (chat.mediaUrl ? '\u{1F4CE} attachment' : '…')}
        </div>
      </div>
      <div className="thread-time">{formatRelative(chat.lastAt)}</div>
    </li>
  );
}
