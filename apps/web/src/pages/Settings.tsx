import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, NavLink, Navigate } from 'react-router-dom';
import {
  ArrowLeft,
  Mic,
  Volume2,
  Check,
  Play,
  RotateCcw,
  Phone,
  Eye,
  EyeOff,
  ChevronRight,
  Bell,
  MessageSquare,
  Plus,
  Trash2,
  GripVertical,
  Sun,
  Moon,
  Monitor,
  Palette,
  UserCircle,
  Download,
  Upload,
  Database,
  Music,
  PauseCircle,
  PlayCircle,
  PhoneForwarded,
  ShieldOff,
  Users,
  ScrollText,
  ShieldCheck,
  UserPlus,
  MoreHorizontal,
  Power,
  KeyRound,
  FileText,
  Activity,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed as PhoneMissedIcon,
  Radio,
  TrendingUp,
  AlertTriangle,
  DollarSign,
  Target,
  Siren,
  X,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import {
  getMe,
  updateMe,
  getCallForwarding,
  saveCallForwarding,
  type CallForwardingSettings,
  getBlockedNumbers,
  addBlockedNumber,
  removeBlockedNumber,
  type BlockedNumber,
  listAdminUsers,
  inviteAdminUser,
  inviteNewUserAutoProvision,
  listUnassignedTelnyxNumbers,
  type InviteNewUserResult,
  type UnassignedTelnyxNumber,
  updateAdminUser,
  deleteUserHard,
  type DeleteUserHardResult,
  listAuditLogs,
  bulkImportUsers,
  getLiveOpsReport,
  getPresenceReport,
  getUsageReport,
  getQualityReport,
  getCostReport,
  getRecruiterReport,
  getAlertsReport,
  type AdminUserRow,
  type AuditLogEntry,
  type BulkImportRow,
  type BulkImportResult,
  type LiveOpsReport,
  type PresenceReport,
  type UsageReport,
  type QualityReport,
  type CostReport,
  type RecruiterReport,
  type AlertsReport,
} from '../api';
import {
  DEFAULT_QUICK_REPLIES,
  getQuickReplies,
  setQuickReplies,
  resetQuickReplies,
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
  getTheme,
  setTheme,
  type ThemePref,
  getHoldMusicEnabled,
  setHoldMusicEnabled,
  getHoldMusicDataUrl,
  getHoldMusicFilename,
  setHoldMusicDataUrl,
  clearHoldMusic,
  HOLD_MUSIC_MAX_BYTES,
} from '../lib/userPrefs';
import PendingUsersSection from '../components/PendingUsersSection';
import { formatPhone } from '../lib/phone';

interface AudioDevice {
  deviceId: string;
  label: string;
}

type SectionCategory = 'Personal' | 'Calling' | 'Reports' | 'Admin';

interface SectionDef {
  key: string;
  category: SectionCategory;
  label: string;
  icon: typeof Mic;
  blurb: string;
  Component: React.FC;
}

const SECTIONS: SectionDef[] = [
  { key: 'account', category: 'Personal', label: 'Account', icon: UserCircle, blurb: 'Name, DID, SIP', Component: AccountSection },
  { key: 'appearance', category: 'Personal', label: 'Appearance', icon: Palette, blurb: 'Light / dark / system', Component: AppearanceSection },
  { key: 'telnyx', category: 'Calling', label: 'Telnyx', icon: Phone, blurb: 'SIP credentials', Component: TelnyxSection },
  { key: 'microphone', category: 'Calling', label: 'Microphone', icon: Mic, blurb: 'Input device', Component: MicrophoneSection },
  { key: 'speaker', category: 'Calling', label: 'Speaker', icon: Volume2, blurb: 'Output device', Component: SpeakerSection },
  { key: 'notifications', category: 'Personal', label: 'Notifications', icon: Bell, blurb: 'Calls + SMS alerts', Component: NotificationsSection },
  { key: 'quick-replies', category: 'Personal', label: 'Quick replies', icon: MessageSquare, blurb: 'SMS templates', Component: QuickRepliesSection },
  { key: 'hold-music', category: 'Calling', label: 'Hold music', icon: Music, blurb: 'Play music when on hold', Component: HoldMusicSection },
  { key: 'voicemail-greeting', category: 'Calling', label: 'Voicemail greeting', icon: Mic, blurb: 'Personal greeting (coming soon)', Component: VoicemailGreetingSection },
  { key: 'call-forwarding', category: 'Calling', label: 'Call forwarding', icon: PhoneForwarded, blurb: 'Forward calls to another number', Component: CallForwardingSection },
  { key: 'blocked-numbers', category: 'Calling', label: 'Blocked numbers', icon: ShieldOff, blurb: 'Reject calls & SMS from specific numbers', Component: BlockedNumbersSection },
  { key: 'data', category: 'Personal', label: 'Data', icon: Database, blurb: 'Backup & restore', Component: DataSection },
  // Admin-only. Components themselves show an "Admin access required"
  // empty state for non-admins so the nav nav-items don't dead-link.
  { key: 'live-ops', category: 'Reports', label: 'Live ops', icon: Activity, blurb: 'Real-time dashboard (admin only)', Component: LiveOpsSection },
  { key: 'presence', category: 'Reports', label: 'Presence', icon: Radio, blurb: 'Who is on call right now (admin only)', Component: PresenceSection },
  { key: 'usage', category: 'Reports', label: 'Usage', icon: TrendingUp, blurb: 'Per-user volume + talk time (admin only)', Component: UsageSection },
  { key: 'quality', category: 'Reports', label: 'Quality', icon: AlertTriangle, blurb: 'Missed rate + hangup causes (admin only)', Component: QualitySection },
  { key: 'cost', category: 'Reports', label: 'Cost', icon: DollarSign, blurb: 'Telnyx spend per user + projection (admin only)', Component: CostSection },
  { key: 'recruiter', category: 'Reports', label: 'Recruiter', icon: Target, blurb: 'Reach + conversation rate (admin only)', Component: RecruiterSection },
  { key: 'alerts', category: 'Reports', label: 'Alerts', icon: Siren, blurb: 'Health & anomaly alerts (admin only)', Component: AlertsSection },
  { key: 'users', category: 'Admin', label: 'Users', icon: Users, blurb: 'Invite, promote, deactivate (admin only)', Component: UsersAdminSection },
  { key: 'pending-users', category: 'Admin', label: 'Pending Users', icon: UserPlus, blurb: 'Stage + invite Pulse users to ACE (admin only)', Component: PendingUsersSection },
  { key: 'audit-log', category: 'Admin', label: 'Audit log', icon: ScrollText, blurb: 'Recent admin actions (admin only)', Component: AuditLogSection },
];

const SECTION_CATEGORIES: SectionCategory[] = ['Personal', 'Calling', 'Reports', 'Admin'];

const DEFAULT_SECTION = SECTIONS[0].key;


// Sidebar nav with collapsible category groups. Whatever category contains
// the currently-active section always stays expanded; user's open/closed
// choices for OTHER categories persist via localStorage.
function SettingsNav({ activeCategory }: { activeCategory: SectionCategory }) {
  const STORE_KEY = 'ace_settings_nav_open';
  const [openCats, setOpenCats] = useState<Set<SectionCategory>>(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr as SectionCategory[]);
      }
    } catch { /* ignore */ }
    return new Set<SectionCategory>(['Personal', activeCategory]);
  });

  // Resolve isAdmin once so we can hide the Admin nav group from non-admins.
  // The backend already 403s every /admin/* endpoint, but showing nav items
  // a user can't open is confusing.
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    let cancelled = false;
    getMe(token)
      .then((u) => { if (!cancelled) setIsAdmin(!!u.isAdmin); })
      .catch(() => { /* leave isAdmin=false on error */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setOpenCats((prev) => {
      if (prev.has(activeCategory)) return prev;
      const next = new Set(prev);
      next.add(activeCategory);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(next))); } catch { /* noop */ }
      return next;
    });
  }, [activeCategory]);

  function toggle(cat: SectionCategory) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(next))); } catch { /* noop */ }
      return next;
    });
  }

  return (
    <nav className="settings-nav-list grouped">
      {SECTION_CATEGORIES.map((cat) => {
        // Hide the Admin group entirely for non-admin users so they don't see
        // nav items that 403 when clicked. Backend stays the source of truth.
        if (cat === 'Admin' && !isAdmin) return null;
        const items = SECTIONS.filter((sec) => sec.category === cat);
        if (items.length === 0) return null;
        const open = openCats.has(cat);
        return (
          <div key={cat} className={`settings-nav-group ${open ? 'open' : 'closed'}`}>
            <button
              type="button"
              className="settings-nav-group-header"
              onClick={() => toggle(cat)}
              aria-expanded={open}
            >
              <span className="settings-nav-group-title">{cat}</span>
              <span className="settings-nav-group-count">{items.length}</span>
              <ChevronRight size={14} className={`settings-nav-group-chev ${open ? 'open' : ''}`} />
            </button>
            {open && (
              <div className="settings-nav-group-items">
                {items.map((sec) => (
                  <NavLink
                    key={sec.key}
                    to={`/settings/${sec.key}`}
                    className={({ isActive }) =>
                      `settings-nav-item ${isActive ? 'active' : ''}`
                    }
                  >
                    <span className="settings-nav-icon"><sec.icon size={18} /></span>
                    <span className="settings-nav-label">
                      <span className="settings-nav-title">{sec.label}</span>
                      <span className="settings-nav-blurb">{sec.blurb}</span>
                    </span>
                    <ChevronRight size={14} className="settings-nav-chev" />
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default function Settings() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

  // Reset scroll to top whenever the user switches sections.
  // Real scroll container is .app-content (Layout.tsx has overflow-y: auto).
  // v0.9.9 — fire THREE times: immediate, after rAF, and after 50ms timeout.
  // Some section components (Reports, Users, Audit) do their own fetch+render
  // that re-anchors scroll position; the delayed attempts catch those.
  const paneBodyRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const scrollEverything = () => {
      document.querySelector('.app-content')?.scrollTo({ top: 0, left: 0 });
      paneBodyRef.current?.scrollTo({ top: 0, left: 0 });
      paneRef.current?.scrollTo({ top: 0, left: 0 });
      window.scrollTo({ top: 0, left: 0 });
    };
    scrollEverything();                              // immediate
    requestAnimationFrame(scrollEverything);         // after next paint
    const t = window.setTimeout(scrollEverything, 50); // after async render settles
    return () => window.clearTimeout(t);
  }, [section]);

  // Redirect /settings → /settings/<default>
  if (!section) return <Navigate to={`/settings/${DEFAULT_SECTION}`} replace />;
  const active = SECTIONS.find((s) => s.key === section);
  if (!active) return <Navigate to={`/settings/${DEFAULT_SECTION}`} replace />;
  const ActiveComponent = active.Component;

  return (
    <div className="settings settings-split">
      <aside className="settings-nav">
        <div className="settings-nav-header">
          <button
            onClick={() => navigate(-1)}
            className="settings-back"
            aria-label="Back"
          >
            <ArrowLeft size={20} />
          </button>
          <h1>Settings</h1>
        </div>
        <SettingsNav activeCategory={active.category} />
      </aside>

      <main className="settings-pane" ref={paneRef}>
        <header className="settings-pane-header">
          <span className="settings-pane-icon"><active.icon size={20} /></span>
          <h2>{active.label}</h2>
        </header>
        <div className="settings-pane-body" ref={paneBodyRef}>
          <ActiveComponent />
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account â€” name, email (read-only), DID, SIP username
// Multi-user routing on the server uses didNumber + sipUsername to figure out
// which user a webhook event belongs to, so they need to be correct.
// ---------------------------------------------------------------------------
interface AccountState {
  firstName: string;
  lastName: string;
  sipUsername: string;
  didNumber: string;
  email: string;
}
function AccountSection() {
  const [state, setState] = useState<AccountState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    getMe(token)
      .then((u) =>
        setState({
          firstName: u.firstName ?? '',
          lastName: u.lastName ?? '',
          sipUsername: u.sipUsername ?? '',
          didNumber: u.didNumber ?? '',
          email: u.email,
        }),
      )
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save() {
    const token = sessionStorage.getItem('ace_token');
    if (!token || !state) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMe(token, {
        firstName: state.firstName || null,
        lastName: state.lastName || null,
        sipUsername: state.sipUsername || null,
        didNumber: state.didNumber || null,
      });
      setState((cur) =>
        cur
          ? {
              ...cur,
              firstName: updated.firstName ?? '',
              lastName: updated.lastName ?? '',
              sipUsername: updated.sipUsername ?? '',
              didNumber: updated.didNumber ?? '',
            }
          : cur,
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!state) {
    return <div className="settings-section">{error ?? 'Loadingâ€¦'}</div>;
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Your profile info. The DID + SIP username route inbound calls and SMS
        to your account â€” set these to match your Telnyx setup.
      </p>

      <div className="cred-grid">
        <label className="cred-field">
          <span>Email (read-only)</span>
          <input type="email" value={state.email} disabled />
        </label>
        <label className="cred-field">
          <span>First name</span>
          <input
            type="text"
            value={state.firstName}
            onChange={(e) => setState({ ...state, firstName: e.target.value })}
          />
        </label>
        <label className="cred-field">
          <span>Last name</span>
          <input
            type="text"
            value={state.lastName}
            onChange={(e) => setState({ ...state, lastName: e.target.value })}
          />
        </label>
        <label className="cred-field">
          <span>DID (your Telnyx phone number, +E.164)</span>
          <input
            type="tel"
            placeholder="+15555550100"
            value={state.didNumber}
            onChange={(e) => setState({ ...state, didNumber: e.target.value })}
          />
        </label>
        <label className="cred-field">
          <span>SIP username</span>
          <input
            type="text"
            placeholder="ace-dialer-abdulla"
            autoComplete="off"
            value={state.sipUsername}
            onChange={(e) => setState({ ...state, sipUsername: e.target.value })}
          />
        </label>
      </div>

      {error && <div className="error" style={{ marginTop: '0.6rem' }}>{error}</div>}

      <div className="device-actions">
        <button
          type="button"
          className="device-action primary"
          onClick={save}
          disabled={saving}
        >
          {saving ? 'Savingâ€¦' : saved ? 'âœ“ Saved' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance (theme picker)
// ---------------------------------------------------------------------------
function AppearanceSection() {
  const [theme, setLocalTheme] = useState<ThemePref>(() => getTheme());

  function pick(t: ThemePref) {
    setLocalTheme(t);
    setTheme(t);
  }

  const options: Array<{ key: ThemePref; label: string; icon: typeof Sun; desc: string }> = [
    { key: 'system', label: 'System', icon: Monitor, desc: 'Follows your OS appearance setting.' },
    { key: 'light', label: 'Light', icon: Sun, desc: 'Always light, regardless of OS.' },
    { key: 'dark', label: 'Dark', icon: Moon, desc: 'Always dark.' },
  ];

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Choose how the dialer looks. "System" matches your OS appearance and
        flips automatically when your OS does.
      </p>

      <div className="theme-picker" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={theme === o.key}
            className={`theme-picker-btn${theme === o.key ? ' active' : ''}`}
            onClick={() => pick(o.key)}
          >
            <o.icon size={14} />
            {o.label}
          </button>
        ))}
      </div>

      <p className="settings-blurb" style={{ marginTop: '1rem' }}>
        {options.find((o) => o.key === theme)?.desc}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telnyx credentials section
// ---------------------------------------------------------------------------
function TelnyxSection() {
  const [username, setUsername] = useState(() => localStorage.getItem('ace_sip_username') ?? '');
  const [password, setPassword] = useState(() => localStorage.getItem('ace_sip_password') ?? '');
  const [fromNumber, setFromNumber] = useState(() => localStorage.getItem('ace_sip_from_number') ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  function save() {
    if (username) localStorage.setItem('ace_sip_username', username);
    else localStorage.removeItem('ace_sip_username');
    if (password) localStorage.setItem('ace_sip_password', password);
    else localStorage.removeItem('ace_sip_password');
    if (fromNumber) localStorage.setItem('ace_sip_from_number', fromNumber);
    else localStorage.removeItem('ace_sip_from_number');
    setSaving(true);
    setTimeout(() => window.location.reload(), 400);
  }

  function clearAll() {
    localStorage.removeItem('ace_sip_username');
    localStorage.removeItem('ace_sip_password');
    localStorage.removeItem('ace_sip_from_number');
    setUsername('');
    setPassword('');
    setFromNumber('');
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Telnyx SIP credential username + password for your WebRTC-enabled connection.
        Stored locally on this device only.
      </p>
      <div className="cred-grid">
        <label className="cred-field">
          <span>Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Telnyx SIP credential username"
            autoComplete="username"
          />
        </label>
        <label className="cred-field">
          <span>Password</span>
          <div className="cred-password">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Telnyx SIP credential password"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="cred-eye"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        <label className="cred-field">
          <span>From number (E.164)</span>
          <input
            type="tel"
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            placeholder="+15555550100"
          />
        </label>
      </div>
      <div className="device-actions">
        <button
          type="button"
          className="device-action primary"
          onClick={save}
          disabled={!username || !password || saving}
        >
          {saving ? 'Reconnectingâ€¦' : 'Save & reconnect'}
        </button>
        {(username || password || fromNumber) && (
          <button type="button" className="device-action" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Microphone section
// ---------------------------------------------------------------------------
function MicrophoneSection() {
  const [mics, setMics] = useState<AudioDevice[]>([]);
  const [selected, setSelected] = useState<string>(localStorage.getItem('ace_mic') || 'default');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) => {
        setMics(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })),
        );
      })
      .catch((e) => setError(e?.message ?? 'Mic access denied'));
  }, []);

  function pick(id: string) {
    setSelected(id);
    if (id === 'default') localStorage.removeItem('ace_mic');
    else localStorage.setItem('ace_mic', id);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">Choose which microphone the dialer uses for outgoing audio.</p>
      {error && <div className="error">{error}</div>}
      <DeviceList
        devices={[{ deviceId: 'default', label: 'System default' }, ...mics]}
        selected={selected}
        onPick={pick}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speaker section
// ---------------------------------------------------------------------------
function SpeakerSection() {
  const [speakers, setSpeakers] = useState<AudioDevice[]>([]);
  const [selected, setSelected] = useState<string>(localStorage.getItem('ace_speaker') || 'default');
  const [error, setError] = useState<string | null>(null);
  const [supportsSinkId, setSupportsSinkId] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setSupportsSinkId('setSinkId' in HTMLMediaElement.prototype);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) => {
        setSpeakers(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Speaker' })),
        );
      })
      .catch((e) => setError(e?.message ?? 'Mic access denied'));
  }, []);

  function pick(id: string) {
    setSelected(id);
    if (id === 'default' || !id) localStorage.removeItem('ace_speaker');
    else localStorage.setItem('ace_speaker', id);
    const audioEl = document.getElementById('ace-remote-audio') as HTMLAudioElement | null;
    if (audioEl && 'setSinkId' in audioEl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (audioEl as any).setSinkId(id === 'default' ? '' : id).catch((e: Error) => setError(e.message));
    }
  }

  async function testSpeaker() {
    setError(null);
    try {
      const ctx = (audioCtxRef.current ??= new AudioContext());
      if (ctx.state === 'suspended') await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(dest);
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = dest.stream;
      if (selected && selected !== 'default' && 'setSinkId' in audio) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (audio as any).setSinkId(selected).catch((e: Error) => setError(`setSinkId: ${e.message}`));
      }
      osc.start();
      await audio.play();
      setTimeout(() => {
        osc.stop();
        audio.srcObject = null;
      }, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test playback failed');
    }
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Choose which speaker the dialer routes incoming call audio to.
      </p>
      {!supportsSinkId && (
        <p className="muted small">Speaker selection not supported in this browser. Uses system default.</p>
      )}
      {error && <div className="error">{error}</div>}
      <DeviceList
        devices={[{ deviceId: 'default', label: 'System default' }, ...speakers]}
        selected={selected}
        onPick={pick}
        disabled={!supportsSinkId}
      />
      <div className="device-actions">
        <button type="button" className="device-action" onClick={testSpeaker}>
          <Play size={14} /> Test speaker
        </button>
        <button type="button" className="device-action" onClick={() => pick('default')}>
          <RotateCcw size={14} /> Use system default
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hold music â€” upload an audio file to play when a caller is on hold.
// Stored locally as a data URL (base64). The actual track-swap happens in
// sipService.startHoldMusic() / stopHoldMusic() â€” they replace the outgoing
// mic track with this audio so the held party hears it (not silence).
// ---------------------------------------------------------------------------
function HoldMusicSection() {
  const [enabled, setEnabled] = useState<boolean>(() => getHoldMusicEnabled());
  const [dataUrl, setDataUrl] = useState<string | null>(() => getHoldMusicDataUrl());
  const [filename, setFilename] = useState<string | null>(() => getHoldMusicFilename());
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function pickFile() { fileRef.current?.click(); }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name)) {
      setError('That doesnâ€™t look like an audio file.');
      return;
    }
    if (file.size > HOLD_MUSIC_MAX_BYTES) {
      setError(`Too big â€” please use a file under ${Math.round(HOLD_MUSIC_MAX_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const url = reader.result as string;
        setHoldMusicDataUrl(url, file.name);
        setDataUrl(url);
        setFilename(file.name);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    reader.onerror = () => setError('Failed to read file.');
    reader.readAsDataURL(file);
  }

  function clear() {
    if (!confirm('Remove the saved hold music?')) return;
    clearHoldMusic();
    setDataUrl(null);
    setFilename(null);
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* noop */ }
    }
    setPreviewing(false);
  }

  function togglePreview() {
    if (!dataUrl) return;
    if (previewing) {
      try { audioRef.current?.pause(); } catch { /* noop */ }
      setPreviewing(false);
    } else {
      const el = audioRef.current ?? new Audio();
      el.src = dataUrl;
      el.loop = true;
      el.volume = 0.6;
      void el.play().then(() => setPreviewing(true)).catch((err) => setError((err as Error).message));
      audioRef.current = el;
    }
  }

  function toggleEnabled() {
    const v = !enabled;
    setEnabled(v);
    setHoldMusicEnabled(v);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Play music to the other party when you put a call on hold. Without
        this, they hear silence (which usually makes them assume the call
        dropped). Pick any MP3, WAV, or M4A file under 2 MB â€” it will loop
        while the call is held. Stored on this device only.
      </p>

      <div className="pref-list">
        <div className="pref-row">
          <div className="pref-text">
            <div className="pref-label">Enable hold music</div>
            <div className="pref-desc">
              {dataUrl ? `Using: ${filename ?? 'uploaded file'}` : 'No file uploaded yet.'}
            </div>
          </div>
          <label className="pref-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!dataUrl}
              onChange={toggleEnabled}
            />
            <span className="pref-slider" />
          </label>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      <div className="device-actions" style={{ marginTop: '0.8rem' }}>
        <button type="button" className="device-action primary" onClick={pickFile}>
          <Upload size={14} /> {dataUrl ? 'Replace file' : 'Upload audio file'}
        </button>
        {dataUrl && (
          <>
            <button type="button" className="device-action" onClick={togglePreview}>
              {previewing ? <><PauseCircle size={14} /> Stop preview</> : <><PlayCircle size={14} /> Preview</>}
            </button>
            <button type="button" className="device-action danger" onClick={clear}>
              Remove file
            </button>
          </>
        )}
      </div>

      {error && <div className="error" style={{ marginTop: '0.6rem' }}>{error}</div>}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Note: hold music plays only while *you* are holding the other party.
        When *they* hold *you*, what you hear is up to their phone system.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voicemail greeting â€” parked. Telnyx Hosted Voicemail (the per-DID
// /v2/phone_numbers/{id}/voicemail endpoint) does not expose a
// `greeting_audio_url` field. PATCH calls silently drop it and the carrier
// continues using the default robot voice. Confirmed via Portal: the
// Voicemail section for our DIDs only has Enable / PIN / Noise toggles.
//
// Real options if we want this later:
//   (a) Switch this DID to Telnyx Programmable Voice (TexML), route
//       inbound to a TexML doc with <Play>{greeting}</Play><Record/>, and
//       ingest the recording via webhook (this is what the old Pulse
//       system did). ~half a day of careful work; risks breaking the
//       working inbound ring flow if mis-configured.
//   (b) Front Telnyx with a small Call Control app that intercepts
//       call.no_answer, plays the user's audio file, then transfers
//       back to the voicemail dialplan. Similar complexity.
//
// For now: show a Coming Soon panel so users see the feature is planned
// without exposing the broken upload UX. API endpoint + DB columns are
// kept; they're harmless and ready for whichever path we pick.
// ---------------------------------------------------------------------------
function VoicemailGreetingSection() {
  return (
    <div className="settings-section">
      <h2 className="settings-title">Voicemail greeting</h2>
      <p className="settings-blurb">
        Record or upload a personal voicemail greeting that callers hear
        before leaving a message.
      </p>
      <div
        style={{
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 12,
          padding: '1rem 1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Mic size={18} style={{ color: '#f59e0b' }} />
          <strong>Coming soon</strong>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Telnyx&apos;s Hosted Voicemail service uses the default greeting
          for now. We&apos;re working on a per-user greeting flow that won&apos;t
          interfere with the live inbound-call path.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          In the meantime, callers reach a generic &quot;please leave a
          message&quot; prompt and the recording shows up in your Voicemail
          tab as usual.
        </p>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Call Forwarding â€” per-user, Pulse-pattern feature.
// Forwards inbound calls to a backup number (e.g. your cell) either always
// or only on no-answer. The Save button hits our API which provisions Telnyx
// (PATCH /v2/phone_numbers/{id}/voice â†’ call_forwarding block).
// ---------------------------------------------------------------------------
function CallForwardingSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [number, setNumber] = useState('');
  const [mode, setMode] = useState<'always' | 'on_failure'>('on_failure');
  const [savedStatus, setSavedStatus] = useState<string | null>(null);

  // Load current settings.
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    let cancelled = false;
    getCallForwarding(token)
      .then((s: CallForwardingSettings) => {
        if (cancelled) return;
        setEnabled(s.enabled);
        setNumber(s.number ?? '');
        setMode((s.mode as 'always' | 'on_failure') ?? 'on_failure');
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    setSaving(true);
    setSavedStatus(null);
    try {
      const trimmed = number.replace(/[^\d+]/g, '');
      if (enabled && trimmed.length < 10) {
        setError('Enter a valid phone number (10+ digits or E.164).');
        setSaving(false);
        return;
      }
      const saved = await saveCallForwarding(token, {
        enabled,
        number: enabled ? trimmed : null,
        mode: enabled ? mode : undefined,
      });
      setEnabled(saved.enabled);
      setNumber(saved.number ?? '');
      setMode((saved.mode as 'always' | 'on_failure') ?? 'on_failure');
      setSavedStatus('Saved. Telnyx is now configured.');
      setTimeout(() => setSavedStatus(null), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="settings-section"><p className="muted">Loadingâ€¦</p></div>;
  }

  return (
    <div className="settings-section">
      <h2 className="settings-title">Call forwarding</h2>
      <p className="settings-blurb">
        Forward inbound calls to a backup number when you're offline or always.
        Useful for routing to your cell when you're away from the dialer.
      </p>

      <div className="settings-row" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <label className="toggle-switch" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <span>Enable call forwarding</span>
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 420, opacity: enabled ? 1 : 0.5 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="muted small">Forward to (E.164, e.g. +13125550199)</span>
          <input
            type="tel"
            className="cred-input"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="+1 312 555 0199"
            disabled={!enabled}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        </label>

        <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <span className="muted small">When to forward</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="cf-mode"
              value="on_failure"
              checked={mode === 'on_failure'}
              onChange={() => setMode('on_failure')}
              disabled={!enabled}
            />
            <span>Only when I don't answer <span className="muted small">(recommended â€” voicemail still works)</span></span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="radio"
              name="cf-mode"
              value="always"
              checked={mode === 'always'}
              onChange={() => setMode('always')}
              disabled={!enabled}
            />
            <span>Always â€” every call goes to the forward number</span>
          </label>
        </fieldset>
      </div>

      {error && <p className="error" style={{ marginTop: '0.75rem' }}>{error}</p>}
      {savedStatus && <p className="muted small" style={{ marginTop: '0.75rem', color: '#34c759' }}>{savedStatus}</p>}

      <div style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="device-action primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Savingâ€¦' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data â€” backup/restore of localStorage preferences
// Exports every ace_* key as a JSON file. Importing the file restores them
// (overwriting current values). Useful when switching devices.
// ---------------------------------------------------------------------------
function DataSection() {
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function collectPrefs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('ace_')) continue;
      // Sensitive: skip Telnyx password from the backup file by default.
      if (k === 'ace_sip_password') continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }

  function exportPrefs() {
    const prefs = collectPrefs();
    const payload = {
      app: 'ace-dialer',
      exportedAt: new Date().toISOString(),
      version: 1,
      prefs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ace-dialer-prefs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus(`Exported ${Object.keys(prefs).length} settings.`);
    setTimeout(() => setStatus(null), 3000);
  }

  function triggerImport() {
    fileRef.current?.click();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Importing will overwrite your current preferences. Continue?')) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const parsed = JSON.parse(text);
        const prefs = parsed?.prefs;
        if (!prefs || typeof prefs !== 'object') {
          setStatus('That doesnâ€™t look like an ACE Dialer backup file.');
          return;
        }
        let n = 0;
        for (const [k, v] of Object.entries(prefs)) {
          if (typeof v === 'string' && k.startsWith('ace_')) {
            localStorage.setItem(k, v);
            n += 1;
          }
        }
        // Notify other components that prefs changed.
        window.dispatchEvent(new CustomEvent('ace:quickRepliesChanged'));
        window.dispatchEvent(new CustomEvent('ace:notificationPrefsChanged'));
        window.dispatchEvent(new CustomEvent('ace:themeChanged'));
        setStatus(`Restored ${n} settings. Reloadingâ€¦`);
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        setStatus((err as Error).message);
      }
    };
    reader.onerror = () => setStatus('Failed to read file.');
    reader.readAsText(file);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Back up your preferences (notification prefs, quick replies, theme,
        audio device choices) to a JSON file. Restore them on another device
        by importing the same file. Your SIP password is excluded for
        security.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      <div className="device-actions">
        <button type="button" className="device-action primary" onClick={exportPrefs}>
          <Download size={14} /> Export preferences
        </button>
        <button type="button" className="device-action" onClick={triggerImport}>
          <Upload size={14} /> Import preferences
        </button>
      </div>

      {status && <p className="muted small" style={{ marginTop: '0.6rem' }}>{status}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared device list
// ---------------------------------------------------------------------------
function DeviceList({
  devices,
  selected,
  onPick,
  disabled,
}: {
  devices: AudioDevice[];
  selected: string;
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  if (devices.length === 0) return <p className="muted">No devices found.</p>;
  return (
    <div className="device-list">
      {devices.map((d) => (
        <button
          key={d.deviceId}
          type="button"
          className={`device-row ${selected === d.deviceId ? 'selected' : ''}`}
          onClick={() => onPick(d.deviceId)}
          disabled={disabled}
        >
          <span className="device-label">{d.label}</span>
          {selected === d.deviceId && <Check size={18} />}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications section
// ---------------------------------------------------------------------------
function NotificationsSection() {
  const [prefs, setPrefsLocal] = useState<NotificationPrefs>(() => getNotificationPrefs());

  function update(partial: Partial<NotificationPrefs>) {
    const next = setNotificationPrefs(partial);
    setPrefsLocal(next);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Control how the dialer notifies you about incoming calls and SMS.
        These preferences are stored on this device only.
      </p>

      <div className="pref-list">
        <PrefToggle
          label="In-app banner for incoming calls"
          description="Shows the full-screen ring UI when a call comes in."
          checked={prefs.inAppToast}
          onChange={(v) => update({ inAppToast: v })}
        />
        <PrefToggle
          label="Ringtone"
          description="Play a synth ringtone on incoming calls."
          checked={prefs.ringtone}
          onChange={(v) => update({ ringtone: v })}
        />
        <div className={`pref-row ${prefs.ringtone ? '' : 'disabled'}`}>
          <div className="pref-text">
            <div className="pref-label">Ringtone volume</div>
            <div className="pref-desc">{Math.round(prefs.ringtoneVolume * 100)}%</div>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.ringtoneVolume}
            onChange={(e) => update({ ringtoneVolume: Number(e.target.value) })}
            disabled={!prefs.ringtone}
            style={{ flex: 1, marginLeft: '1rem', maxWidth: 200 }}
          />
        </div>
        <PrefToggle
          label="Desktop notification when minimized"
          description="OS-level popup when the app window is hidden."
          checked={prefs.desktopNotification}
          onChange={(v) => update({ desktopNotification: v })}
        />
        <PrefToggle
          label="New SMS notification"
          description="Toast + sound when an inbound message arrives."
          checked={prefs.smsNotification}
          onChange={(v) => update({ smsNotification: v })}
        />
      </div>
    </div>
  );
}

function PrefToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pref-row">
      <div className="pref-text">
        <div className="pref-label">{label}</div>
        {description && <div className="pref-desc">{description}</div>}
      </div>
      <label className="pref-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="pref-slider" />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick replies section (editable SMS templates)
// ---------------------------------------------------------------------------
function QuickRepliesSection() {
  const [replies, setReplies] = useState<string[]>(() => getQuickReplies());
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');

  function add() {
    const v = draft.trim();
    if (!v) return;
    const next = [...replies, v];
    setReplies(next);
    setQuickReplies(next);
    setDraft('');
  }

  function remove(idx: number) {
    const next = replies.filter((_, i) => i !== idx);
    setReplies(next);
    setQuickReplies(next);
    if (editingIndex === idx) setEditingIndex(null);
  }

  function startEdit(idx: number) {
    setEditingIndex(idx);
    setEditingValue(replies[idx]);
  }

  function saveEdit() {
    if (editingIndex === null) return;
    const v = editingValue.trim();
    if (!v) {
      remove(editingIndex);
      setEditingIndex(null);
      return;
    }
    const next = [...replies];
    next[editingIndex] = v;
    setReplies(next);
    setQuickReplies(next);
    setEditingIndex(null);
  }

  function move(idx: number, delta: number) {
    const target = idx + delta;
    if (target < 0 || target >= replies.length) return;
    const next = [...replies];
    [next[idx], next[target]] = [next[target], next[idx]];
    setReplies(next);
    setQuickReplies(next);
  }

  function resetToDefaults() {
    if (!confirm('Replace your quick replies with the defaults?')) return;
    resetQuickReplies();
    setReplies(DEFAULT_QUICK_REPLIES);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Preset messages you can send with one tap from any conversation.
        Stored on this device only.
      </p>

      <ul className="quick-reply-list">
        {replies.length === 0 && (
          <li className="muted small" style={{ padding: '0.5rem 0' }}>
            No quick replies yet. Add one below.
          </li>
        )}
        {replies.map((r, idx) => (
          <li key={`${idx}-${r}`} className="quick-reply-item">
            <span
              className="quick-reply-handle"
              aria-label="Reorder"
              title="Drag to reorder (or use the arrow buttons)"
            >
              <GripVertical size={14} />
            </span>
            {editingIndex === idx ? (
              <>
                <input
                  className="quick-reply-input"
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditingIndex(null);
                  }}
                  autoFocus
                />
                <button type="button" className="device-action primary" onClick={saveEdit}>
                  Save
                </button>
                <button
                  type="button"
                  className="device-action"
                  onClick={() => setEditingIndex(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="quick-reply-text" onClick={() => startEdit(idx)}>
                  {r}
                </span>
                <div className="quick-reply-actions">
                  <button
                    type="button"
                    className="quick-reply-action"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    aria-label="Move up"
                    title="Move up"
                  >
                    â†‘
                  </button>
                  <button
                    type="button"
                    className="quick-reply-action"
                    onClick={() => move(idx, 1)}
                    disabled={idx === replies.length - 1}
                    aria-label="Move down"
                    title="Move down"
                  >
                    â†“
                  </button>
                  <button
                    type="button"
                    className="quick-reply-action danger"
                    onClick={() => remove(idx)}
                    aria-label="Delete"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="quick-reply-add">
        <input
          className="quick-reply-input"
          placeholder="Add a new quick replyâ€¦"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          maxLength={320}
        />
        <button
          type="button"
          className="device-action primary"
          onClick={add}
          disabled={!draft.trim()}
        >
          <Plus size={14} /> Add
        </button>
      </div>

      <div className="device-actions" style={{ marginTop: '1.2rem' }}>
        <button type="button" className="device-action" onClick={resetToDefaults}>
          <RotateCcw size={14} /> Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocked Numbers â€” per-user blocklist of inbound phone numbers.
// Calls from blocked numbers are hung up at the Telnyx layer (the webhook
// handler issues a hangup via Call Control); SMS is silently dropped before
// being stored. Both behaviors are server-side â€” closing the dialer doesn't
// affect them. The list is editable from this Settings section; entries can
// also be added by hitting "Block" on a row in Recents or in a Messages
// thread header.
// ---------------------------------------------------------------------------
function BlockedNumbersSection() {
  const [items, setItems] = useState<BlockedNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draftNumber, setDraftNumber] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    let cancelled = false;
    getBlockedNumbers(token)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleAdd() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const trimmed = draftNumber.replace(/[^\d+]/g, '');
    if (trimmed.length < 10) {
      setError('Enter at least 10 digits (or E.164 like +14155551234).');
      return;
    }
    setError(null);
    setAdding(true);
    try {
      const row = await addBlockedNumber(token, {
        number: trimmed,
        reason: draftReason.trim() || undefined,
      });
      // Upsert into the local list â€” if the same number was already there
      // (the API upserts), we replace the existing row.
      setItems((prev) => {
        const filtered = prev.filter((r) => r.id !== row.id);
        return [row, ...filtered];
      });
      setDraftNumber('');
      setDraftReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: number) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!confirm('Unblock this number? Future calls and SMS from it will reach you again.')) return;
    setError(null);
    try {
      await removeBlockedNumber(token, id);
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) {
    return <div className="settings-section"><p className="muted">Loadingâ€¦</p></div>;
  }

  return (
    <div className="settings-section">
      <h2 className="settings-title">Blocked numbers</h2>
      <p className="settings-blurb">
        Calls from these numbers are rejected at the carrier and never ring
        the dialer. Text messages from these numbers are silently dropped â€”
        they never appear in your inbox and you get no notification.
      </p>

      {/* Add form */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <input
          type="tel"
          className="quick-reply-input"
          style={{ flex: '1 1 180px', minWidth: 160 }}
          placeholder="Number (e.g. +14155551234)"
          value={draftNumber}
          onChange={(e) => setDraftNumber(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          maxLength={20}
        />
        <input
          type="text"
          className="quick-reply-input"
          style={{ flex: '1 1 180px', minWidth: 160 }}
          placeholder="Reason (optional: 'spam', 'ex', etc.)"
          value={draftReason}
          onChange={(e) => setDraftReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          maxLength={200}
        />
        <button
          type="button"
          className="device-action primary"
          onClick={() => void handleAdd()}
          disabled={adding || !draftNumber.trim()}
        >
          {adding ? 'Blockingâ€¦' : (<><Plus size={14} /> Block</>)}
        </button>
      </div>

      {error && <p className="error" style={{ marginBottom: '0.75rem' }}>{error}</p>}

      {/* List */}
      {items.length === 0 ? (
        <p className="muted small">
          No blocked numbers yet. Add one above, or hit "Block" on any call
          in Recents / message thread.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((row) => (
            <li
              key={row.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.75rem',
                borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{row.number}</div>
                {row.reason && (
                  <div className="muted small" style={{ marginTop: 2 }}>
                    {row.reason}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="device-action danger"
                onClick={() => void handleRemove(row.id)}
                title="Unblock this number"
              >
                <Trash2 size={14} /> Unblock
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Note: blocked status is enforced server-side, so it works even when
        your dialer is closed. SMS senders won't see any error â€” the message
        appears delivered to them but is dropped before reaching you.
      </p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Phase 6.13 â€” Admin Users panel
//
// Lists every user in the org, lets admins invite new users, and exposes
// promote / demote / deactivate / reactivate / reset-password actions in a
// per-row kebab menu. All mutations write an AuditLog entry on the server.
// Safeguards (server-enforced too, but mirrored here for UX feedback):
//   - Can't change YOUR OWN admin flag.
//   - Can't deactivate yourself.
//   - Can't demote the last remaining active admin.
// ---------------------------------------------------------------------------
function UsersAdminSection() {
  const [me, setMe] = useState<{ id: number; isAdmin: boolean } | null>(null);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAutoProvision, setShowAutoProvision] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // v0.9.8 — Hard-delete modal target. null = closed.
  const [hardDeleteTarget, setHardDeleteTarget] = useState<AdminUserRow | null>(null);
  // v0.9.9 — Hide deactivated users by default (so "delete" feels like
  // delete even when FK constraints force soft-deactivate). Admin can
  // toggle to see the full list.
  const [showInactive, setShowInactive] = useState(false);

  function load() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.all([
      getMe(token).then((u) => ({ id: u.id, isAdmin: u.isAdmin })),
      listAdminUsers(token),
    ])
      .then(([whoami, users]) => {
        setMe(whoami);
        setRows(users);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  // Close the kebab menu when the user clicks elsewhere.
  useEffect(() => {
    if (openMenuId === null) return;
    const handler = () => setOpenMenuId(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [openMenuId]);

  if (loading && rows.length === 0) {
    return <div className="muted">Loading usersâ€¦</div>;
  }
  if (error && !me?.isAdmin) {
    return (
      <div className="admin-empty">
        <ShieldCheck size={28} style={{ opacity: 0.5, marginBottom: 8 }} />
        <p><strong>Admin access required</strong></p>
        <p className="muted small">Ask an admin to grant you the role.</p>
      </div>
    );
  }
  if (me && !me.isAdmin) {
    return (
      <div className="admin-empty">
        <ShieldCheck size={28} style={{ opacity: 0.5, marginBottom: 8 }} />
        <p><strong>Admin access required</strong></p>
        <p className="muted small">Ask an admin to grant you the role.</p>
      </div>
    );
  }

  const activeAdminCount = rows.filter((r) => r.isAdmin && r.isActive).length;

  // Client-side search (matches name, email, DID) + hide-inactive filter.
  // v0.9.9: hide deactivated users by default. Soft-deactivated rows from
  // a failed hard-delete were leaking into this list and confusing admins.
  const filtered = rows.filter((r) => {
    if (!showInactive && !r.isActive) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').toLowerCase();
    if (name.includes(q)) return true;
    if (r.email.toLowerCase().includes(q)) return true;
    if ((r.didNumber ?? '').toLowerCase().includes(q)) return true;
    return false;
  });
  const inactiveCount = rows.filter((r) => !r.isActive).length;

  async function handlePatch(id: number, input: Parameters<typeof updateAdminUser>[2]) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    try {
      const updated = await updateAdminUser(token, id, input);
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    }
  }

  function rowName(r: AdminUserRow): string {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
    return name || r.email;
  }

  return (
    <div className="users-admin">
      <div className="users-admin-header">
        <div>
          <h3 style={{ margin: 0 }}>Users ({rows.length})</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {activeAdminCount} admin{activeAdminCount === 1 ? '' : 's'} Â·{' '}
            {rows.filter((r) => r.isActive).length} active
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="device-action"
            onClick={() => setShowImport(true)}
            title="Upload a CSV to bulk-create users"
          >
            <Upload size={14} /> Import CSV
          </button>
          <button
            type="button"
            className="device-action"
            onClick={() => setShowInvite(true)}
            title="Add a user with pre-existing SIP credentials (you paste them)"
          >
            <UserPlus size={14} /> Add manually
          </button>
          <button
            type="button"
            className="device-action primary"
            onClick={() => setShowAutoProvision(true)}
            title="Brand-new hire: ACE buys a Telnyx DID, creates SIP creds, sends welcome email"
          >
            <UserPlus size={14} /> Invite new user
          </button>
        </div>
      </div>

      <div className="search-bar" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          type="search"
          className="search-input"
          placeholder="Search by name, email, or DID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        {inactiveCount > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              style={{ margin: 0 }}
            />
            Show {inactiveCount} deactivated
          </label>
        )}
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <table className="users-admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>DID</th>
            <th>Last sign-in</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const isSelf = me?.id === r.id;
            const lastDemoteWouldStrand =
              r.isAdmin && r.isActive && activeAdminCount === 1;
            const lastDeactivateWouldStrand =
              r.isAdmin && r.isActive && activeAdminCount === 1;
            return (
              <tr key={r.id} className={r.isActive ? '' : 'inactive'}>
                <td>
                  <div className="users-admin-name">
                    <span className="users-admin-avatar" aria-hidden="true">
                      {(r.firstName?.[0] ?? r.email[0] ?? '?').toUpperCase()}
                    </span>
                    <div>
                      <div>{rowName(r)}</div>
                      <div className="muted small">{r.provider === 'local' ? 'Local password' : 'Microsoft SSO'}</div>
                    </div>
                  </div>
                </td>
                <td className="users-admin-email">{r.email}</td>
                <td>
                  <span className={`role-pill ${r.isAdmin ? 'admin' : 'user'}`}>
                    {r.isAdmin ? 'Admin' : 'User'}
                  </span>
                </td>
                <td>
                  <span className={`status-pill ${r.isActive ? 'active' : 'inactive'}`}>
                    {r.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="muted small">{r.didNumber || 'â€”'}</td>
                <td className="muted small">
                  {r.lastLoginAt
                    ? new Date(r.lastLoginAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                    : 'Never'}
                </td>
                <td className="users-admin-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="More actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === r.id ? null : r.id);
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {openMenuId === r.id && (
                    <div
                      className="users-admin-menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Promote / Demote */}
                      <button
                        type="button"
                        disabled={isSelf || (r.isAdmin && lastDemoteWouldStrand)}
                        title={
                          isSelf
                            ? "You can't change your own role"
                            : r.isAdmin && lastDemoteWouldStrand
                              ? "Promote someone else first â€” this is the only active admin"
                              : ''
                        }
                        onClick={() => {
                          setOpenMenuId(null);
                          if (!confirm(`${r.isAdmin ? 'Demote' : 'Promote'} ${rowName(r)}?`)) return;
                          void handlePatch(r.id, { isAdmin: !r.isAdmin });
                        }}
                      >
                        <ShieldCheck size={14} />
                        {r.isAdmin ? 'Demote to user' : 'Promote to admin'}
                      </button>

                      {/* Deactivate / Reactivate */}
                      <button
                        type="button"
                        disabled={
                          isSelf ||
                          (r.isActive && r.isAdmin && lastDeactivateWouldStrand)
                        }
                        title={
                          isSelf
                            ? "You can't deactivate your own account"
                            : r.isActive && lastDeactivateWouldStrand
                              ? "Promote someone else first â€” this is the only active admin"
                              : ''
                        }
                        onClick={() => {
                          setOpenMenuId(null);
                          const verb = r.isActive ? 'Deactivate' : 'Reactivate';
                          if (!confirm(`${verb} ${rowName(r)}?`)) return;
                          void handlePatch(r.id, { isActive: !r.isActive });
                        }}
                      >
                        <Power size={14} />
                        {r.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>

                      {/* v0.9.8 — Hard delete: full cleanup (DID + Telnyx connection +
                          User row + linked pending invite). FK-fall-back to soft deactivate
                          if call/SMS history blocks the delete. */}
                      <button
                        type="button"
                        disabled={
                          isSelf ||
                          (r.isAdmin && r.isActive && lastDeactivateWouldStrand)
                        }
                        title={
                          isSelf
                            ? "You can't delete your own account"
                            : r.isAdmin && r.isActive && lastDeactivateWouldStrand
                              ? "Promote someone else first — this is the only active admin"
                              : 'Full cleanup: un-assign DID, delete Telnyx connection, delete User row'
                        }
                        onClick={() => {
                          setOpenMenuId(null);
                          setHardDeleteTarget(r);
                        }}
                      >
                        <Trash2 size={14} />
                        Hard delete
                      </button>

                      {/* Set SIP password â€” for users imported without a password */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          const next = prompt(
                            `Paste ${rowName(r)}'s SIP password from Telnyx Portal. (They can't make calls until this is set.)`,
                            '',
                          );
                          if (next === null) return; // cancelled
                          if (!next.trim()) return; // empty = no-op
                          void handlePatch(r.id, { sipPassword: next.trim() });
                        }}
                      >
                        <FileText size={14} />
                        Set SIP password (Telnyx)
                      </button>

                      {/* Reset local password (for break-glass accounts) */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          const next = prompt(
                            `Set a new local password for ${rowName(r)}. (Leave blank to clear and force SSO only.)`,
                            '',
                          );
                          if (next === null) return; // cancelled
                          void handlePatch(r.id, {
                            localPassword: next.trim() ? next.trim() : null,
                          });
                        }}
                      >
                        <KeyRound size={14} />
                        Set / reset local password
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={7} className="muted small" style={{ padding: '1rem', textAlign: 'center' }}>No users match.</td></tr>
          )}
        </tbody>
      </table>

      {showInvite && (
        <InviteUserModal
          onClose={() => setShowInvite(false)}
          onCreated={(row) => {
            setRows((prev) => [row, ...prev]);
            setShowInvite(false);
          }}
        />
      )}

      {showImport && (
        <BulkImportModal
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            load(); // refresh the table
          }}
        />
      )}

      {showAutoProvision && (
        <AutoProvisionUserModal
          onClose={() => setShowAutoProvision(false)}
          onDone={() => {
            setShowAutoProvision(false);
            load(); // refresh the table after a real provision
          }}
        />
      )}

      {hardDeleteTarget && (
        <HardDeleteUserModal
          target={hardDeleteTarget}
          onClose={() => setHardDeleteTarget(null)}
          onDone={() => {
            setHardDeleteTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────── Hard Delete User Modal (v0.9.8) ────────────────────
//
// Replicates the DELETE-confirmation pattern from PendingUsersSection.
// Two-step: must type "DELETE" before the destructive button arms. Shows
// the result steps from the backend (deletedHard true = full cleanup,
// false = soft-deactivate fallback because of FK constraints).
function HardDeleteUserModal({
  target,
  onClose,
  onDone,
}: {
  target: AdminUserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteUserHardResult | null>(null);
  const canDelete = confirmText === 'DELETE';
  const niceDid = target.didNumber ? formatPhone(target.didNumber) : null;
  const niceName =
    [target.firstName, target.lastName].filter(Boolean).join(' ').trim() || target.email;

  async function doDelete() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setDeleting(true);
    setErr(null);
    try {
      const r = await deleteUserHard(token, target.id);
      setResult(r);
      if (!r.ok && r.error) setErr(r.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={deleting ? undefined : onClose}>
      <div className="modal pending-delete-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Hard delete {target.email}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={result ? onDone : onClose}
            disabled={deleting}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          {!result ? (
            <>
              <p>
                This will permanently remove <strong>{niceName}</strong> from ACE and Telnyx:
              </p>
              <ul className="pending-delete-bullets">
                {niceDid ? (
                  <li>Un-assign DID <strong>{niceDid}</strong> back to inventory</li>
                ) : (
                  <li>No DID on this user — skip DID step</li>
                )}
                <li>Delete the SIP credential connection (Telnyx)</li>
                <li>Delete the User row <strong>#{target.id}</strong></li>
                <li>Delete any linked staged invite (Pending Users row)</li>
              </ul>
              <p className="pending-delete-warn">
                If this user has call, SMS, or voicemail history, Postgres FK constraints
                will block the User delete — we'll fall back to <strong>soft deactivation</strong>{' '}
                (isActive=false, SIP creds + DID cleared) and surface a warning here.
              </p>
              <p style={{ marginTop: '0.75rem', fontSize: '0.88rem' }}>
                Type <code>DELETE</code> to confirm:
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="pending-delete-confirm-input"
                placeholder="DELETE"
                autoFocus
              />
            </>
          ) : (
            <>
              <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
                {result.deletedHard
                  ? `User ${target.email} fully removed.`
                  : `User ${target.email} was soft-deactivated.`}
              </p>
              {!result.deletedHard && (
                <p className="pending-delete-warn">
                  {result.message}
                </p>
              )}
              {result.steps && result.steps.length > 0 && (
                <ul style={{ margin: '0 0 0 0', paddingLeft: 20, fontSize: 14 }}>
                  {result.steps.map((s, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      {s.ok ? '✓' : '✗'} {s.step}
                      {s.error && (
                        <span className="muted small" style={{ marginLeft: 6 }}>
                          — {s.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {err && (
            <div className="pending-error" style={{ marginTop: '0.75rem' }}>
              <AlertCircle size={14} /> {err}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          {!result ? (
            <>
              <button
                type="button"
                className="settings-btn-secondary"
                onClick={onClose}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-btn pending-delete-confirm-btn"
                onClick={() => void doDelete()}
                disabled={!canDelete || deleting}
              >
                {deleting ? (
                  <><Loader2 size={14} className="spin" /> Deleting…</>
                ) : (
                  <><Trash2 size={14} /> Delete &amp; clean up</>
                )}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="settings-btn"
              onClick={onDone}
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ─────────────────── Auto-provision brand-new user ────────────────────
// Used when admin adds someone who was NEVER on Pulse — a brand-new hire.
// Backend purchases a Telnyx DID, creates SIP creds, binds messaging, sends
// the welcome email, all in one POST. Modal shows per-step result table.
function AutoProvisionUserModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [didMode, setDidMode] = useState<'new' | 'unassigned'>('new');
  const [areaCode, setAreaCode] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InviteNewUserResult | null>(null);

  // Lazy-load the unassigned-numbers list the first time the admin picks
  // the 'unassigned' radio. Avoids a Telnyx round-trip if they never use it.
  const [unassigned, setUnassigned] = useState<UnassignedTelnyxNumber[] | null>(null);
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  const [unassignedErr, setUnassignedErr] = useState<string | null>(null);
  const [pickedUnassignedDid, setPickedUnassignedDid] = useState<string>('');

  useEffect(() => {
    if (didMode !== 'unassigned' || unassigned !== null || unassignedLoading) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setUnassignedLoading(true);
    setUnassignedErr(null);
    listUnassignedTelnyxNumbers(token)
      .then((items) => {
        setUnassigned(items);
        if (items.length > 0) setPickedUnassignedDid(items[0].phoneNumber);
      })
      .catch((e) => setUnassignedErr(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setUnassignedLoading(false));
  }, [didMode, unassigned, unassignedLoading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!email.trim()) return;
    if (didMode === 'unassigned' && !pickedUnassignedDid) {
      setResult({ ok: false, error: 'Pick an unassigned number from the dropdown first.' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const r = await inviteNewUserAutoProvision(token, {
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        didMode,
        newDidAreaCode: didMode === 'new' && areaCode.trim() ? areaCode.trim() : undefined,
        unassignedDidNumber: didMode === 'unassigned' ? pickedUnassignedDid : undefined,
        isAdmin: makeAdmin,
        sendEmail,
      });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
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
        aria-labelledby="auto-provision-title"
        style={{ maxWidth: 560 }}
      >
        <div className="fav-modal-header">
          <UserPlus size={18} className="fav-modal-icon" />
          <h3 id="auto-provision-title">Invite a brand-new user</h3>
        </div>

        {!result && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              For someone who was <strong>never on Pulse</strong>. ACE will buy a Telnyx DID, create SIP credentials, bind the messaging profile, and email the user — all in one click. <strong>This spends money on Telnyx (~$0.45 setup + $0.45/mo per number).</strong>
            </p>

            <form onSubmit={handleSubmit} autoComplete="off">
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">Work email *</span>
                <input
                  type="email"
                  className="fav-modal-input"
                  placeholder="firstname.lastname@aptask.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              </label>
              <div className="fav-modal-row">
                <label className="fav-modal-field">
                  <span className="fav-modal-label">First name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </label>
                <label className="fav-modal-field">
                  <span className="fav-modal-label">Last name</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </label>
              </div>
              {/* Phone number — purchase new OR pick from unassigned ACE inventory */}
              <fieldset className="fav-modal-field" style={{ marginTop: 12, border: 'none', padding: 0 }}>
                <legend className="fav-modal-label" style={{ marginBottom: 6 }}>Phone number</legend>

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
                  <input
                    type="radio"
                    name="autoProvisionDidMode"
                    checked={didMode === 'new'}
                    onChange={() => setDidMode('new')}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <strong>Purchase a new DID</strong>
                    <div className="muted small">
                      Telnyx buys a fresh local US number (~$0.45 setup + $0.45/mo).
                    </div>
                    {didMode === 'new' && (
                      <div style={{ marginTop: 6 }}>
                        <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          Area code:
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="\d{3}"
                            maxLength={3}
                            className="fav-modal-input"
                            placeholder="732"
                            value={areaCode}
                            onChange={(e) => setAreaCode(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                            style={{ maxWidth: 90 }}
                          />
                          <span>(defaults to 732)</span>
                        </label>
                      </div>
                    )}
                  </span>
                </label>

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="radio"
                    name="autoProvisionDidMode"
                    checked={didMode === 'unassigned'}
                    onChange={() => setDidMode('unassigned')}
                    style={{ marginTop: 4 }}
                  />
                  <span style={{ flex: 1 }}>
                    <strong>Use an ACE number you already own</strong>
                    <div className="muted small">
                      Pick from numbers already in your Telnyx account that aren't routed anywhere. $0.
                    </div>
                    {didMode === 'unassigned' && (
                      <div style={{ marginTop: 6 }}>
                        {unassignedLoading && (
                          <span className="muted small">Loading unassigned numbers…</span>
                        )}
                        {unassignedErr && (
                          <span className="muted small" style={{ color: '#d70015' }}>
                            {unassignedErr}
                          </span>
                        )}
                        {unassigned && unassigned.length === 0 && !unassignedLoading && (
                          <span className="muted small">
                            No unassigned numbers found in your Telnyx account. Pick "Purchase a new DID" instead.
                          </span>
                        )}
                        {unassigned && unassigned.length > 0 && (
                          <>
                            <select
                              value={pickedUnassignedDid}
                              onChange={(e) => setPickedUnassignedDid(e.target.value)}
                              className="fav-modal-input"
                              // colorScheme tells the browser to render the
                              // native dropdown panel using OS dark/light mode,
                              // which fixes the white-on-white option list bug.
                              style={{ maxWidth: 320, colorScheme: 'light dark' }}
                            >
                              {unassigned.map((n) => (
                                <option
                                  key={n.id}
                                  value={n.phoneNumber}
                                  // Belt and suspenders: explicit option colors
                                  // for browsers that don't respect colorScheme
                                  // on <option> elements.
                                  style={{ color: '#1a1a1a', background: '#fff' }}
                                >
                                  {n.phoneNumber}
                                  {n.regionLabel ? ` — ${n.regionLabel}` : ''}
                                  {n.areaCode ? ` (${n.areaCode})` : ''}
                                </option>
                              ))}
                            </select>
                            <div className="muted small" style={{ marginTop: 4 }}>
                              {unassigned.length} available
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </span>
                </label>
              </fieldset>

              {/* Don't use .fav-modal-field here — it forces flex-column which
                  stacks the checkbox above the label. Use plain inline flex. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={makeAdmin}
                  onChange={(e) => setMakeAdmin(e.target.checked)}
                  style={{ margin: 0 }}
                />
                <span>Grant admin role</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  style={{ margin: 0 }}
                />
                <span>Send welcome email after provisioning</span>
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button type="button" className="device-action" onClick={onClose} disabled={submitting}>
                  Cancel
                </button>
                <button type="submit" className="device-action primary" disabled={submitting || !email.trim()}>
                  {submitting ? 'Provisioning…' : 'Provision now'}
                </button>
              </div>
            </form>
          </>
        )}

        {result && (
          <div style={{ marginTop: 4 }}>
            <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
              {result.ok
                ? `✅ User provisioned successfully${result.didNumber ? ' — ' + result.didNumber : ''}`
                : `❌ Provisioning failed: ${result.error ?? 'unknown error'}`}
            </p>

            {result.steps && result.steps.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
                {result.steps.map((s, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    {s.ok ? '✓' : '✗'} {s.step}
                    {s.error && <span className="muted small" style={{ marginLeft: 6 }}>— {s.error}</span>}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="device-action primary" onClick={onDone}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InviteUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (u: AdminUserRow) => void;
}) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [didNumber, setDidNumber] = useState('');
  const [sipUsername, setSipUsername] = useState('');
  const [sipPassword, setSipPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [localPassword, setLocalPassword] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const row = await inviteAdminUser(token, {
        email: email.trim(),
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        didNumber: didNumber.trim() || null,
        sipUsername: sipUsername.trim() || null,
        sipPassword: sipPassword || null,
        isAdmin,
        localPassword: localPassword || null,
      });
      onCreated(row);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="compose-modal" onClick={onClose}>
      <div className="fav-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="invite-title" style={{ maxWidth: 520 }}>
        <div className="fav-modal-header">
          <UserPlus size={18} className="fav-modal-icon" />
          <h3 id="invite-title">Invite user</h3>
        </div>

        <p className="muted small" style={{ marginTop: 0 }}>
          By default the user signs in with Microsoft and binds via their email on first sign-in. SIP credentials & DID are optional â€” paste them if you already provisioned in Telnyx.
        </p>

        <form onSubmit={handleSubmit} autoComplete="off">
          <label className="fav-modal-field" style={{ marginBottom: 8 }}>
            <span className="fav-modal-label">Work email *</span>
            <input
              type="email"
              className="fav-modal-input"
              placeholder="firstname@aptask.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </label>

          <div className="fav-modal-row">
            <label className="fav-modal-field">
              <span className="fav-modal-label">First name</span>
              <input
                type="text"
                className="fav-modal-input"
                placeholder="Optional"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </label>
            <label className="fav-modal-field">
              <span className="fav-modal-label">Last name</span>
              <input
                type="text"
                className="fav-modal-input"
                placeholder="Optional"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            <span>Invite as admin</span>
          </label>

          <button
            type="button"
            className="device-action"
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ marginTop: 12 }}
          >
            {showAdvanced ? 'â–¼' : 'â–¶'} Advanced (Telnyx creds, local password)
          </button>

          {showAdvanced && (
            <div className="invite-advanced">
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">DID (phone number)</span>
                <input
                  type="tel"
                  className="fav-modal-input"
                  placeholder="+17325551234"
                  value={didNumber}
                  onChange={(e) => setDidNumber(e.target.value)}
                />
              </label>
              <div className="fav-modal-row">
                <label className="fav-modal-field">
                  <span className="fav-modal-label">SIP username</span>
                  <input
                    type="text"
                    className="fav-modal-input"
                    placeholder="user...something"
                    value={sipUsername}
                    onChange={(e) => setSipUsername(e.target.value)}
                  />
                </label>
                <label className="fav-modal-field">
                  <span className="fav-modal-label">SIP password</span>
                  <input
                    type="password"
                    className="fav-modal-input"
                    placeholder="From Telnyx Portal"
                    value={sipPassword}
                    onChange={(e) => setSipPassword(e.target.value)}
                  />
                </label>
              </div>
              <label className="fav-modal-field" style={{ marginTop: 8 }}>
                <span className="fav-modal-label">
                  Local password (break-glass, bypasses SSO)
                </span>
                <input
                  type="password"
                  className="fav-modal-input"
                  placeholder="Leave empty for SSO-only"
                  value={localPassword}
                  onChange={(e) => setLocalPassword(e.target.value)}
                />
              </label>
            </div>
          )}

          {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

          <div className="fav-modal-actions">
            <button type="button" className="fav-modal-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="fav-modal-save" disabled={submitting}>
              {submitting ? 'Invitingâ€¦' : 'Send invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 6.13 â€” Audit log
//
// Read-only feed of recent admin actions. Cursor-paginated (500 max per
// page; default 100). Renders a friendly summary per row plus the raw
// metadata in an expanded panel for debugging.
// ---------------------------------------------------------------------------
function AuditLogSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function loadPage(cursor?: number) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    setError(null);
    listAuditLogs(token, { limit: 100, cursor })
      .then((page) => {
        setEntries((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
    loadPage();
  }, []);

  if (me && !me.isAdmin) {
    return (
      <div className="admin-empty">
        <ShieldCheck size={28} style={{ opacity: 0.5, marginBottom: 8 }} />
        <p><strong>Admin access required</strong></p>
        <p className="muted small">Ask an admin to grant you the role.</p>
      </div>
    );
  }

  function actionLabel(action: string): string {
    switch (action) {
      case 'user.invited': return 'invited';
      case 'user.promoted': return 'promoted';
      case 'user.demoted': return 'demoted';
      case 'user.activated': return 'reactivated';
      case 'user.deactivated': return 'deactivated';
      case 'user.password_reset': return 'reset password for';
      case 'user.updated': return 'updated';
      case 'user.sso_first_signin': return 'first SSO sign-in for';
      default: return action;
    }
  }

  function partyName(p: AuditLogEntry['actor'] | AuditLogEntry['target']): string {
    if (!p) return 'system';
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
    return name || p.email;
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="audit-log">
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {entries.length === 0 && !loading && (
        <div className="muted">No audit entries yet.</div>
      )}

      <ul className="audit-log-list">
        {entries.map((e) => (
          <li key={e.id} className="audit-log-row">
            <div className="audit-log-row-main" onClick={() => toggleExpand(e.id)}>
              <div className="audit-log-when">
                {new Date(e.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
              <div className="audit-log-summary">
                <strong>{partyName(e.actor)}</strong>{' '}
                <span className="muted">{actionLabel(e.action)}</span>
                {e.target && (
                  <>
                    {' '}<strong>{partyName(e.target)}</strong>
                  </>
                )}
              </div>
              <ChevronRight
                size={14}
                className="audit-log-chev"
                style={{
                  transform: expanded.has(e.id) ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s ease',
                }}
              />
            </div>
            {expanded.has(e.id) && (
              <pre className="audit-log-meta">
                {JSON.stringify(e.metadata, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>

      {nextCursor && (
        <button
          type="button"
          className="device-action"
          onClick={() => loadPage(nextCursor)}
          disabled={loading}
          style={{ marginTop: 12 }}
        >
          {loading ? 'Loadingâ€¦' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 5 (#189) â€” BulkImportModal
//
// Two-step flow:
//   1. User picks a CSV â†’ we parse client-side + auto-run a dry-run on the
//      server to validate every row. Result table shows green/yellow/red
//      per row so the admin can spot problems BEFORE writing.
//   2. If everything looks good, click "Confirm import" â†’ real write.
//
// CSV format expected (case-sensitive header row):
//   email, firstName, lastName, sipUsername, didNumber, sipPassword, isAdmin, phoneExtension
// Only `email` is strictly required. sipPassword may be blank (user can't make
// calls until later); we surface that as a yellow warning row.
// ---------------------------------------------------------------------------
function BulkImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [csvText, setCsvText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<BulkImportRow[]>([]);
  const [preview, setPreview] = useState<BulkImportResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [committed, setCommitted] = useState<BulkImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function parseCsv(text: string): BulkImportRow[] {
    // Minimal RFC 4180-ish parser. Handles quoted fields with commas + escaped
    // double-quotes. Good enough for the well-formed CSVs Excel/Sheets emit.
    const lines: string[][] = [];
    let cur: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { cur.push(field); field = ''; continue; }
      if (ch === '\n' || ch === '\r') {
        if (field.length > 0 || cur.length > 0) { cur.push(field); lines.push(cur); cur = []; field = ''; }
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        continue;
      }
      field += ch;
    }
    if (field.length > 0 || cur.length > 0) { cur.push(field); lines.push(cur); }
    if (lines.length === 0) throw new Error('Empty CSV');

    const header = lines[0].map((h) => h.trim());
    const required = ['email'];
    for (const k of required) {
      if (!header.includes(k)) {
        throw new Error(`CSV missing required column "${k}". Expected header: email,firstName,lastName,sipUsername,didNumber,sipPassword,isAdmin,phoneExtension`);
      }
    }

    const idx = (k: string) => header.indexOf(k);
    const rows: BulkImportRow[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const r = lines[i];
      // Skip wholly-empty lines
      if (r.every((v) => !v || !v.trim())) continue;
      const get = (k: string) => {
        const j = idx(k);
        if (j === -1) return undefined;
        const v = (r[j] ?? '').trim();
        return v.length > 0 ? v : undefined;
      };
      const isAdminRaw = get('isAdmin');
      const row: BulkImportRow = {
        email: (get('email') || '').toLowerCase(),
        firstName: get('firstName') ?? null,
        lastName: get('lastName') ?? null,
        sipUsername: get('sipUsername') ?? null,
        didNumber: get('didNumber') ?? null,
        sipPassword: get('sipPassword') ?? null,
        phoneExtension: get('phoneExtension') ?? null,
        isAdmin:
          isAdminRaw === undefined
            ? null
            : isAdminRaw.toLowerCase() === 'true' || isAdminRaw === '1',
      };
      if (!row.email) continue;
      rows.push(row);
    }
    return rows;
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseError(null);
    setPreview(null);
    setCommitted(null);
    try {
      const text = await file.text();
      setCsvText(text);
      const rows = parseCsv(text);
      setParsedRows(rows);
      // Auto-trigger dry-run preview.
      const token = sessionStorage.getItem('ace_token');
      if (!token) {
        setParseError('Not signed in.');
        return;
      }
      setSubmitting(true);
      const result = await bulkImportUsers(token, rows, true /* dryRun */);
      setPreview(result);
    } catch (e) {
      setParseError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCommit() {
    const token = sessionStorage.getItem('ace_token');
    if (!token || parsedRows.length === 0) return;
    setSubmitting(true);
    try {
      const result = await bulkImportUsers(token, parsedRows, false /* commit */);
      setCommitted(result);
    } catch (e) {
      setParseError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const stats = committed?.summary ?? preview?.summary;
  const items = committed?.items ?? preview?.items ?? [];

  return (
    <div className="compose-modal" onClick={onClose}>
      <div
        className="fav-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="bulk-import-title"
        style={{ maxWidth: 760, width: '92%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="fav-modal-header">
          <Upload size={18} className="fav-modal-icon" />
          <h3 id="bulk-import-title">Import users from CSV</h3>
        </div>

        <p className="muted small" style={{ marginTop: 0 }}>
          Expected header: <code>email,firstName,lastName,sipUsername,didNumber,sipPassword,isAdmin,phoneExtension</code>.
          Rows without a SIP password will be created â€” set the password later from the kebab menu when each user is ready to migrate.
        </p>

        {!preview && !committed && (
          <div className="bulk-drop">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="device-action primary"
              onClick={() => fileRef.current?.click()}
              disabled={submitting}
            >
              <Upload size={14} /> {submitting ? 'Parsingâ€¦' : 'Choose CSV file'}
            </button>
            {fileName && <div className="muted small" style={{ marginTop: 8 }}>{fileName}</div>}
            {parseError && <div className="error" style={{ marginTop: 12 }}>{parseError}</div>}
          </div>
        )}

        {stats && (
          <div className="bulk-summary">
            <div><strong>{stats.total}</strong> rows</div>
            <div className="bulk-stat ok">{stats.created} <span>create</span></div>
            <div className="bulk-stat update">{stats.updated} <span>update</span></div>
            <div className="bulk-stat warn">{stats.missingPasswords} <span>no password</span></div>
            <div className="bulk-stat err">{stats.errors} <span>errors</span></div>
            <div className="muted small" style={{ marginLeft: 'auto' }}>
              {stats.dryRun ? 'Preview â€” nothing written yet' : 'Imported âœ“'}
            </div>
          </div>
        )}

        {items.length > 0 && (
          <div className="bulk-results">
            <table className="bulk-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Email</th>
                  <th>Action</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={`${it.row}-${it.email}`} className={`bulk-row ${it.status}`}>
                    <td>{it.row}</td>
                    <td>{it.email}</td>
                    <td>
                      <span className={`bulk-tag ${it.status}`}>{it.status}</span>
                    </td>
                    <td className="bulk-notes">
                      {it.error && <span className="bulk-err-text">{it.error}</span>}
                      {!it.error && it.missingPassword && (
                        <span className="bulk-warn-text">No SIP password â€” set later</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="fav-modal-actions" style={{ marginTop: 'auto' }}>
          {committed ? (
            <button type="button" className="fav-modal-save" onClick={onDone}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="fav-modal-cancel" onClick={onClose}>
                Cancel
              </button>
              {preview && (
                <button
                  type="button"
                  className="fav-modal-save"
                  onClick={() => void handleCommit()}
                  disabled={submitting || (preview.summary.errors > 0 && preview.summary.total === preview.summary.errors)}
                >
                  {submitting ? 'Importingâ€¦' : `Confirm import (${preview.summary.created + preview.summary.updated})`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8 (#204) â€” Live Ops Dashboard
// Auto-refreshes every 15s. Admin-only.
// ---------------------------------------------------------------------------
function LiveOpsSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<LiveOpsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
    let cancelled = false;
    async function fetchData() {
      const tok = sessionStorage.getItem('ace_token');
      if (!tok) return;
      try {
        const report = await getLiveOpsReport(tok);
        if (cancelled) return;
        setData(report);
        setLastFetched(new Date());
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchData();
    const id = window.setInterval(fetchData, 15_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (me && !me.isAdmin) {
    return (
      <div className="admin-empty">
        <ShieldCheck size={28} style={{ opacity: 0.5, marginBottom: 8 }} />
        <p><strong>Admin access required</strong></p>
        <p className="muted small">Ask an admin to grant you the role.</p>
      </div>
    );
  }
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const delta = data.calls.today.total - data.calls.yesterdayTotal;
  const deltaPct = data.calls.yesterdayTotal > 0
    ? Math.round((delta / data.calls.yesterdayTotal) * 100)
    : null;
  const peakHour = Math.max(1, ...data.calls.hourlyToday.map((h) => h.inbound + h.outbound + h.missed));

  function fmtAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function fmtPhoneLocal(n: string): string {
    if (!n) return '';
    const d = n.replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    return n;
  }

  return (
    <div className="liveops">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Live ops</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Auto-refreshes every 15s
            {lastFetched && ' Â· last updated ' + fmtAgo(lastFetched.toISOString())}
          </p>
        </div>
      </div>

      <div className="liveops-stats">
        <div className="liveops-card active">
          <div className="liveops-card-icon"><PhoneCall size={18} /></div>
          <div className="liveops-card-num">{data.calls.activeNow}</div>
          <div className="liveops-card-label">Active calls now</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-icon"><Activity size={18} /></div>
          <div className="liveops-card-num">{data.calls.today.total}</div>
          <div className="liveops-card-label">
            Calls today
            {deltaPct !== null && (
              <span className={'liveops-delta ' + (delta >= 0 ? 'up' : 'down')}>
                {delta >= 0 ? 'â†‘' : 'â†“'} {Math.abs(deltaPct)}%
              </span>
            )}
          </div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-icon"><MessageSquare size={18} /></div>
          <div className="liveops-card-num">{data.sms.today.sent + data.sms.today.received}</div>
          <div className="liveops-card-label">
            SMS today
            <span className="muted small"> Â· {data.sms.today.sent} sent / {data.sms.today.received} received</span>
          </div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-icon"><Users size={18} /></div>
          <div className="liveops-card-num">{data.users.activeLast24h}</div>
          <div className="liveops-card-label">
            Active 24h
            <span className="muted small"> Â· of {data.users.active} total</span>
          </div>
        </div>
      </div>

      <div className="liveops-breakdown">
        <div className="liveops-pill in"><PhoneIncoming size={14} /> {data.calls.today.inbound} inbound</div>
        <div className="liveops-pill out"><PhoneOutgoing size={14} /> {data.calls.today.outbound} outbound</div>
        <div className="liveops-pill missed"><PhoneMissedIcon size={14} /> {data.calls.today.missed} missed</div>
      </div>

      <div className="liveops-section-title">Calls today by hour (UTC)</div>
      <div className="liveops-chart">
        {data.calls.hourlyToday.map((h, i) => {
          const total = h.inbound + h.outbound + h.missed;
          const pct = total > 0 ? (total / peakHour) * 100 : 0;
          return (
            <div key={i} className="liveops-bar-wrap" title={i + ':00 â€” ' + h.inbound + ' in / ' + h.outbound + ' out / ' + h.missed + ' missed'}>
              <div className="liveops-bar-stack" style={{ height: pct + '%' }}>
                {h.outbound > 0 && <div className="liveops-bar-seg out" style={{ flex: h.outbound }} />}
                {h.inbound > 0 && <div className="liveops-bar-seg in" style={{ flex: h.inbound }} />}
                {h.missed > 0 && <div className="liveops-bar-seg missed" style={{ flex: h.missed }} />}
              </div>
              <div className="liveops-bar-label">{i % 3 === 0 ? i : ''}</div>
            </div>
          );
        })}
      </div>

      <div className="liveops-cols">
        <div className="liveops-col">
          <div className="liveops-section-title">Top callers today</div>
          {data.topCallers.length === 0 ? (
            <div className="muted small">No calls yet today.</div>
          ) : (
            <ol className="liveops-leaderboard">
              {data.topCallers.map((c, i) => (
                <li key={c.userId}>
                  <span className="liveops-rank">{i + 1}</span>
                  <span className="liveops-leader-name">
                    <div>{c.name}</div>
                    <div className="muted small">{c.email}</div>
                  </span>
                  <span className="liveops-leader-count">{c.callCount}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="liveops-col">
          <div className="liveops-section-title">Recent missed calls</div>
          {data.recentMissed.length === 0 ? (
            <div className="muted small">No missed calls in the last 24h.</div>
          ) : (
            <ul className="liveops-missed">
              {data.recentMissed.map((m) => (
                <li key={m.id}>
                  <span className="liveops-missed-icon"><PhoneMissedIcon size={14} /></span>
                  <span className="liveops-missed-text">
                    <div>{fmtPhoneLocal(m.fromNumber)}</div>
                    <div className="muted small">to {m.userName} Â· {fmtAgo(m.startedAt)}</div>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8 â€” Presence dashboard (#211)
// Real-time table of every active user: on_call / active / recent / idle.
// Auto-refreshes every 10s for "live agent" feel.
// ---------------------------------------------------------------------------
function PresenceSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<PresenceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'on_call' | 'active' | 'idle'>('all');

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
    let cancelled = false;
    async function fetchData() {
      const tok = sessionStorage.getItem('ace_token');
      if (!tok) return;
      try {
        const r = await getPresenceReport(tok);
        if (!cancelled) { setData(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchData();
    const id = window.setInterval(fetchData, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (me && !me.isAdmin) {
    return (
      <div className="admin-empty">
        <ShieldCheck size={28} style={{ opacity: 0.5, marginBottom: 8 }} />
        <p><strong>Admin access required</strong></p>
      </div>
    );
  }
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const filtered = data.items.filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'idle') return i.status === 'idle' || i.status === 'recent';
    return i.status === filter;
  });

  function fmtAgo(iso: string | null): string {
    if (!iso) return 'â€”';
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function fmtPhone(n: string | null | undefined): string {
    if (!n) return '';
    const d = n.replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    return n;
  }

  function fmtCallDuration(iso: string): string {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div className="presence">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Presence</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Refreshes every 10s Â· {data.items.length} users
          </p>
        </div>
        <div className="presence-filter">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All ({data.items.length})</button>
          <button className={filter === 'on_call' ? 'active' : ''} onClick={() => setFilter('on_call')}>On call ({data.counts.on_call})</button>
          <button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Active ({data.counts.active})</button>
          <button className={filter === 'idle' ? 'active' : ''} onClick={() => setFilter('idle')}>Idle ({data.counts.recent + data.counts.idle})</button>
        </div>
      </div>

      <table className="presence-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Current call</th>
            <th>Last active</th>
            <th>Today</th>
            <th>DID</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u) => (
            <tr key={u.id} className={`presence-row ${u.status}`}>
              <td>
                <div className="presence-name">
                  <span className={`presence-dot ${u.status}`} aria-hidden="true" />
                  <div>
                    <div>{u.name}</div>
                    <div className="muted small">{u.email}{u.isAdmin && ' Â· admin'}</div>
                  </div>
                </div>
              </td>
              <td>
                <span className={`presence-pill ${u.status}`}>
                  {u.status === 'on_call' ? 'On call' :
                   u.status === 'active' ? 'Active' :
                   u.status === 'recent' ? 'Recent' : 'Idle'}
                </span>
              </td>
              <td>
                {u.currentCall ? (
                  <div>
                    <div>
                      {u.currentCall.direction === 'inbound' ? 'â†˜ ' : 'â†— '}
                      {fmtPhone(u.currentCall.direction === 'inbound' ? u.currentCall.fromNumber : u.currentCall.toNumber)}
                    </div>
                    <div className="muted small">{fmtCallDuration(u.currentCall.startedAt)}</div>
                  </div>
                ) : <span className="muted small">â€”</span>}
              </td>
              <td className="muted small">{fmtAgo(u.lastActivity)}</td>
              <td className="presence-today">
                <strong>{u.todayCalls}</strong>
                <span className="muted small">
                  {' '}({u.todayBreakdown.inbound}/{u.todayBreakdown.outbound}/{u.todayBreakdown.missed})
                </span>
              </td>
              <td className="muted small">{fmtPhone(u.didNumber) || 'â€”'}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ padding: '1rem', textAlign: 'center' }}>No users in this filter.</td></tr>
          )}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 8 }}>
        Today column: <strong>total</strong> (inbound/outbound/missed). Status reflects last 10 min activity for "active", 1 hr for "recent".
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8 â€” Usage report (#205)
// Per-user leaderboard + daily volume chart.
// ---------------------------------------------------------------------------
function UsageSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<UsageReport | null>(null);
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
  }, []);

  useEffect(() => {
    const tok = sessionStorage.getItem('ace_token');
    if (!tok) return;
    setLoading(true);
    getUsageReport(tok, range)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);

  if (me && !me.isAdmin) {
    return <div className="admin-empty"><ShieldCheck size={28} /><p><strong>Admin access required</strong></p></div>;
  }
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const peakDay = Math.max(1, ...data.byDay.map((d) => d.inbound + d.outbound + d.missed));

  function fmtTalk(sec: number): string {
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  return (
    <div className="usage">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Usage</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>Per-user volume + talk time</p>
        </div>
        <div className="presence-filter">
          <button className={range === 'today' ? 'active' : ''} onClick={() => setRange('today')}>Today</button>
          <button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>7 days</button>
          <button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>30 days</button>
        </div>
      </div>

      <div className="liveops-section-title">Calls per day</div>
      <div className="usage-chart">
        {data.byDay.map((d) => {
          const total = d.inbound + d.outbound + d.missed;
          const pct = total > 0 ? (total / peakDay) * 100 : 0;
          return (
            <div key={d.date} className="liveops-bar-wrap" title={`${d.date} â€” ${d.inbound} in / ${d.outbound} out / ${d.missed} missed`}>
              <div className="liveops-bar-stack" style={{ height: pct + '%' }}>
                {d.outbound > 0 && <div className="liveops-bar-seg out" style={{ flex: d.outbound }} />}
                {d.inbound > 0 && <div className="liveops-bar-seg in" style={{ flex: d.inbound }} />}
                {d.missed > 0 && <div className="liveops-bar-seg missed" style={{ flex: d.missed }} />}
              </div>
              <div className="liveops-bar-label">{d.date.slice(5)}</div>
            </div>
          );
        })}
      </div>

      <div className="liveops-section-title">Top users by call volume</div>
      <table className="presence-table">
        <thead>
          <tr><th>#</th><th>User</th><th>Total</th><th>In</th><th>Out</th><th>Missed</th><th>Talk time</th><th>SMS sent/recv</th></tr>
        </thead>
        <tbody>
          {data.byUser.slice(0, 25).map((u, i) => (
            <tr key={u.userId}>
              <td><span className="liveops-rank">{i + 1}</span></td>
              <td>
                <div>{u.name}</div>
                <div className="muted small">{u.email}</div>
              </td>
              <td><strong>{u.totalCalls}</strong></td>
              <td>{u.inbound}</td>
              <td>{u.outbound}</td>
              <td>{u.missed}</td>
              <td>{fmtTalk(u.talkSeconds)}</td>
              <td className="muted small">{u.smsSent} / {u.smsReceived}</td>
            </tr>
          ))}
          {data.byUser.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: '1rem', textAlign: 'center' }}>No activity in this range.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8 â€” Quality report (#206)
// Missed-rate per user + hangup-cause breakdown + peak-hours heatmap.
// ---------------------------------------------------------------------------
function QualitySection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<QualityReport | null>(null);
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
  }, []);

  useEffect(() => {
    const tok = sessionStorage.getItem('ace_token');
    if (!tok) return;
    setLoading(true);
    getQualityReport(tok, range)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);

  if (me && !me.isAdmin) {
    return <div className="admin-empty"><ShieldCheck size={28} /><p><strong>Admin access required</strong></p></div>;
  }
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const peakHeat = Math.max(1, ...data.heatmap.flat());
  const totalHangup = data.hangupCauses.reduce((s, h) => s + h.count, 0);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="quality">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Quality &amp; health</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {data.totals.totalCalls} total calls Â· {data.totals.shortCalls} under 10s
          </p>
        </div>
        <div className="presence-filter">
          <button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>7 days</button>
          <button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>30 days</button>
        </div>
      </div>

      <div className="liveops-cols">
        <div className="liveops-col">
          <div className="liveops-section-title">Highest missed-call rate</div>
          {data.missedRateByUser.length === 0 ? (
            <div className="muted small">Not enough inbound traffic yet.</div>
          ) : (
            <table className="presence-table">
              <thead><tr><th>User</th><th>Missed%</th><th>Missed/Answered</th><th>Short&lt;10s</th></tr></thead>
              <tbody>
                {data.missedRateByUser.map((r) => (
                  <tr key={r.userId}>
                    <td>
                      <div>{r.name}</div>
                      <div className="muted small">{r.email}</div>
                    </td>
                    <td><strong style={{ color: r.missedRate > 0.3 ? '#ff6b6b' : r.missedRate > 0.1 ? '#ff9500' : '#34c759' }}>{Math.round(r.missedRate * 100)}%</strong></td>
                    <td className="muted small">{r.missed} / {r.answered}</td>
                    <td className="muted small">{r.shortCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="liveops-col">
          <div className="liveops-section-title">Hangup causes</div>
          {data.hangupCauses.length === 0 ? (
            <div className="muted small">No hangup causes recorded.</div>
          ) : (
            <ul className="hangup-list">
              {data.hangupCauses.slice(0, 12).map((h) => {
                const pct = totalHangup > 0 ? (h.count / totalHangup) * 100 : 0;
                return (
                  <li key={h.cause}>
                    <div className="hangup-row">
                      <span className="hangup-name">{h.cause}</span>
                      <span className="hangup-count">{h.count}</span>
                    </div>
                    <div className="hangup-bar"><div style={{ width: pct + '%' }} /></div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="liveops-section-title" style={{ marginTop: 24 }}>Peak hours heatmap (UTC, last {range})</div>
      <div className="heatmap">
        <div className="heatmap-corner" />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="heatmap-col-label">{h % 3 === 0 ? h : ''}</div>
        ))}
        {days.map((day, d) => (
          <React.Fragment key={day}>
            <div className="heatmap-row-label">{day}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data.heatmap[d][h];
              const intensity = peakHeat > 0 ? v / peakHeat : 0;
              return (
                <div key={h} className="heatmap-cell" style={{ background: `rgba(10, 132, 255, ${0.05 + intensity * 0.85})` }} title={`${day} ${h}:00 â€” ${v} calls`} />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.1 â€” Cost report (#207)
// ---------------------------------------------------------------------------
function CostSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<CostReport | null>(null);
  const [range, setRange] = useState<'7d' | '30d'>('30d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (token) void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
  }, []);

  useEffect(() => {
    const tok = sessionStorage.getItem('ace_token');
    if (!tok) return;
    setLoading(true);
    getCostReport(tok, range)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);

  if (me && !me.isAdmin) return <div className="admin-empty"><ShieldCheck size={28} /><p><strong>Admin access required</strong></p></div>;
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const fmtMoney = (n: number) => '$' + n.toFixed(2);

  return (
    <div className="cost">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Cost</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Telnyx voice + SMS + DID rental. Pricing tunable via API env vars.
          </p>
        </div>
        <div className="presence-filter">
          <button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>7 days</button>
          <button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>30 days</button>
        </div>
      </div>

      <div className="liveops-stats">
        <div className="liveops-card active">
          <div className="liveops-card-num">{fmtMoney(data.totals.projectedMonthly)}</div>
          <div className="liveops-card-label">Projected monthly</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{fmtMoney(data.totals.voiceCost)}</div>
          <div className="liveops-card-label">Voice ({range})</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{fmtMoney(data.totals.smsCost)}</div>
          <div className="liveops-card-label">SMS ({range})</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{fmtMoney(data.totals.didRentalMonthly)}</div>
          <div className="liveops-card-label">{data.totals.activeDids} DIDs Ã— ${data.pricing.didMonthly}/mo</div>
        </div>
      </div>

      <div className="liveops-cols">
        <div className="liveops-col">
          <div className="liveops-section-title">Top spenders</div>
          <table className="presence-table">
            <thead><tr><th>User</th><th>In min</th><th>Out min</th><th>SMS</th><th>Total</th></tr></thead>
            <tbody>
              {data.byUser.slice(0, 20).map((u) => (
                <tr key={u.userId}>
                  <td>
                    <div>{u.name}</div>
                    <div className="muted small">{u.didNumber || u.email}</div>
                  </td>
                  <td>{u.inboundMinutes}</td>
                  <td>{u.outboundMinutes}</td>
                  <td>{u.smsCount}</td>
                  <td><strong>{fmtMoney(u.totalCost)}</strong></td>
                </tr>
              ))}
              {data.byUser.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: '1rem' }}>No usage yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="liveops-col">
          <div className="liveops-section-title">Top DIDs by inbound minutes</div>
          <table className="presence-table">
            <thead><tr><th>DID</th><th>Inbound minutes</th></tr></thead>
            <tbody>
              {data.didMinutes.map((d) => (
                <tr key={d.did}>
                  <td className="muted small" style={{ fontVariantNumeric: 'tabular-nums' }}>{d.did}</td>
                  <td><strong>{d.minutes}</strong></td>
                </tr>
              ))}
              {data.didMinutes.length === 0 && <tr><td colSpan={2} className="muted" style={{ padding: '1rem' }}>No inbound calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>
        Defaults: ${data.pricing.inboundPerMin}/min inbound Â· ${data.pricing.outboundPerMin}/min outbound Â· ${data.pricing.perSms}/SMS Â· ${data.pricing.didMonthly}/DID/mo. Override via env: <code>TELNYX_COST_INBOUND_PER_MIN</code> etc.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.1 â€” Recruiter metrics (#208)
// ---------------------------------------------------------------------------
function RecruiterSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<RecruiterReport | null>(null);
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (token) void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
  }, []);

  useEffect(() => {
    const tok = sessionStorage.getItem('ace_token');
    if (!tok) return;
    setLoading(true);
    getRecruiterReport(tok, range)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);

  if (me && !me.isAdmin) return <div className="admin-empty"><ShieldCheck size={28} /><p><strong>Admin access required</strong></p></div>;
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  return (
    <div className="recruiter">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Recruiter metrics</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Outbound dial activity over the last {data.days} days
          </p>
        </div>
        <div className="presence-filter">
          <button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>7 days</button>
          <button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>30 days</button>
        </div>
      </div>

      <div className="liveops-stats">
        <div className="liveops-card">
          <div className="liveops-card-num">{data.team.totalDialed}</div>
          <div className="liveops-card-label">Total dials</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{Math.round(data.team.conversationRate * 100)}%</div>
          <div className="liveops-card-label">Conversation rate (&gt;30s)</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{data.team.totalUnique}</div>
          <div className="liveops-card-label">Unique numbers reached</div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-num">{data.team.activeRecruiters}</div>
          <div className="liveops-card-label">Active recruiters</div>
        </div>
      </div>

      <table className="presence-table" style={{ marginTop: 12 }}>
        <thead><tr><th>Recruiter</th><th>Dials</th><th>Unique</th><th>Avg unique/day</th><th>Connected &gt;30s</th><th>Conv rate</th></tr></thead>
        <tbody>
          {data.byUser.map((u) => {
            const rate = Math.round(u.conversationRate * 100);
            const color = rate >= 30 ? '#34c759' : rate >= 15 ? '#ff9500' : '#ff6b6b';
            return (
              <tr key={u.userId}>
                <td>
                  <div>{u.name}</div>
                  <div className="muted small">{u.email}</div>
                </td>
                <td><strong>{u.totalDialed}</strong></td>
                <td>{u.uniqueNumbers}</td>
                <td>{u.avgUniquePerDay}</td>
                <td>{u.connectedOver30s}</td>
                <td><strong style={{ color }}>{rate}%</strong></td>
              </tr>
            );
          })}
          {data.byUser.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: '1rem', textAlign: 'center' }}>No outbound activity in this range.</td></tr>}
        </tbody>
      </table>

      <p className="muted small" style={{ marginTop: 12 }}>
        <strong>Conversation rate</strong> = % of outbound calls that connected for more than 30 seconds. <strong>Avg unique/day</strong> = distinct phone numbers dialed on days the recruiter was active.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.1 â€” Health alerts (#210)
// Polls every 60s. No cron yet â€” admin refreshes the page to recompute.
// ---------------------------------------------------------------------------
function AlertsSection() {
  const [me, setMe] = useState<{ isAdmin: boolean } | null>(null);
  const [data, setData] = useState<AlertsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (token) void getMe(token).then((u) => setMe({ isAdmin: u.isAdmin })).catch(() => undefined);
    let cancelled = false;
    async function fetchData() {
      const tok = sessionStorage.getItem('ace_token');
      if (!tok) return;
      try {
        const r = await getAlertsReport(tok);
        if (!cancelled) { setData(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchData();
    const id = window.setInterval(fetchData, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (me && !me.isAdmin) return <div className="admin-empty"><ShieldCheck size={28} /><p><strong>Admin access required</strong></p></div>;
  if (loading && !data) return <div className="muted">Loadingâ€¦</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const sevIcon = (s: string) => s === 'critical' ? <Siren size={16} /> : s === 'warn' ? <AlertTriangle size={16} /> : <Activity size={16} />;

  return (
    <div className="alerts">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Health alerts</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Refreshes every 60s Â· {data.alerts.length} alerts active
          </p>
        </div>
      </div>

      <div className="liveops-breakdown">
        <div className="liveops-pill missed">ðŸ”´ {data.counts.critical} critical</div>
        <div className="liveops-pill out" style={{ background: 'rgba(255,149,0,0.16)', color: '#ff9500' }}>âš ï¸ {data.counts.warn} warnings</div>
        <div className="liveops-pill in" style={{ background: 'rgba(118,118,128,0.16)', color: 'var(--text-muted)' }}>â„¹ï¸ {data.counts.info} info</div>
      </div>

      {data.alerts.length === 0 ? (
        <div className="admin-empty">
          <p>ðŸŽ‰ <strong>All clear.</strong></p>
          <p className="muted small">No anomalies detected right now.</p>
        </div>
      ) : (
        <ul className="alerts-list">
          {data.alerts.map((a, i) => (
            <li key={i} className={`alert-row ${a.severity}`}>
              <span className="alert-icon">{sevIcon(a.severity)}</span>
              <div className="alert-text">
                <div className="alert-message">{a.message}</div>
                {a.userName && <div className="muted small">{a.userName} Â· {a.userEmail}</div>}
              </div>
              <span className={`alert-tag ${a.severity}`}>{a.severity}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small" style={{ marginTop: 14 }}>
        Alert types: <strong>user.idle_7d</strong> (no activity 7 days), <strong>missed.spike</strong> (today &gt; 1.5Ã— 7-day avg), <strong>did.inactive_14d</strong> (no inbound 14 days).
      </p>
    </div>
  );
}
