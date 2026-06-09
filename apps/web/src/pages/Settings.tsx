import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  // v0.10.26 — What's new section
  Sparkles,
  Wrench,
  Zap,
  // v0.10.80 — Diagnostics section icon
  Stethoscope,
} from 'lucide-react';
import { WHATS_NEW, type ChangeType } from '../data/whatsNew';
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
  migrateUserFromPulse,
  type MigrateFromPulseResult,
  refreshUserFromPulse,
  type RefreshFromPulseResult,
  bulkRefreshPulseSms,
  type BulkRefreshPulseSmsResult,
  getTenantHoldMusic,
  setTenantHoldMusic,
  clearTenantHoldMusic,
  listAdminSmsTemplates,
  createSmsTemplate,
  updateSmsTemplate,
  archiveSmsTemplate,
  seedSmsTemplateDefaults,
  type SmsTemplate,
  listAdminBlockedNumbers,
  adminRemoveBlockedNumber,
  type AdminBlockedNumber,
  // v0.10.74 — Admin Praise / Announcements.
  listAdminPraises,
  createPraise,
  deletePraise,
  type Praise,
  // v0.10.92 — Feature Tips admin management.
  listAdminTips,
  createTip,
  updateTip,
  deleteTip,
  type AdminTip,
  // v0.10.76 — Admin-uploaded ringtones.
  listMyRingtones,
  listAdminRingtones,
  createRingtone,
  updateRingtone,
  deleteRingtone,
  type UploadedRingtone,
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
  // v0.10.97 — Custom voicemail greeting API helpers.
  getVoicemailGreeting,
  uploadVoicemailGreeting,
  deleteVoicemailGreeting,
  setVoicemailGreetingText,
  setVoicemailGreetingMode,
  migrateUserToCallControlVoicemail,
  rollbackUserFromCallControlVoicemail,
  getVoicemailMigrationStatus,
  getUserDevices,
  requestDeviceForceUpdate,
  type UserDeviceRow,
  type VoicemailGreeting,
  type VoicemailGreetingMode,
  type VoicemailMigrationStatus,
  type VoicemailMigrationResponse,
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
  // v0.10.22 — MS Graph Teams connection
  getMsGraphStatus,
  initiateMsGraphConnect,
  disconnectMsGraph,
  type MsGraphStatus,
} from '../api';
// v0.10.75 — Ringtone picker uses the synthesized ringtone engine.
import { ringtone, getRingtonePresets, type RingtoneSlug } from '../services/ringtone';
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
// v0.10.63 — PendingUsersSection import removed alongside its registry entry.
// The component file remains in the repo for now in case the workflow ever
// gets re-exposed; nothing references it after this change.
// import PendingUsersSection from '../components/PendingUsersSection';
import UserLinesManagerModal from '../components/UserLinesManagerModal';
import TeamsNotificationsSection from '../components/TeamsNotificationsSection';
// v0.10.79 — per-user email notification opt-ins (parallel to Teams).
import EmailNotificationsSection from '../components/EmailNotificationsSection';
// v0.10.80 — diagnostics export (download all in-memory logs since app start).
import DiagnosticsSection from '../components/DiagnosticsSection';

// v0.10.91 — NotificationsHubSection. Wraps EmailNotificationsSection and
// TeamsNotificationsSection in a single Settings entry with sub-tabs.
// Previously these were two separate sidebar entries which made the
// notification surface area harder to navigate as users would only see
// one or the other and assume the missing channel didn't exist. Now
// "Notifications" is one entry; the two channels are tabs inside.
function NotificationsHubSection() {
  const [tab, setTab] = useState<'email' | 'teams'>('email');
  const tabBtn = (id: 'email' | 'teams', label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`notif-tab ${tab === id ? 'active' : ''}`}
      style={{
        padding: '8px 18px',
        border: 'none',
        background: tab === id ? 'var(--bg-soft, #f1f5f9)' : 'transparent',
        borderBottom: tab === id ? '2px solid #0a84ff' : '2px solid transparent',
        fontWeight: tab === id ? 600 : 500,
        fontSize: 14,
        cursor: 'pointer',
        color: tab === id ? 'var(--text, #0f172a)' : 'var(--text-muted, #64748b)',
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="notifications-hub">
      <div
        className="notif-tab-bar"
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border, #e2e8f0)',
          marginBottom: 16,
        }}
      >
        {tabBtn('email', 'Email')}
        {tabBtn('teams', 'Teams')}
      </div>
      {tab === 'email' ? <EmailNotificationsSection /> : <TeamsNotificationsSection />}
    </div>
  );
}
import { formatPhone } from '../lib/phone';

interface AudioDevice {
  deviceId: string;
  label: string;
}

type SectionCategory = 'Personal' | 'Calling' | 'Reports' | 'Admin' | 'About';

interface SectionDef {
  key: string;
  category: SectionCategory;
  label: string;
  icon: typeof Mic;
  blurb: string;
  Component: React.FC;
  // v0.10.11 — hide this section entirely from non-admin users.
  // - Telnyx: SIP credentials, security risk if a user edits/screenshots
  // - Data: backup/restore, power-user feature
  // - Cost / Live ops / Presence: fleet-view reports that don't translate
  //   to per-user scope (Cost = billing info, Live + Presence = cross-user)
  // - Admin category: every section in it is admin-only (already filtered
  //   by category in SettingsNav, but adminOnly:true on the def is the
  //   canonical signal for the main route filter too)
  adminOnly?: boolean;
}

const SECTIONS: SectionDef[] = [
  // v0.10.100 — What's new moved to the new 'About' category so it always
  // appears at the bottom of the sidebar for both admins and regular users.
  { key: 'whats-new', category: 'About', label: 'What\'s new', icon: Sparkles, blurb: 'Recent updates + bug fixes', Component: WhatsNewSection },
  { key: 'account', category: 'Personal', label: 'Account', icon: UserCircle, blurb: 'Name, DID, SIP', Component: AccountSection },
  { key: 'appearance', category: 'Personal', label: 'Appearance', icon: Palette, blurb: 'Light / dark / system', Component: AppearanceSection },
  // v0.10.91 — removed the "Telnyx" SIP credential entry (TelnyxSection).
  // That UI was a leftover from the early days when users manually entered
  // their Telnyx SIP credentials into a localStorage field. Today every
  // user gets auto-provisioned credentials via the admin invite / migrate
  // flow; the dialer reads them from sessionStorage (populated by /auth/me)
  // and the manual-entry form was unused but visible to confused admins.
  // The TelnyxSection function and its associated CSS still exist below
  // in case we ever need a manual override path again — they're just
  // not surfaced in the Settings nav.
  { key: 'microphone', category: 'Calling', label: 'Microphone', icon: Mic, blurb: 'Input device', Component: MicrophoneSection },
  { key: 'speaker', category: 'Calling', label: 'Speaker', icon: Volume2, blurb: 'Output device', Component: SpeakerSection },
  // v0.10.91 — Renamed from "Notifications" to "Sound & alerts" so the
  // sidebar doesn't have two entries titled "Notifications". This one
  // controls in-app sound + desktop popup behavior (per-device). The new
  // "Notifications" entry (NotificationsHubSection) is for external
  // notification channels (Email + Teams).
  { key: 'notifications', category: 'Personal', label: 'Sound & alerts', icon: Bell, blurb: 'In-app ringer sound + desktop popups', Component: NotificationsSection },
  // v0.10.75 — Per-user ringtone preference.
  { key: 'ringtone', category: 'Personal', label: 'Ringtone', icon: Bell, blurb: 'Pick the sound your incoming calls play', Component: RingtoneSection },
  // v0.10.91 — Notifications. Single Settings entry that contains both
  // Email and Teams configurations as tabs inside. Replaces the two
  // separate entries that used to live in the sidebar; same underlying
  // components are reused, just nested under a tabbed parent.
  { key: 'notifications-hub', category: 'Personal', label: 'Notifications', icon: Bell, blurb: 'Email and Teams alerts for missed calls, texts, and voicemails', Component: NotificationsHubSection },
  // v0.10.80 — Diagnostics. Download the in-memory log buffer when something's wrong.
  { key: 'diagnostics', category: 'Personal', label: 'Diagnostics', icon: Stethoscope, blurb: 'Download logs to share with support when you hit an issue', Component: DiagnosticsSection },
  { key: 'quick-replies', category: 'Personal', label: 'Quick replies', icon: MessageSquare, blurb: 'SMS templates', Component: QuickRepliesSection },
  { key: 'hold-music', category: 'Calling', label: 'Hold music', icon: Music, blurb: 'Play music when on hold', Component: HoldMusicSection },
  { key: 'voicemail-greeting', category: 'Calling', label: 'Voicemail greeting', icon: Mic, blurb: 'Upload a custom greeting callers hear', Component: VoicemailGreetingSection },
  { key: 'call-forwarding', category: 'Calling', label: 'Call forwarding', icon: PhoneForwarded, blurb: 'Forward calls to another number', Component: CallForwardingSection },
  { key: 'blocked-numbers', category: 'Calling', label: 'Blocked numbers', icon: ShieldOff, blurb: 'Reject calls & SMS from specific numbers', Component: BlockedNumbersSection },
  { key: 'data', category: 'Personal', label: 'Data', icon: Database, blurb: 'Backup & restore', Component: DataSection, adminOnly: true },
  // v0.10.11 — Reports.
  // All 7 marked adminOnly for now. Per-user self-views for Usage /
  // Quality / Recruiter / Alerts are planned as a follow-up commit
  // — backend /me/reports/* endpoints + frontend section updates land
  // together to avoid misleading users with section labels that don't
  // match what the page actually shows.
  { key: 'live-ops', category: 'Reports', label: 'Live ops', icon: Activity, blurb: 'Real-time dashboard (admin only)', Component: LiveOpsSection, adminOnly: true },
  { key: 'presence', category: 'Reports', label: 'Presence', icon: Radio, blurb: 'Who is on call right now (admin only)', Component: PresenceSection, adminOnly: true },
  { key: 'usage', category: 'Reports', label: 'Usage', icon: TrendingUp, blurb: 'Per-user volume + talk time (admin only)', Component: UsageSection, adminOnly: true },
  { key: 'quality', category: 'Reports', label: 'Quality', icon: AlertTriangle, blurb: 'Missed rate + hangup causes (admin only)', Component: QualitySection, adminOnly: true },
  { key: 'cost', category: 'Reports', label: 'Cost', icon: DollarSign, blurb: 'Telnyx spend per user + projection (admin only)', Component: CostSection, adminOnly: true },
  { key: 'recruiter', category: 'Reports', label: 'Recruiter', icon: Target, blurb: 'Reach + conversation rate (admin only)', Component: RecruiterSection, adminOnly: true },
  { key: 'alerts', category: 'Reports', label: 'Alerts', icon: Siren, blurb: 'Health & anomaly alerts (admin only)', Component: AlertsSection, adminOnly: true },
  { key: 'users', category: 'Admin', label: 'Users', icon: Users, blurb: 'Invite, promote, deactivate (admin only)', Component: UsersAdminSection, adminOnly: true },
  // v0.10.52 — Tenant SMS templates (admin only).
  { key: 'sms-templates', category: 'Admin', label: 'SMS templates', icon: MessageSquare, blurb: 'Curate the recruiter SMS playbook for all users', Component: SmsTemplatesAdminSection, adminOnly: true },
  // v0.10.74 — Admin Praise / Announcements.
  // v0.10.93 — Repurposed from "Send praise" into a full Broadcast tool.
  // Same underlying flow (PraiseAdminSection function + Praise DB model)
  // but now covers celebrations, announcements, alerts, reminders, and
  // welcomes — all the things admin needs to communicate to the fleet.
  { key: 'praise', category: 'Admin', label: 'Broadcast', icon: Sparkles, blurb: 'Send announcements, alerts, reminders, welcomes, or celebrations — one user or broadcast to everyone', Component: PraiseAdminSection, adminOnly: true },
  // v0.10.92 — Feature tips admin. Toggle built-in tips on/off and add custom ones.
  { key: 'tips-admin', category: 'Admin', label: 'Feature tips', icon: Sparkles, blurb: 'Curate the rotating tips shown to users on every screen', Component: TipsAdminSection, adminOnly: true },
  // v0.10.76 — Admin-uploaded ringtones (tenant-wide library).
  { key: 'ringtones-admin', category: 'Admin', label: 'Ringtones', icon: Bell, blurb: 'Upload custom ringtones — every user can pick from the list', Component: RingtonesAdminSection, adminOnly: true },
  // v0.10.51 — Admin view of all users' blocked numbers + override.
  { key: 'blocked-admin', category: 'Admin', label: 'Blocked numbers (all users)', icon: ShieldOff, blurb: 'See who blocked which numbers and why; override blocks', Component: BlockedNumbersAdminSection, adminOnly: true },
  // v0.10.63 — Pending Users section removed. The bulk-stage-then-invite
  // workflow it implemented is no longer needed now that "Migrate from
  // Pulse" handles the standard one-user-at-a-time onboarding. The backend
  // endpoints + pending_users table are retained for any orphaned data and
  // can be re-exposed later if a bulk-import use case re-emerges.
  { key: 'audit-log', category: 'Admin', label: 'Audit log', icon: ScrollText, blurb: 'Recent admin actions (admin only)', Component: AuditLogSection, adminOnly: true },
  // v0.10.22 — Tenant-wide MS Graph connection for Teams notifications.
  { key: 'teams-connection', category: 'Admin', label: 'Teams connection', icon: MessageSquare, blurb: 'Connect ACE Bot to Microsoft Teams (admin only)', Component: TeamsConnectionSection, adminOnly: true },
];

// v0.10.100 — 'About' category sits at the very bottom for both admins
// and non-admins. Currently houses only "What's new" so users always know
// where to find the release notes regardless of which section they were
// last on.
const SECTION_CATEGORIES: SectionCategory[] = ['Personal', 'Calling', 'Reports', 'Admin', 'About'];

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
        // v0.10.11 — also filter individual adminOnly sections within other
        // categories (e.g., Telnyx in Calling, Cost / Live ops / Presence
        // in Reports, Data in Personal). Non-admins see only what's safe
        // for them to touch.
        const items = SECTIONS.filter((sec) => {
          if (sec.category !== cat) return false;
          if (sec.adminOnly && !isAdmin) return false;
          return true;
        });
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

  // v0.10.11 — Resolve isAdmin once per mount so the main route can
  // refuse direct URL access to admin-only sections (e.g., a user
  // typing /settings/telnyx). The nav already hides these, but this
  // covers paste-the-URL access. We default to null while loading so
  // we DON'T pre-emptively redirect before we know.
  const [routeIsAdmin, setRouteIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) {
      setRouteIsAdmin(false);
      return;
    }
    let cancelled = false;
    getMe(token)
      .then((u) => { if (!cancelled) setRouteIsAdmin(!!u.isAdmin); })
      .catch(() => { if (!cancelled) setRouteIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);

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
  // v0.10.11 — Block direct URL access to admin-only sections for
  // non-admins. We wait until we know isAdmin (null = still loading)
  // before deciding so we don't redirect on first paint before getMe
  // resolves. While loading: render a brief placeholder. Once known:
  // either render the section (admin or section is open) or redirect.
  if (active.adminOnly && routeIsAdmin === false) {
    return <Navigate to={`/settings/${DEFAULT_SECTION}`} replace />;
  }
  if (active.adminOnly && routeIsAdmin === null) {
    return <div className="settings-loading muted" style={{ padding: '2rem' }}>Loading…</div>;
  }
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
// Account — name, email (read-only), DID, SIP username
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
    return <div className="settings-section">{error ?? 'Loading…'}</div>;
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Your profile info. The DID + SIP username route inbound calls and SMS
        to your account — set these to match your Telnyx setup.
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
          {saving ? 'Saving…' : saved ? 'âœ“ Saved' : 'Save changes'}
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
          {saving ? 'Reconnecting…' : 'Save & reconnect'}
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
  // v0.10.21 — User-controlled noise suppression. Default OFF (preserves the
  // legacy behavior where Chrome's RNNoise was producing "tunnel/pipe" voice
  // artifacts on some headsets). Users in noisy environments (cafes, open
  // offices, India home setups with AC + traffic) can toggle ON.
  // Read at every getUserMedia call via buildAudioConstraints() in sip.ts.
  const [noiseSuppression, setNoiseSuppression] = useState<boolean>(
    localStorage.getItem('ace_noise_suppression') === 'true',
  );

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

  function toggleNoiseSuppression(on: boolean) {
    setNoiseSuppression(on);
    localStorage.setItem('ace_noise_suppression', on ? 'true' : 'false');
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

      {/* v0.10.21 — Noise suppression toggle. Affects all future calls; an
          in-progress call must be reconnected to pick up the new setting. */}
      <div style={{ marginTop: '1rem', padding: '0.75rem 0', borderTop: '1px solid var(--divider, rgba(128,128,128,0.2))' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={noiseSuppression}
            onChange={(e) => toggleNoiseSuppression(e.target.checked)}
            style={{ marginTop: '0.2rem' }}
          />
          <span style={{ flex: 1 }}>
            <strong>Noise suppression</strong>
            <div className="muted small" style={{ marginTop: '0.2rem' }}>
              Filters background noise (keyboard taps, AC hum, fans). Recommended
              if you're in a noisy environment. Some headsets produce a slight
              processed sound when enabled — try toggling off if your voice
              sounds muffled on the other end. Takes effect on your next call.
            </div>
          </span>
        </label>
      </div>
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
// Hold music — upload an audio file to play when a caller is on hold.
// Stored locally as a data URL (base64). The actual track-swap happens in
// sipService.startHoldMusic() / stopHoldMusic() — they replace the outgoing
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
  // v0.10.48 — Tenant-wide hold music (admin-only).
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [tenantFilename, setTenantFilename] = useState<string | null>(null);
  const [tenantBusy, setTenantBusy] = useState<'upload' | 'clear' | null>(null);
  const [tenantInfo, setTenantInfo] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    getMe(token).then((u) => {
      setIsAdmin(u.isAdmin);
      if (u.isAdmin) {
        // Load current tenant default so admin sees what's in place.
        getTenantHoldMusic(token).then((r) => {
          if (r.ok && r.filename) setTenantFilename(r.filename);
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, []);

  async function promoteToTenantDefault() {
    if (!dataUrl || !filename) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setTenantBusy('upload');
    setTenantInfo(null);
    const r = await setTenantHoldMusic(token, { dataUrl, filename });
    setTenantBusy(null);
    if (r.ok) {
      setTenantFilename(filename);
      setTenantInfo('Saved as tenant default. New users (and users without their own override) will inherit this on next sign-in.');
    } else {
      setError(r.error ?? 'Failed to save tenant default');
    }
  }

  async function clearTenantDefault() {
    if (!confirm('Remove the tenant-wide default hold music? Users\' own local files are not affected.')) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setTenantBusy('clear');
    setTenantInfo(null);
    const r = await clearTenantHoldMusic(token);
    setTenantBusy(null);
    if (r.ok) {
      setTenantFilename(null);
      setTenantInfo('Tenant default cleared.');
    } else {
      setError(r.error ?? 'Failed to clear tenant default');
    }
  }

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
      setError(`Too big — please use a file under ${Math.round(HOLD_MUSIC_MAX_BYTES / 1024 / 1024)} MB.`);
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
        {isAdmin
          ? <>Play music to the other party when you put a call on hold. Without this, they hear silence (which usually makes them assume the call dropped). As an admin, you can upload a file here for your own device, or use the <em>Set as tenant default</em> button below to distribute it to every user automatically.</>
          : <>Plays music to the other party when you put a call on hold. The audio file is configured by your admin and applies tenant-wide. Toggle below to enable or disable it for your own calls.</>
        }
      </p>

      <div className="pref-list">
        <div className="pref-row">
          <div className="pref-text">
            <div className="pref-label">Enable hold music</div>
            <div className="pref-desc">
              {dataUrl ? `Using: ${filename ?? 'uploaded file'}` : 'No file configured yet.'}
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

      {/* v0.10.50 — Upload / Replace / Preview / Remove are now
          admin-only. Regular users can still toggle on/off but cannot
          change the file itself; the admin's tenant default is the
          source of truth and gets auto-applied on sign-in. */}
      {isAdmin && (
        <>
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
        </>
      )}

      {error && <div className="error" style={{ marginTop: '0.6rem' }}>{error}</div>}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Note: hold music plays only while *you* are holding the other party.
        When *they* hold *you*, what you hear is up to their phone system.
      </p>

      {/* v0.10.48 — Admin-only: promote local hold music to tenant-wide
          default. Every user without their own override will inherit it
          on next sign-in. */}
      {isAdmin && (
        <div
          style={{
            marginTop: '1.5rem',
            padding: '12px 14px',
            borderRadius: 8,
            background: 'rgba(120, 100, 220, 0.08)',
            border: '1px solid rgba(120, 100, 220, 0.25)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Tenant-wide default (admin only)
          </div>
          <div className="muted small" style={{ marginBottom: 10 }}>
            {tenantFilename
              ? <>Current default: <strong>{tenantFilename}</strong>. New users (and anyone without their own override) will inherit this on sign-in.</>
              : <>No default set. Without one, new users have silent hold by default. Upload your file above, then click "Set as tenant default" to push it to everyone.</>
            }
          </div>
          <div className="device-actions">
            <button
              type="button"
              className="device-action primary"
              onClick={promoteToTenantDefault}
              disabled={!dataUrl || tenantBusy !== null}
              title={!dataUrl ? 'Upload an audio file above first' : 'Save your current file as the default for all users'}
            >
              {tenantBusy === 'upload' ? 'Saving…' : 'Set as tenant default'}
            </button>
            {tenantFilename && (
              <button
                type="button"
                className="device-action danger"
                onClick={clearTenantDefault}
                disabled={tenantBusy !== null}
              >
                {tenantBusy === 'clear' ? 'Clearing…' : 'Clear tenant default'}
              </button>
            )}
          </div>
          {tenantInfo && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {tenantInfo}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voicemail greeting — parked. Telnyx Hosted Voicemail (the per-DID
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
// v0.10.97 — Voicemail greeting upload UI. Wired to the existing
// /voicemail-greeting routes that:
//   1. Accept a base64 audio upload
//   2. Store the file in Supabase Storage (publicly fetchable URL)
//   3. PATCH Telnyx /v2/phone_numbers/{id}/voicemail with greeting_audio_url
//   4. Persist the URL + filename on the User row
//
// Telnyx support recently said the greeting_audio_url field doesn't exist on
// their API, but our existing backend code targets that exact field. v0.10.97
// is the first end-to-end test: admin uploads, calls their own DID, listens
// for the custom greeting. If it plays → support was wrong, feature ships.
// If Telnyx's default plays → we pivot to a Call Control voicemail flow.
// v0.10.100 — Voicemail greeting now has TWO independent variants:
//   • "When you don't pick up" (no-answer)
//   • "When you're on another call" (busy)
// Each variant gets the same 3-tab picker (Default / Text-to-speech /
// Audio) plus a built-in microphone recorder for capturing greetings
// without leaving the app. If a user only configures the no-answer
// greeting and leaves busy unset, the webhook handler reuses the
// no-answer one for both states (no silence ever — backward-compat with
// the v0.10.99 single-greeting model).
//
// Implementation: GreetingVariantPanel is the reusable per-variant UI
// (rendered twice). MicrophoneRecorder uses the browser's MediaRecorder
// API to capture 30-sec clips and ship them straight to /voicemail-greeting/:type
// as a Blob upload.
//
// The webhook handler (apps/webhooks/src/voicemailCallControl.ts) reads
// the appropriate variant on every inbound voicemail hit and branches
// on Telnyx's hangup_cause to pick busy vs no-answer.
// v0.10.100 — Microphone recorder used by the Audio tab of each variant.
// Uses the browser's MediaRecorder API. 30-second cap with live countdown.
// Produces a Blob (audio/webm in Chrome / Electron) that the parent uploads
// straight to /voicemail-greeting/:type via uploadVoicemailGreeting().
function MicrophoneRecorder({
  onRecordingReady,
  disabled,
  maxSeconds = 30,
}: {
  onRecordingReady: (blob: Blob) => void;
  disabled?: boolean;
  maxSeconds?: number;
}) {
  const [recording, setRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(maxSeconds);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownRef = useRef<number | null>(null);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }
  function clearCountdown() {
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }
  // Cleanup on unmount — make sure we don't keep the mic open if the
  // user navigates away mid-recording.
  useEffect(() => () => { stopStream(); clearCountdown(); }, []);

  async function startRecording() {
    setMicError(null);
    setPreviewUrl(null);
    setPreviewBlob(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick a mime type the browser actually supports. Chrome / Electron:
      // webm/opus; Safari: mp4. MediaRecorder.isTypeSupported() handles it.
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        '', // browser default
      ];
      const mimeType = mimeCandidates.find((m) => !m || MediaRecorder.isTypeSupported(m)) ?? '';
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        setPreviewBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        stopStream();
        clearCountdown();
      };
      mr.start();
      setRecording(true);
      setSecondsLeft(maxSeconds);
      countdownRef.current = window.setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) {
            // Hit the cap — stop recording.
            mr.state === 'recording' && mr.stop();
            setRecording(false);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (e) {
      setMicError(
        (e as Error).message?.includes('Permission')
          ? 'Microphone permission was denied. Check your browser settings.'
          : `Couldn't access microphone: ${(e as Error).message}`,
      );
      stopStream();
      clearCountdown();
      setRecording(false);
    }
  }

  function stopRecording() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state === 'recording') mr.stop();
    setRecording(false);
  }

  function discardPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewBlob(null);
  }

  function savePreview() {
    if (!previewBlob) return;
    onRecordingReady(previewBlob);
    discardPreview();
  }

  return (
    <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-soft, #f8fafc)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {!recording && !previewUrl && (
          <button
            type="button"
            className="device-action"
            onClick={startRecording}
            disabled={disabled}
            style={{ background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}
          >
            <Mic size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Record from microphone
          </button>
        )}
        {recording && (
          <>
            <button
              type="button"
              className="device-action"
              onClick={stopRecording}
              style={{ background: '#1f2937', color: '#fff', borderColor: '#1f2937' }}
            >
              ⏹ Stop recording
            </button>
            <span className="muted small" style={{ color: '#ef4444', fontWeight: 600 }}>
              ● Recording — {secondsLeft}s left
            </span>
          </>
        )}
        {previewUrl && (
          <>
            <audio controls src={previewUrl} style={{ maxWidth: 320 }} />
            <button
              type="button"
              className="device-action"
              onClick={savePreview}
              disabled={disabled}
            >
              Save this recording
            </button>
            <button
              type="button"
              className="device-action"
              onClick={discardPreview}
              disabled={disabled}
            >
              Discard
            </button>
          </>
        )}
      </div>
      {micError && (
        <div
          className="error small"
          style={{ marginTop: 8, color: '#dc2626' }}
        >
          {micError}
        </div>
      )}
      {!recording && !previewUrl && !micError && (
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
          Records up to {maxSeconds} seconds. You&apos;ll be able to preview before saving.
        </p>
      )}
    </div>
  );
}

// v0.10.100 — One variant's worth of greeting controls (Default / TTS / Audio
// tabs). Rendered twice — once for no-answer, once for busy.
function GreetingVariantPanel({
  type,
  label,
  blurb,
  variant,
  onChanged,
}: {
  type: 'noanswer' | 'busy';
  label: string;
  blurb: string;
  variant: { url: string | null; filename: string | null; text: string | null; mode: VoicemailGreetingMode | null };
  onChanged: () => Promise<void> | void;
}) {
  const [activeTab, setActiveTab] = useState<VoicemailGreetingMode>(
    (variant.mode ?? 'default') as VoicemailGreetingMode,
  );
  const [ttsDraft, setTtsDraft] = useState(variant.text ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Re-sync local state when the parent reloads server-side data.
  useEffect(() => {
    setActiveTab((variant.mode ?? 'default') as VoicemailGreetingMode);
    setTtsDraft(variant.text ?? '');
  }, [variant.mode, variant.text]);

  const activeMode = (variant.mode ?? 'default') as VoicemailGreetingMode;
  const hasAudio = !!variant.url;
  const hasText = !!variant.text;
  const charsRemaining = 500 - ttsDraft.length;

  async function activateMode(mode: VoicemailGreetingMode) {
    setError(null);
    setOkMsg(null);
    setSubmitting(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      await setVoicemailGreetingMode(token, mode, type);
      await onChanged();
      setOkMsg(
        mode === 'default'
          ? 'Switched to the default greeting.'
          : mode === 'tts'
            ? 'Text-to-speech greeting is now active.'
            : 'Audio greeting is now active.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveTts() {
    setError(null);
    setOkMsg(null);
    const text = ttsDraft.trim();
    if (text.length === 0) { setError('Please enter some greeting text before saving.'); return; }
    if (text.length > 500) { setError(`Text is too long (${text.length} characters). Maximum is 500.`); return; }
    setSubmitting(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      await setVoicemailGreetingText(token, text, type);
      await onChanged();
      setActiveTab('tts');
      setOkMsg('Text greeting saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAudioBlobUpload(blob: Blob, filenameOverride?: string) {
    setError(null);
    setOkMsg(null);
    const MAX_BYTES = 2 * 1024 * 1024;
    if (blob.size > MAX_BYTES) {
      setError(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Max 2 MB.`);
      return;
    }
    setSubmitting(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      await uploadVoicemailGreeting(token, blob, type, filenameOverride);
      await onChanged();
      setActiveTab('audio');
      setOkMsg('Audio greeting saved.');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const MAX_BYTES = 2 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 2 MB.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    await handleAudioBlobUpload(file, file.name);
  }

  async function handleDeleteAudio() {
    if (!confirm('Remove this audio greeting?')) return;
    setError(null);
    setOkMsg(null);
    setSubmitting(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      await deleteVoicemailGreeting(token, type);
      const fallback: VoicemailGreetingMode = hasText ? 'tts' : 'default';
      await setVoicemailGreetingMode(token, fallback, type).catch(() => undefined);
      await onChanged();
      setActiveTab(fallback);
      setOkMsg('Audio greeting removed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const tabBtnStyle = (isActive: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    border: isActive ? '1px solid var(--brand, #2563eb)' : '1px solid var(--border, #e2e8f0)',
    background: isActive ? 'var(--brand, #2563eb)' : 'transparent',
    color: isActive ? '#fff' : 'inherit',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 500,
    fontSize: 12,
  });

  return (
    <div
      style={{
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 10,
        padding: 14,
        marginBottom: 16,
      }}
    >
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{label}</strong>
        <span
          className="muted small"
          style={{
            padding: '2px 8px',
            borderRadius: 6,
            background: 'rgba(37, 99, 235, 0.08)',
            color: '#2563eb',
            fontWeight: 500,
          }}
        >
          {activeMode === 'audio' && 'Audio'}
          {activeMode === 'tts' && 'Text-to-speech'}
          {activeMode === 'default' && 'Default'}
        </span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>{blurb}</p>

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" style={tabBtnStyle(activeTab === 'default')} onClick={() => setActiveTab('default')}>
          Default {activeMode === 'default' && '✓'}
        </button>
        <button type="button" style={tabBtnStyle(activeTab === 'tts')} onClick={() => setActiveTab('tts')}>
          Text-to-speech {activeMode === 'tts' && '✓'} {hasText && activeMode !== 'tts' && '•'}
        </button>
        <button type="button" style={tabBtnStyle(activeTab === 'audio')} onClick={() => setActiveTab('audio')}>
          Audio {activeMode === 'audio' && '✓'} {hasAudio && activeMode !== 'audio' && '•'}
        </button>
      </div>

      {activeTab === 'default' && (
        <div>
          <p className="muted small" style={{ marginBottom: 10 }}>
            Stock greeting using your first name. Nothing to configure.
          </p>
          {activeMode !== 'default' && (
            <button type="button" className="device-action" onClick={() => activateMode('default')} disabled={submitting}>
              Use default greeting
            </button>
          )}
        </div>
      )}

      {activeTab === 'tts' && (
        <div>
          <textarea
            value={ttsDraft}
            onChange={(e) => setTtsDraft(e.target.value.slice(0, 500))}
            placeholder={
              type === 'busy'
                ? "Hi, I'm on another call right now. Please leave a message and I'll get back to you as soon as possible."
                : "Hi, you've reached me. I can't pick up right now — please leave your name, number, and a brief message, and I'll get back to you shortly."
            }
            rows={4}
            style={{
              width: '100%',
              padding: 10,
              borderRadius: 6,
              border: '1px solid var(--border, #cbd5e1)',
              fontFamily: 'inherit',
              fontSize: 13,
              resize: 'vertical',
              minHeight: 80,
            }}
            disabled={submitting}
            maxLength={500}
          />
          <div className="muted small" style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>Max 500 characters.</span>
            <span style={{ color: charsRemaining < 50 ? '#d97706' : undefined }}>
              {charsRemaining} characters left
            </span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="device-action"
              onClick={handleSaveTts}
              disabled={submitting || ttsDraft.trim().length === 0}
            >
              {hasText ? 'Update text greeting' : 'Save text greeting'}
            </button>
            {hasText && activeMode !== 'tts' && (
              <button type="button" className="device-action" onClick={() => activateMode('tts')} disabled={submitting}>
                Make text greeting active
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === 'audio' && (
        <div>
          {hasAudio && (
            <div
              style={{
                background: 'rgba(52, 199, 89, 0.08)',
                border: '1px solid rgba(52, 199, 89, 0.3)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <div className="muted small" style={{ marginBottom: 6 }}>
                Current: <code>{variant.filename || '(unnamed)'}</code>
              </div>
              {variant.url && (
                <audio controls src={variant.url} style={{ width: '100%', maxWidth: 380 }} preload="none" />
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="device-action" onClick={handleDeleteAudio} disabled={submitting}>
                  Remove audio
                </button>
                {activeMode !== 'audio' && (
                  <button type="button" className="device-action" onClick={() => activateMode('audio')} disabled={submitting}>
                    Make audio active
                  </button>
                )}
              </div>
            </div>
          )}

          {/* v0.10.100 — In-app microphone recording. */}
          <MicrophoneRecorder
            onRecordingReady={(blob) => {
              // Default filename embeds the type + timestamp so admins can
              // see at a glance which slot it belongs to in Supabase Storage.
              const ext = (blob.type.split('/')[1] ?? 'webm').split(';')[0];
              void handleAudioBlobUpload(blob, `recording-${type}-${Date.now()}.${ext}`);
            }}
            disabled={submitting}
            maxSeconds={30}
          />

          {/* File-upload fallback. */}
          <div style={{ marginTop: 12 }}>
            <label className="fav-modal-label" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
              …or upload an existing file (MP3 / WAV / M4A / AAC / OGG, ≤ 2 MB):
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/m4a,audio/mp4,audio/ogg,audio/aac,audio/webm,.mp3,.wav,.m4a,.aac,.ogg,.webm"
              onChange={handleFileChange}
              disabled={submitting}
              style={{ fontSize: 12 }}
            />
          </div>
          {submitting && (
            <div className="muted small" style={{ marginTop: 8 }}>Saving…</div>
          )}
        </div>
      )}

      {error && (
        <div
          className="error small"
          style={{
            marginTop: 10,
            padding: '6px 10px',
            background: 'rgba(215, 0, 21, 0.08)',
            border: '1px solid rgba(215, 0, 21, 0.3)',
            borderRadius: 6,
            wordBreak: 'break-word',
            color: '#dc2626',
          }}
        >
          {error}
        </div>
      )}
      {okMsg && (
        <div
          className="muted small"
          style={{
            marginTop: 10,
            padding: '6px 10px',
            background: 'rgba(52, 199, 89, 0.08)',
            border: '1px solid rgba(52, 199, 89, 0.3)',
            borderRadius: 6,
            color: '#0a7d23',
          }}
        >
          {okMsg}
        </div>
      )}
    </div>
  );
}

function VoicemailGreetingSection() {
  const [greeting, setGreeting] = useState<VoicemailGreeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting] = useState(false);

  const reload = useCallback(async () => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const g = await getVoicemailGreeting(token);
    setGreeting(g);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  if (loading) return <div className="muted">Loading…</div>;

  const noanswer = greeting?.noanswer ?? { url: null, filename: null, text: null, mode: null };
  const busy = greeting?.busy ?? { url: null, filename: null, text: null, mode: null };
  const busyConfigured = !!(busy.url || busy.text);

  return (
    <div className="settings-section">
      <h2 className="settings-title">Voicemail greeting</h2>
      <p className="settings-blurb">
        Choose what callers hear when they reach your voicemail. You can set
        a different message for when you don’t pick up versus when you’re
        already on another call. Each greeting can be the stock default,
        text we read aloud, or your own recording — captured right here
        from your microphone or uploaded as a file.
      </p>
      {!busyConfigured && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          <em>Tip: if you only set up the &quot;not available&quot; greeting,
          we&apos;ll use it for both situations — callers never hit silence.</em>
        </p>
      )}

      <GreetingVariantPanel
        type="noanswer"
        label="When you don’t pick up"
        blurb="Plays when your softphone rings out without being answered (about 25 seconds)."
        variant={noanswer}
        onChanged={reload}
      />
      <GreetingVariantPanel
        type="busy"
        label="When you’re on another call"
        blurb="Plays when your softphone is already busy on another call and declines the new one. Leave this blank to reuse your &quot;not available&quot; greeting."
        variant={busy}
        onChanged={reload}
      />

      <details
        style={{
          marginTop: 16,
          padding: 12,
          background: 'var(--bg-soft, #f8fafc)',
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          How to verify your greetings play correctly
        </summary>
        <ol style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          <li>Save the greeting(s) you want above.</li>
          <li>From a different phone, call your ACE DID number.</li>
          <li><strong>To test the &quot;not available&quot; greeting:</strong> don’t pick up. After about 25 seconds the call falls to voicemail and you should hear your no-answer greeting.</li>
          <li><strong>To test the &quot;busy&quot; greeting:</strong> while already on a call (or with your softphone signed out), call your DID. Your busy greeting plays immediately.</li>
        </ol>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          <strong>Heads up:</strong> custom greetings only fire on DIDs that
          have been migrated to the ACE Voicemail Call Control App by an
          admin. If you hear Telnyx&apos;s default robotic message instead,
          let your admin know to run the migration for your number.
        </p>
      </details>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Call Forwarding — per-user, Pulse-pattern feature.
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
    return <div className="settings-section"><p className="muted">Loading…</p></div>;
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
            <span>Only when I don't answer <span className="muted small">(recommended — voicemail still works)</span></span>
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
            <span>Always — every call goes to the forward number</span>
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
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data — backup/restore of localStorage preferences
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
        setStatus(`Restored ${n} settings. Reloading…`);
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
// v0.10.75 — Ringtone picker section
// ---------------------------------------------------------------------------
function RingtoneSection() {
  const [selected, setSelected] = useState<string>(() => {
    return sessionStorage.getItem('ace_ringtone') || 'classic';
  });
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.10.76 — Admin-uploaded ringtones, shown at top of picker.
  const [uploaded, setUploaded] = useState<UploadedRingtone[]>([]);

  const presets = getRingtonePresets();

  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void listMyRingtones(token).then((rows) => {
      setUploaded(rows);
      // Re-warm the cache for any rows that landed.
      for (const r of rows) {
        sessionStorage.setItem(`ace_uploaded_ringtone_${r.id}`, r.dataUrl);
      }
    });
  }, []);

  function preview(slug: string) {
    // Stop whatever's playing first.
    ringtone.stop();
    setPreviewing(slug);
    // Play ~3 seconds then auto-stop. Most ringtones complete one or
    // two cycles in that window so user hears the cadence.
    ringtone.start(slug, 3500);
    window.setTimeout(() => {
      setPreviewing((p) => (p === slug ? null : p));
    }, 3600);
  }

  async function handleSelect(slug: string) {
    setError(null);
    setSelected(slug);
    // Optimistic — write sessionStorage first so a ringing call mid-save
    // already uses the new preset.
    sessionStorage.setItem('ace_ringtone', slug);
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSaving(true);
    try {
      await updateMe(token, { ringtone: slug });
    } catch (e) {
      setError(`Saved locally but couldn't sync to server: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Pick the sound that plays when someone calls you. The choice follows
        your account across devices.
      </p>

      {uploaded.length > 0 && (
        <>
          <h4 style={{ marginTop: 4, marginBottom: 8, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
            Admin uploads
          </h4>
          <ul className="ringtone-list">
            {uploaded.map((r) => {
              const slug = `upload:${r.id}`;
              return (
                <li key={r.id} className={`ringtone-row${selected === slug ? ' selected' : ''}`}>
                  <label className="ringtone-pick">
                    <input
                      type="radio"
                      name="ringtone"
                      value={slug}
                      checked={selected === slug}
                      onChange={() => void handleSelect(slug)}
                    />
                    <span className="ringtone-name">{r.name}</span>
                    <span className="ringtone-hint muted">Uploaded</span>
                  </label>
                  <button
                    type="button"
                    className="device-action"
                    onClick={() => preview(slug)}
                    aria-label={`Preview ${r.name} ringtone`}
                  >
                    {previewing === slug ? '◼ Stop' : '▶ Play'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h4 style={{ marginTop: uploaded.length > 0 ? 18 : 4, marginBottom: 8, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        Built-in
      </h4>
      <ul className="ringtone-list">
        {presets.map((p) => (
          <li key={p.slug} className={`ringtone-row${selected === p.slug ? ' selected' : ''}`}>
            <label className="ringtone-pick">
              <input
                type="radio"
                name="ringtone"
                value={p.slug}
                checked={selected === p.slug}
                onChange={() => void handleSelect(p.slug)}
              />
              <span className="ringtone-name">{p.label}</span>
              <span className="ringtone-hint muted">{p.hint}</span>
            </label>
            <button
              type="button"
              className="device-action"
              onClick={() => preview(p.slug)}
              aria-label={`Preview ${p.label} ringtone`}
            >
              {previewing === p.slug ? '◼ Stop' : '▶ Play'}
            </button>
          </li>
        ))}
      </ul>
      {saving && <p className="muted small" style={{ marginTop: 8 }}>Saving…</p>}
      {error && <p className="error small" style={{ marginTop: 8 }}>{error}</p>}
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
          placeholder="Add a new quick reply…"
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
// Blocked Numbers — per-user blocklist of inbound phone numbers.
// Calls from blocked numbers are hung up at the Telnyx layer (the webhook
// handler issues a hangup via Call Control); SMS is silently dropped before
// being stored. Both behaviors are server-side — closing the dialer doesn't
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
      // Upsert into the local list — if the same number was already there
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
    return <div className="settings-section"><p className="muted">Loading…</p></div>;
  }

  return (
    <div className="settings-section">
      <h2 className="settings-title">Blocked numbers</h2>
      <p className="settings-blurb">
        Calls from these numbers are rejected at the carrier and never ring
        the dialer. Text messages from these numbers are silently dropped —
        they never appear in your inbox and you get no notification.
        <br /><br />
        <strong>Please add a reason.</strong> Your admin can see every block on
        the team and may need context (spam, ex-employee, harassment, etc).
        If a block was a mistake, your admin can override it.
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
          {adding ? 'Blocking…' : (<><Plus size={14} /> Block</>)}
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
        your dialer is closed. SMS senders won't see any error — the message
        appears delivered to them but is dropped before reaching you.
      </p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Phase 6.13 — Admin Users panel
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
  // v0.10.94 — needed for the inline Call / SMS quick-action buttons that
  // navigate the admin's own dialer to /keypad?to=<DID> and /messages?to=<DID>
  // respectively. Lets admin reach any user from this page in two clicks.
  const navigate = useNavigate();
  const [me, setMe] = useState<{ id: number; isAdmin: boolean } | null>(null);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAutoProvision, setShowAutoProvision] = useState(false);
  // v0.10.37 — Unified wizard. Admin enters Pulse credentials; server
  // creates the ACE user + rebinds DID + runs backfill in one shot.
  const [showMigrateFromPulse, setShowMigrateFromPulse] = useState(false);
  // v0.10.38 — Bulk-refresh SMS for all migrated users.
  const [showBulkRefresh, setShowBulkRefresh] = useState(false);
  // v0.10.38 — Per-user "Refresh from Pulse" target. Set from kebab menu.
  const [refreshFromPulseTarget, setRefreshFromPulseTarget] = useState<AdminUserRow | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // v0.9.8 — Hard-delete modal target. null = closed.
  const [hardDeleteTarget, setHardDeleteTarget] = useState<AdminUserRow | null>(null);
  // v0.10.0 Task 27 — Manage Lines modal target. null = closed.
  const [linesTarget, setLinesTarget] = useState<AdminUserRow | null>(null);
  // v0.10.100 — Voicemail Call Control migration modal target.
  const [voicemailMigrationTarget, setVoicemailMigrationTarget] = useState<AdminUserRow | null>(null);
  // v0.10.101 — Per-user devices modal target.
  const [devicesTarget, setDevicesTarget] = useState<AdminUserRow | null>(null);
  // v0.9.9 — Hide deactivated users by default (so "delete" feels like
  // delete even when FK constraints force soft-deactivate). Admin can
  // toggle to see the full list.
  const [showInactive, setShowInactive] = useState(false);
  // v0.10.91 — Sortable users table. Click a column header to sort by it;
  // click again to toggle ascending/descending. Default ordering (sortKey
  // = null) preserves the server-returned createdAt-desc order so new
  // admins land on the familiar "newest users first" view.
  type SortKey = 'name' | 'email' | 'role' | 'status' | 'did' | 'lastLogin' | 'version';
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

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
    return <div className="muted">Loading users…</div>;
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
    // v0.10.40 — Search across ALL of the user's DIDs, not just the
    // legacy User.didNumber column.
    if ((r.didNumber ?? '').toLowerCase().includes(q)) return true;
    if (r.userDids.some((d) => d.didNumber.toLowerCase().includes(q))) return true;
    return false;
  });
  // v0.10.91 — apply sort after filter (when an admin has clicked a header).
  if (sortKey) {
    const mul = sortDir === 'asc' ? 1 : -1;
    const getKey = (r: AdminUserRow): string | number => {
      switch (sortKey) {
        case 'name':
          return ([r.firstName, r.lastName].filter(Boolean).join(' ') || r.email).toLowerCase();
        case 'email':
          return r.email.toLowerCase();
        case 'role':
          // Admin sorts before User in 'asc'.
          return r.isAdmin ? 0 : 1;
        case 'status':
          // Active before Inactive in 'asc'.
          return r.isActive ? 0 : 1;
        case 'did':
          return (r.didNumber || r.userDids[0]?.didNumber || '').toLowerCase();
        case 'lastLogin':
          // Never-signed-in users go LAST in asc (treat as -Infinity… well,
          // largest negative timestamp). Flip with sortDir for desc.
          return r.lastLoginAt ? new Date(r.lastLoginAt).getTime() : -Infinity;
        case 'version':
          // v0.10.111 - sort by semver-ish numeric weight; missing version
          // sorts to the bottom in asc order.
          return r.latestVersion
            ? r.latestVersion.split('.').map((n) => Number(n) || 0).reduce((a, b) => a * 1000 + b, 0)
            : -Infinity;
      }
    };
    filtered.sort((a, b) => {
      const ka = getKey(a);
      const kb = getKey(b);
      if (ka < kb) return -1 * mul;
      if (ka > kb) return 1 * mul;
      return 0;
    });
  }
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
            {activeAdminCount} admin{activeAdminCount === 1 ? '' : 's'} ·{' '}
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
          {/* v0.10.37 — Pulse → ACE migration wizard. Admin enters
              the user's Pulse email + password and we handle the rest. */}
          <button
            type="button"
            className="device-action primary"
            onClick={() => setShowMigrateFromPulse(true)}
            title="Migrate a Pulse user to ACE. Enter their Pulse email + password — we create their ACE account, move their number, and import their 30-day history."
          >
            <UserPlus size={14} /> Migrate from Pulse
          </button>
          {/* v0.10.38 — Bulk-refresh SMS from Pulse for every
              previously-migrated user. SMS only — calls need per-user
              passwords we don't store. */}
          <button
            type="button"
            className="device-action"
            onClick={() => setShowBulkRefresh(true)}
            title="Re-run the 30-day SMS backfill from Pulse for every previously-migrated user. Catches late-arriving Pulse messages."
          >
            <Upload size={14} /> Bulk-refresh SMS
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
            {/* v0.10.91 — Each header is now a sort toggle. Click once to
                sort ascending, click again to flip to descending. The active
                column shows an arrow indicator. Header click target is the
                cell — no inner <button> so the existing thead CSS still
                applies. */}
            {(() => {
              const ths: Array<{ key: SortKey; label: string }> = [
                { key: 'name', label: 'User' },
                { key: 'email', label: 'Email' },
                { key: 'role', label: 'Role' },
                { key: 'status', label: 'Status' },
                { key: 'did', label: 'DID' },
                { key: 'version', label: 'Version' },
                { key: 'lastLogin', label: 'Last sign-in' },
              ];
              return ths.map((c) => {
                const active = sortKey === c.key;
                const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                return (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    style={{
                      cursor: 'pointer',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Sort by ${c.label}`}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {c.label}{arrow}
                  </th>
                );
              });
            })()}
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
                <td className="muted small">
                  {/* v0.10.40 — Show the user's default-assigned line
                      (from UserDid rows) instead of the legacy
                      User.didNumber, which doesn't track adds/changes.
                      If they have more than one line, show "+N" badge. */}
                  {/* v0.10.108 — Show ALL DIDs assigned to the user, not
                      just the default + "+N" badge. Default DID gets a
                      blue "default" pill; the rest stack underneath. */}
                  {(() => {
                    if (r.userDids.length === 0) {
                      return r.didNumber || '—';
                    }
                    const sorted = [...r.userDids].sort((a, b) => {
                      if (a.isDefault && !b.isDefault) return -1;
                      if (!a.isDefault && b.isDefault) return 1;
                      return a.didNumber.localeCompare(b.didNumber);
                    });
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {sorted.map((d) => (
                          <span
                            key={d.didNumber}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title={d.isDefault ? 'Default line' : 'Additional line'}
                          >
                            {d.didNumber}
                            {d.isDefault && sorted.length > 1 && (
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  background: 'rgba(59,130,246,0.12)',
                                  color: '#1d4ed8',
                                  fontWeight: 600,
                                }}
                              >
                                default
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                {/* v0.10.111 - Version column: latest seen dialer version
                    across this user's devices. Mixed versions get a yellow
                    badge so admin can spot users running older clients. */}
                <td className="muted small" style={{ whiteSpace: 'nowrap' }}>
                  {(() => {
                    const v = r.latestVersion;
                    if (!v) return <span style={{ color: '#9ca3af' }}>—</span>;
                    const distinct = r.distinctVersions || [v];
                    const mixed = distinct.length > 1;
                    const tooltip = mixed
                      ? `Multiple versions in use: ${distinct.join(', ')}`
                      : (r.latestSeenAt
                          ? `Last heartbeat: ${new Date(r.latestSeenAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })}`
                          : 'Recently seen');
                    return (
                      <span title={tooltip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        v{v}
                        {mixed && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(245,158,11,0.15)',
                              color: '#92400e',
                              fontWeight: 600,
                            }}
                          >
                            +{distinct.length - 1}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </td>
                <td className="muted small">
                  {r.lastLoginAt
                    ? new Date(r.lastLoginAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })
                    : 'Never'}
                </td>
                <td className="users-admin-actions">
                  {/* v0.10.94 — Quick-action buttons: Call + SMS the user
                      directly. Routes admin's own dialer to /keypad?to=DID
                      (call) or /messages?to=DID (SMS). Only shown when the
                      user has a DID and isn't the admin themselves (you
                      can't dial your own line). */}
                  {(() => {
                    const targetDid = r.didNumber || r.userDids[0]?.didNumber || null;
                    if (!targetDid || isSelf) return null;
                    return (
                      <>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Call ${[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}`}
                          title={`Call ${targetDid}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/keypad?to=${encodeURIComponent(targetDid)}`);
                          }}
                          style={{ color: '#0a7d23', marginRight: 4 }}
                        >
                          <Phone size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Text ${[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}`}
                          title={`Text ${targetDid}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/messages?to=${encodeURIComponent(targetDid)}`);
                          }}
                          style={{ color: '#0a84ff', marginRight: 4 }}
                        >
                          <MessageSquare size={16} />
                        </button>
                      </>
                    );
                  })()}
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
                              ? "Promote someone else first — this is the only active admin"
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
                              ? "Promote someone else first — this is the only active admin"
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

                      {/* v0.10.0 Task 27 — Manage user's DIDs (add/remove/edit). */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setLinesTarget(r);
                        }}
                        title="Add or remove phone numbers for this user"
                      >
                        <Phone size={14} />
                        Manage lines
                      </button>

                      {/* v0.10.100 — Migrate this user's DIDs from Hosted VM to
                          the new Call Control voicemail flow (ring softphone
                          first, fall to custom greeting on no-answer). */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setVoicemailMigrationTarget(r);
                        }}
                        title="Switch this user from legacy Hosted Voicemail to the new Call Control voicemail (ring + fallback)"
                      >
                        <Mic size={14} />
                        Voicemail migration
                      </button>

                      {/* v0.10.101 — Show user's devices + version. Admin can
                          request a force-update on a specific device. */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setDevicesTarget(r);
                        }}
                        title="See which devices this user is signed into and what app version each one is running. Request a force-update on a specific device."
                      >
                        <Stethoscope size={14} />
                        Devices
                      </button>

                      {/* v0.10.60 — Per-user Connection Health beta toggle.
                          Smooths the disconnect/reconnect flicker and (in
                          a follow-up RC) responds to Telnyx-pushed eviction
                          events. Pilot-only until validated, then default on. */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          const next = !r.connectionHealthBeta;
                          const verb = next ? 'Enable' : 'Disable';
                          if (!confirm(`${verb} Connection Health (beta) for ${rowName(r)}? They'll need to refresh the dialer for the change to take effect.`)) return;
                          void handlePatch(r.id, { connectionHealthBeta: next });
                        }}
                        title="Toggle the Connection Health beta for this user. They must refresh after toggling."
                      >
                        <Zap size={14} />
                        {r.connectionHealthBeta ? 'Disable Conn. Health (beta)' : 'Enable Conn. Health (beta)'}
                      </button>

                      {/* v0.10.64 — Set the user's country. Drives Telnyx
                          anchorsite_override (IN → Chennai, else → Latency).
                          For future ACE Telnyx config syncs to use the
                          correct anchor — doesn't immediately re-PATCH the
                          existing connection. Admin should also run the
                          re-apply (when v0.10.65 ships) for changes to
                          flow through to Telnyx for existing users. */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          const current = r.country ?? '';
                          const next = prompt(
                            `Set country for ${rowName(r)} (IN / US / Other).\nCurrent: ${current || '(not set)'}\n\nValid: IN, US, Other. Drives Telnyx anchorsite (IN → Chennai).`,
                            current || 'IN',
                          );
                          if (next === null) return; // cancelled
                          const trimmed = next.trim().toUpperCase();
                          if (trimmed && !['IN', 'US', 'OTHER'].includes(trimmed)) {
                            alert('Country must be IN, US, or Other (case-insensitive).');
                            return;
                          }
                          // Normalize "OTHER" back to "Other" for storage consistency.
                          const value = trimmed === 'OTHER' ? 'Other' : trimmed;
                          void handlePatch(r.id, { country: value || null });
                        }}
                        title="Set this user's country (drives Telnyx anchorsite routing)"
                      >
                        <Phone size={14} />
                        Set country ({r.country ?? '—'})
                      </button>

                      {/* v0.10.38 — Per-user "Refresh from Pulse". One
                          click re-pulls their 30-day SMS (and optionally
                          calls if you provide their Pulse password). */}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setRefreshFromPulseTarget(r);
                        }}
                        title="Re-pull this user's 30-day history from Pulse into ACE. SMS automatic; calls optional with their Pulse password."
                      >
                        <Upload size={14} />
                        Refresh from Pulse
                      </button>

                      {/* Set SIP password — for users imported without a password */}
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

      {showMigrateFromPulse && (
        <MigrateFromPulseModal
          onClose={() => setShowMigrateFromPulse(false)}
          onDone={() => {
            setShowMigrateFromPulse(false);
            load();
          }}
        />
      )}

      {showBulkRefresh && (
        <BulkRefreshPulseSmsModal
          onClose={() => setShowBulkRefresh(false)}
          onDone={() => setShowBulkRefresh(false)}
        />
      )}

      {refreshFromPulseTarget && (
        <RefreshUserFromPulseModal
          target={refreshFromPulseTarget}
          onClose={() => setRefreshFromPulseTarget(null)}
          onDone={() => setRefreshFromPulseTarget(null)}
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

      {/* v0.10.0 Task 27 — Manage Lines modal */}
      {linesTarget && (
        <UserLinesManagerModal
          userId={linesTarget.id}
          userLabel={
            [linesTarget.firstName, linesTarget.lastName].filter(Boolean).join(' ') ||
            linesTarget.email
          }
          onClose={() => {
            setLinesTarget(null);
            load();  // refresh the table — userDid changes can affect didNumber column display
          }}
        />
      )}

      {/* v0.10.100 — Voicemail Call Control migration modal */}
      {voicemailMigrationTarget && (
        <VoicemailMigrationModal
          user={voicemailMigrationTarget}
          onClose={() => {
            setVoicemailMigrationTarget(null);
            load();
          }}
        />
      )}

      {/* v0.10.101 — Per-user devices modal */}
      {devicesTarget && (
        <UserDevicesModal
          user={devicesTarget}
          onClose={() => setDevicesTarget(null)}
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
                will block the User delete — we'll fall back to <strong>anonymize</strong>{' '}
                (email tombstoned, name + SIP creds + DID + SSO link cleared). The empty
                row stays attached to the historical records, but the email becomes free
                to re-invite cleanly.
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
                  : `User ${target.email} was anonymized (email is now free to re-invite).`}
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
  // v0.10.64 — Country for Telnyx anchorsite selection. Defaults to IN
  // since 95% of new ApTask hires are in India.
  const [country, setCountry] = useState<'IN' | 'US' | 'Other'>('IN');
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
        // v0.10.64 — country drives Telnyx anchorsite (IN → Chennai).
        country,
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
                    <strong>Purchase a new DID from Telnyx</strong>
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
                    <strong>Use a new number from Telnyx database that you already own</strong>
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

              {/* v0.10.64 — Country picker for Telnyx anchorsite selection.
                  India → Chennai routing (lowest latency for the 95% in-country);
                  US/Other → "Latency" routing (Telnyx picks closest site per-call).
                  Default IN since 95% of new hires are India-based. */}
              <label className="fav-modal-field" style={{ marginTop: 14, marginBottom: 8 }}>
                <span className="fav-modal-label">Country</span>
                <select
                  className="fav-modal-input"
                  value={country}
                  onChange={(e) => setCountry(e.target.value as 'IN' | 'US' | 'Other')}
                  disabled={submitting}
                >
                  <option value="IN">India (Chennai anchor)</option>
                  <option value="US">United States (Latency)</option>
                  <option value="Other">Other (Latency)</option>
                </select>
                <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                  Picks the Telnyx anchor site closest to this user. Can be edited
                  later from the Users tab kebab menu.
                </span>
              </label>

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

// v0.10.37 — Migrate user from Pulse to ACE — unified wizard.
function MigrateFromPulseModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [pulseEmail, setPulseEmail] = useState('');
  const [pulsePassword, setPulsePassword] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  // v0.10.58 — Optional manual DID override for cases where Pulse has stale
  // or wrong data on the user's profile. Leave blank to trust Pulse.
  const [didOverride, setDidOverride] = useState('');
  // v0.10.64 — Country for Telnyx anchorsite selection. Default IN since
  // 95% of ApTask users are in India.
  const [country, setCountry] = useState<'IN' | 'US' | 'Other'>('IN');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MigrateFromPulseResult | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    queueMicrotask(() => bodyRef.current?.scrollTo({ top: 0 }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!pulseEmail.trim() || !pulsePassword) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await migrateUserFromPulse(token, {
        pulseEmail: pulseEmail.trim(),
        pulsePassword,
        isAdmin: makeAdmin,
        // v0.10.58 — Only send when admin actually typed something; empty
        // string means "trust Pulse" on the server.
        didOverride: didOverride.trim() || undefined,
        // v0.10.64 — Country drives Telnyx anchorsite (India → Chennai).
        country,
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
        aria-labelledby="migrate-from-pulse-title"
        style={{ maxWidth: 560 }}
        ref={bodyRef}
      >
        <div className="fav-modal-header">
          <UserPlus size={18} className="fav-modal-icon" />
          <h3 id="migrate-from-pulse-title">Migrate user from Pulse</h3>
        </div>

        {!result && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Enter this user's <strong>Pulse</strong> email and password. ACE will create
              their account, move their phone number from Pulse to ACE, and import their
              last 30 days of call and SMS history. The password is used once and never stored.
            </p>

            <form onSubmit={handleSubmit} autoComplete="off">
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">Pulse email *</span>
                <input
                  type="email"
                  className="fav-modal-input"
                  placeholder="firstname.lastname@aptask.com"
                  value={pulseEmail}
                  onChange={(e) => setPulseEmail(e.target.value)}
                  autoFocus
                  required
                  disabled={submitting}
                />
                {/* v0.10.110 - drives ACE email + Telnyx connection name */}
                <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>
                  This email becomes their ACE account email AND drives
                  the Telnyx Credential Connection name - please type
                  carefully.
                </span>
              </label>
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">Pulse password *</span>
                <input
                  type="password"
                  className="fav-modal-input"
                  placeholder="Their current Pulse password"
                  value={pulsePassword}
                  onChange={(e) => setPulsePassword(e.target.value)}
                  required
                  disabled={submitting}
                  autoComplete="new-password"
                />
                <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                  Used once to log into Pulse on their behalf. Never written to disk or audit log.
                </span>
              </label>
              {/* v0.10.58 — Optional DID override.
                  Leave blank to use whatever number Pulse has on file.
                  Use this when Pulse data is wrong/stale and the lookup-on-
                  Telnyx step would otherwise fail. Examples Roshni's case:
                  Pulse said 4706008030 but her real Telnyx DID is 4706168494. */}
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">DID override (optional)</span>
                <input
                  type="tel"
                  className="fav-modal-input"
                  placeholder="+14706168494 — leave blank to use Pulse's value"
                  value={didOverride}
                  onChange={(e) => setDidOverride(e.target.value)}
                  disabled={submitting}
                  autoComplete="off"
                />
                <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                  Only fill this if Pulse has the wrong number on the user. When
                  provided, ACE ignores Pulse's voip_number and looks up this
                  number on Telnyx instead. Audited.
                </span>
              </label>

              {/* v0.10.64 — Country picker. Drives Telnyx anchorsite_override
                  on the newly-created Credential Connection. India → Chennai
                  anchor (lowest latency for the 95% in-country); US/Other →
                  "Latency" routing (Telnyx picks closest site per-call). */}
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">Country</span>
                <select
                  className="fav-modal-input"
                  value={country}
                  onChange={(e) => setCountry(e.target.value as 'IN' | 'US' | 'Other')}
                  disabled={submitting}
                >
                  <option value="IN">India (Chennai anchor)</option>
                  <option value="US">United States (Latency)</option>
                  <option value="Other">Other (Latency)</option>
                </select>
                <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                  Picks the Telnyx anchor site closest to this user. India users
                  get Chennai routing; everyone else uses Telnyx's latency-based
                  per-call picker. Can be edited later from the user's row.
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: '0.92rem' }}>
                <input
                  type="checkbox"
                  checked={makeAdmin}
                  onChange={(e) => setMakeAdmin(e.target.checked)}
                  disabled={submitting}
                />
                Make this user an ACE admin
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button type="button" className="device-action" onClick={onClose} disabled={submitting}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="device-action primary"
                  disabled={submitting || !pulseEmail.trim() || !pulsePassword}
                >
                  {submitting ? 'Migrating...' : 'Migrate user'}
                </button>
              </div>
              {submitting && (
                <p className="muted small" style={{ marginTop: 12, textAlign: 'center' }}>
                  Takes 20-60 seconds. Don't close the window.
                </p>
              )}
            </form>
          </>
        )}

        {result && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                padding: 10, borderRadius: 8, marginBottom: 12,
                background: result.ok ? 'rgba(0, 150, 0, 0.08)' : 'rgba(215, 0, 21, 0.08)',
                border: `1px solid ${result.ok ? 'rgba(0, 150, 0, 0.3)' : 'rgba(215, 0, 21, 0.3)'}`,
              }}
            >
              <strong>
                {result.ok
                  ? 'Migration complete'
                  : result.error ? `Migration failed: ${result.error}` : 'Migration completed with errors'}
              </strong>
              {result.ok && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  ACE user created. Number {result.didNumber} moved. Imported {result.callsInserted ?? 0} calls
                  and {result.messagesInserted ?? 0} messages from Pulse
                  {typeof result.durationMs === 'number' ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : ''}.
                </div>
              )}
            </div>
            {result.steps && result.steps.length > 0 && (
              <details open={!result.ok} style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.88rem', marginBottom: 8 }}>
                  Step-by-step ({result.steps.filter((s) => s.ok).length}/{result.steps.length} succeeded)
                </summary>
                <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                  {result.steps.map((s, i) => (
                    <li key={i} style={{ color: s.ok ? 'inherit' : '#d70015', marginBottom: 4 }}>
                      <span style={{ marginRight: 6 }}>{s.ok ? 'OK' : 'X'}</span>
                      {s.step}
                      {s.error && (
                        <div className="muted small" style={{ marginLeft: 16, color: '#d70015' }}>
                          {s.error}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {/* v0.10.82 — "DID already in ACE" → show WHO already owns it
                so admin can decide whether to delete that user (same person,
                stale prior attempt) or use the Override DID field (different
                person, Pulse data wrong). */}
            {result.existingOwner && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                }}
              >
                <strong style={{ fontSize: '0.9rem' }}>
                  That DID already belongs to ACE user #{result.existingOwner.userId}
                </strong>
                <div style={{ marginTop: 6, fontSize: '0.88rem' }}>
                  <strong>
                    {(`${result.existingOwner.firstName ?? ''} ${result.existingOwner.lastName ?? ''}`.trim()) || '(no name)'}
                  </strong>
                  {' '}&lt;{result.existingOwner.email}&gt; — {result.existingOwner.isActive ? 'active' : 'deactivated'}
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>
                  {result.existingOwner.sameAsTarget
                    ? `Same email as the user you're migrating — this is a prior failed attempt for the same person. Delete ACE user #${result.existingOwner.userId} (Settings → Admin → Users), then re-run the migration.`
                    : !result.existingOwner.isActive
                      ? `This user is deactivated — admin can delete them to free up the DID, then retry.`
                      : `A different active user owns this DID. Either Pulse's voip_number for the user you're migrating is wrong, or this DID legitimately belongs to the user shown above. Use the Override DID field above with the correct number.`}
                </div>
              </div>
            )}
            {/* v0.10.81 — Migration debug. When Telnyx didn't recognize the
                primary voip_number, the backend scans the Pulse JWT for
                OTHER phone-shaped fields and reports each one's ownership
                status. Surface them so admin sees at a glance whether the
                user's real DID is hiding in another column. */}
            {result.phoneCandidates && result.phoneCandidates.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                }}
              >
                <strong style={{ fontSize: '0.9rem' }}>
                  Other numbers found in this user's Pulse record:
                </strong>
                <div className="muted small" style={{ marginTop: 4, marginBottom: 8 }}>
                  If one of these is marked <strong>owned</strong>, that's likely the
                  user's real DID. Update Pulse's <code>voip_number</code> via SQL
                  to point at it, then re-run this migration. Or use the
                  Override DID field above and skip Pulse's data entirely.
                </div>
                <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                  {result.phoneCandidates.map((c, i) => {
                    const statusColor =
                      c.telnyxStatus === 'owned' ? '#0a7d23'
                      : c.telnyxStatus === 'error' ? '#d70015'
                      : 'inherit';
                    const statusLabel =
                      c.telnyxStatus === 'owned' ? 'OWNED by ApTask'
                      : c.telnyxStatus === 'not_found' ? 'not on Telnyx'
                      : 'lookup error';
                    return (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <code>{c.field}</code>: <strong>{c.e164}</strong>{' '}
                        <span style={{ color: statusColor, fontWeight: 600 }}>
                          {statusLabel}
                        </span>
                        {c.raw !== c.e164 && (
                          <span className="muted small">
                            {' '}(raw: "{c.raw}")
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
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

// v0.10.38 — Bulk-refresh SMS from Pulse for every migrated user.
function BulkRefreshPulseSmsModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkRefreshPulseSmsResult | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    queueMicrotask(() => bodyRef.current?.scrollTo({ top: 0 }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  async function handleRun() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await bulkRefreshPulseSms(token, {});
      setResult(r);
    } catch (err) {
      setResult({
        ok: false,
        totalUsers: 0,
        totalCallsInserted: 0,
        totalMessagesInserted: 0,
        totalDurationMs: 0,
        results: [],
        error: (err as Error).message,
      });
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
        aria-labelledby="bulk-refresh-title"
        style={{ maxWidth: 720 }}
        ref={bodyRef}
      >
        <div className="fav-modal-header">
          <Upload size={18} className="fav-modal-icon" />
          <h3 id="bulk-refresh-title">Bulk-refresh SMS from Pulse</h3>
        </div>

        {!result && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Re-runs the 30-day SMS backfill from Pulse for every user previously migrated
              from Pulse to ACE. Useful when Pulse logged new SMS after a user moved over.
            </p>
            <div
              style={{
                padding: 10, borderRadius: 8, marginTop: 8, marginBottom: 12,
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                fontSize: '0.88rem',
              }}
            >
              <strong>SMS only.</strong> Calls can't be bulk-refreshed because Pulse requires
              each user's own JWT to fetch their call history, and ACE doesn't store user
              passwords. For one user's call refresh, use the per-user "Refresh from Pulse"
              on their row.
            </div>
            <p className="muted small">
              Sequential processing, about 3-5 seconds per user. Capped at 100 users per run.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="device-action" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                className="device-action primary"
                onClick={handleRun}
                disabled={submitting}
              >
                {submitting ? 'Running...' : 'Run bulk refresh'}
              </button>
            </div>
            {submitting && (
              <p className="muted small" style={{ marginTop: 12, textAlign: 'center' }}>
                Running. Don't close the window. This can take several minutes for large tenants.
              </p>
            )}
          </>
        )}

        {result && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                padding: 10, borderRadius: 8, marginBottom: 12,
                background: result.ok ? 'rgba(0, 150, 0, 0.08)' : 'rgba(215, 0, 21, 0.08)',
                border: `1px solid ${result.ok ? 'rgba(0, 150, 0, 0.3)' : 'rgba(215, 0, 21, 0.3)'}`,
              }}
            >
              <strong>
                {result.ok
                  ? 'Bulk refresh complete'
                  : result.error ? `Bulk refresh failed: ${result.error}` : 'Bulk refresh finished with errors'}
              </strong>
              {result.ok && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  Processed {result.totalUsers} user{result.totalUsers === 1 ? '' : 's'} -
                  imported {result.totalMessagesInserted} new message
                  {result.totalMessagesInserted === 1 ? '' : 's'} -
                  {' '}{(result.totalDurationMs / 1000).toFixed(1)}s total
                </div>
              )}
              {result.note && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  {result.note}
                </div>
              )}
            </div>
            {result.results.length > 0 && (
              <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8 }}>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'rgba(0,0,0,0.04)' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px' }}>User</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px' }}>DID</th>
                      <th style={{ textAlign: 'right', padding: '6px 10px' }}>New SMS</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.results.map((r) => (
                      <tr key={r.userId} style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                        <td style={{ padding: '6px 10px' }}>
                          {r.email}
                          <div className="muted small">
                            ACE #{r.userId} - Pulse #{r.pulseUserId}
                          </div>
                        </td>
                        <td style={{ padding: '6px 10px' }}>{r.didNumber ?? '-'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                          {r.messagesInserted}
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          {r.skipped ? (
                            <span className="muted small">skipped - {r.skipped}</span>
                          ) : r.errors.length > 0 ? (
                            <span style={{ color: '#d70015' }}>
                              {r.errors.length} error{r.errors.length === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span style={{ color: '#0a7a0a' }}>ok</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

// v0.10.38 — Per-user "Refresh from Pulse" modal.
function RefreshUserFromPulseModal({
  target,
  onClose,
  onDone,
}: {
  target: AdminUserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pulsePassword, setPulsePassword] = useState('');
  // v0.10.39 — Manual Pulse user_id for pre-wizard users (Ravindra etc.)
  // who don't have an audit log entry yet. Empty string = use auto-resolve.
  const [pulseUserIdStr, setPulseUserIdStr] = useState('');
  // v0.10.40 — Which of the user's lines should receive the imported
  // history. Defaults to the user's isDefault DID. Only relevant when the
  // user has multiple lines.
  const defaultDidId = (
    target.userDids.find((d) => d.isDefault) ?? target.userDids[0]
  )?.id ?? null;
  const [pickedUserDidId, setPickedUserDidId] = useState<number | null>(defaultDidId);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RefreshFromPulseResult | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    queueMicrotask(() => bodyRef.current?.scrollTo({ top: 0 }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  async function handleRun() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSubmitting(true);
    setResult(null);
    try {
      const pulseUserIdNum = pulseUserIdStr.trim()
        ? parseInt(pulseUserIdStr.trim(), 10)
        : undefined;
      const r = await refreshUserFromPulse(token, target.id, {
        pulseUserPassword: pulsePassword || undefined,
        pulseUserIdOverride: Number.isFinite(pulseUserIdNum) && pulseUserIdNum! > 0
          ? pulseUserIdNum
          : undefined,
        userDidId: pickedUserDidId ?? undefined,
      });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const displayName =
    [target.firstName, target.lastName].filter(Boolean).join(' ').trim() || target.email;

  return (
    <div className="compose-modal" onClick={submitting ? undefined : onClose}>
      <div
        className="fav-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="refresh-from-pulse-title"
        style={{ maxWidth: 520 }}
        ref={bodyRef}
      >
        <div className="fav-modal-header">
          <Upload size={18} className="fav-modal-icon" />
          <h3 id="refresh-from-pulse-title">Refresh {displayName} from Pulse</h3>
        </div>

        {!result && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Pulls this user's last 30 days of history from Pulse into ACE again.
              Already-imported items are skipped automatically.
            </p>
            <div
              style={{
                padding: 10, borderRadius: 8, marginBottom: 12,
                background: 'rgba(0,0,0,0.04)', fontSize: '0.88rem',
              }}
            >
              <div><strong>User:</strong> {displayName}</div>
              <div><strong>Email:</strong> {target.email}</div>
              <div>
                <strong>Lines on this user:</strong>{' '}
                {target.userDids.length === 0
                  ? (target.didNumber ?? '-')
                  : target.userDids.map((d) => d.didNumber).join(', ')}
              </div>
            </div>

            {/* v0.10.40 — DID picker. Only shown when the user has more
                than one line; for single-line users we hide it (defaults
                to that one line server-side). */}
            {target.userDids.length > 1 && (
              <label className="fav-modal-field" style={{ marginBottom: 8 }}>
                <span className="fav-modal-label">Attach history to which line?</span>
                <select
                  className="fav-modal-input"
                  value={pickedUserDidId ?? ''}
                  onChange={(e) => setPickedUserDidId(parseInt(e.target.value, 10) || null)}
                  disabled={submitting}
                  style={{ colorScheme: 'light dark' }}
                >
                  {target.userDids.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.didNumber}
                      {d.label ? ` — ${d.label}` : ''}
                      {d.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                  Pick the line whose history should come over from Pulse. Usually
                  the user's original Pulse number, not their ACE-purchased line.
                </span>
              </label>
            )}

            <label className="fav-modal-field" style={{ marginBottom: 8 }}>
              <span className="fav-modal-label">Pulse user ID (only needed first time)</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d+"
                className="fav-modal-input"
                placeholder="e.g. 55 — leave blank if already migrated"
                value={pulseUserIdStr}
                onChange={(e) => setPulseUserIdStr(e.target.value.replace(/[^\d]/g, ''))}
                disabled={submitting}
              />
              <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                Required <strong>only</strong> for users added to ACE before the migrate
                wizard existed (their Pulse mapping isn't in the audit log yet).
                After one successful refresh, you won't need to enter this again for
                this user — it gets saved automatically.
              </span>
            </label>

            <label className="fav-modal-field" style={{ marginBottom: 8 }}>
              <span className="fav-modal-label">Pulse password (optional)</span>
              <input
                type="password"
                className="fav-modal-input"
                placeholder="Leave blank to refresh SMS only"
                value={pulsePassword}
                onChange={(e) => setPulsePassword(e.target.value)}
                disabled={submitting}
                autoComplete="new-password"
              />
              <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                Required only to refresh CALLS. SMS works without a password.
                Used once and never stored.
              </span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="device-action" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                className="device-action primary"
                onClick={handleRun}
                disabled={submitting}
              >
                {submitting ? 'Refreshing...' : 'Refresh now'}
              </button>
            </div>
            {submitting && (
              <p className="muted small" style={{ marginTop: 12, textAlign: 'center' }}>
                Takes 5-30 seconds. Don't close the window.
              </p>
            )}
          </>
        )}

        {result && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                padding: 10, borderRadius: 8, marginBottom: 12,
                background: result.ok ? 'rgba(0, 150, 0, 0.08)' : 'rgba(215, 0, 21, 0.08)',
                border: `1px solid ${result.ok ? 'rgba(0, 150, 0, 0.3)' : 'rgba(215, 0, 21, 0.3)'}`,
              }}
            >
              <strong>
                {result.ok
                  ? 'Refresh complete'
                  : result.error ? `Refresh failed: ${result.error}` : 'Refresh finished with errors'}
              </strong>
              {result.ok && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  Imported {result.callsInserted ?? 0} new call
                  {(result.callsInserted ?? 0) === 1 ? '' : 's'} and{' '}
                  {result.messagesInserted ?? 0} new message
                  {(result.messagesInserted ?? 0) === 1 ? '' : 's'}
                  {result.callsRequested === false && (
                    <> - Calls skipped (provide Pulse password to refresh calls too).</>
                  )}
                </div>
              )}
            </div>

            {/* v0.10.41 — Pulse-side diagnostic counts. If we imported 0
                messages, this tells admin whether Pulse genuinely has no
                SMS for this user (totalSms === 0) or whether our query
                is missing them (totalSms > 0 but messagesInserted === 0). */}
            {result.pulseCounts && (
              <div
                style={{
                  padding: 10, borderRadius: 8, marginBottom: 12,
                  background: 'rgba(0,0,0,0.04)', fontSize: '0.88rem',
                }}
              >
                <strong>Pulse-side diagnostic for user_id {result.pulseUserId}:</strong>
                <div className="muted small" style={{ marginTop: 4 }}>
                  Total messages (any type, any time):{' '}
                  <strong>{result.pulseCounts.totalAllTime}</strong>
                </div>
                <div className="muted small">
                  Total SMS (any time):{' '}
                  <strong>{result.pulseCounts.totalSms}</strong>
                </div>
                <div className="muted small">
                  SMS in last 30 days:{' '}
                  <strong>{result.pulseCounts.smsLastNDays}</strong>
                </div>
                {result.pulseCounts.totalSms === 0 && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Pulse has no SMS at all for this user — they may only
                    use Pulse for calls, or their SMS routing was different.
                  </div>
                )}
                {result.pulseCounts.totalSms > 0 &&
                  result.pulseCounts.smsLastNDays === 0 && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Pulse has SMS for this user, but none in the last 30 days.
                  </div>
                )}
                {/* v0.10.62 — Fixed the false-positive warning.
                    Previously this checked only messagesInserted; for users
                    who'd already been migrated, every "refresh from Pulse"
                    would hit skipDuplicates (all rows already in ACE),
                    inserted=0, and the warning would fire alarmingly even
                    though everything was healthy. Now we sum inserted +
                    skipped — only warn if the total processed is materially
                    less than what Pulse claims to have. Allow a small drift
                    (Pulse count vs. fetch count can differ by a few because
                    the two queries don't run at the exact same instant). */}
                {(() => {
                  const inserted = result.messagesInserted ?? 0;
                  const skipped = result.messagesSkipped ?? 0;
                  const accounted = inserted + skipped;
                  const pulseCount = result.pulseCounts!.smsLastNDays;
                  // Allow 5% drift OR 5 messages, whichever is larger.
                  const tolerance = Math.max(5, Math.ceil(pulseCount * 0.05));
                  const materialGap = pulseCount - accounted > tolerance;
                  if (pulseCount > 0 && materialGap) {
                    return (
                      <div className="small" style={{ marginTop: 6, color: '#d70015' }}>
                        Warning: Pulse has {pulseCount} SMS in the last 30 days but ACE
                        only accounted for {accounted} ({inserted} new + {skipped} already
                        imported). Gap of {pulseCount - accounted} suggests an import bug —
                        let the devs know.
                      </div>
                    );
                  }
                  if (pulseCount > 0 && inserted === 0 && skipped > 0) {
                    return (
                      <div className="muted small" style={{ marginTop: 6 }}>
                        All {skipped} of Pulse's last-30-day SMS were already in ACE from a
                        prior migration. Nothing new to import — this user is up to date.
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            )}
            {result.errors && result.errors.length > 0 && (
              <details open style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.88rem', marginBottom: 8 }}>
                  Warnings ({result.errors.length})
                </summary>
                <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem' }}>
                  {result.errors.map((e, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>{e}</li>
                  ))}
                </ul>
              </details>
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
          By default the user signs in with Microsoft and binds via their email on first sign-in. SIP credentials & DID are optional — paste them if you already provisioned in Telnyx.
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
            {/* v0.10.110 - this email also names the Telnyx connection */}
            <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>
              This email is also used to name the user&apos;s Telnyx
              Credential Connection - please type carefully.
            </span>
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
              {submitting ? 'Inviting…' : 'Send invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 6.13 — Audit log
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
      case 'user.hard_deleted': return 'hard-deleted';
      case 'user.anonymized': return 'anonymized (history kept)';
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
                {new Date(e.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })}
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
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 5 (#189) — BulkImportModal
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
          Rows without a SIP password will be created — set the password later from the kebab menu when each user is ready to migrate.
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
              <Upload size={14} /> {submitting ? 'Parsing…' : 'Choose CSV file'}
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
              {stats.dryRun ? 'Preview — nothing written yet' : 'Imported âœ“'}
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
                        <span className="bulk-warn-text">No SIP password — set later</span>
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
                  {submitting ? 'Importing…' : `Confirm import (${preview.summary.created + preview.summary.updated})`}
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
// Phase 8 (#204) — Live Ops Dashboard
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
  if (loading && !data) return <div className="muted">Loading…</div>;
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
            {lastFetched && ' · last updated ' + fmtAgo(lastFetched.toISOString())}
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
            <span className="muted small"> · {data.sms.today.sent} sent / {data.sms.today.received} received</span>
          </div>
        </div>
        <div className="liveops-card">
          <div className="liveops-card-icon"><Users size={18} /></div>
          <div className="liveops-card-num">{data.users.activeLast24h}</div>
          <div className="liveops-card-label">
            Active 24h
            <span className="muted small"> · of {data.users.active} total</span>
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
            <div key={i} className="liveops-bar-wrap" title={i + ':00 — ' + h.inbound + ' in / ' + h.outbound + ' out / ' + h.missed + ' missed'}>
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
                    <div className="muted small">to {m.userName} · {fmtAgo(m.startedAt)}</div>
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
// Phase 8 — Presence dashboard (#211)
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
  if (loading && !data) return <div className="muted">Loading…</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const filtered = data.items.filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'idle') return i.status === 'idle' || i.status === 'recent';
    return i.status === filter;
  });

  function fmtAgo(iso: string | null): string {
    if (!iso) return '—';
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
            Refreshes every 10s · {data.items.length} users
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
                    <div className="muted small">{u.email}{u.isAdmin && ' · admin'}</div>
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
                ) : <span className="muted small">—</span>}
              </td>
              <td className="muted small">{fmtAgo(u.lastActivity)}</td>
              <td className="presence-today">
                <strong>{u.todayCalls}</strong>
                <span className="muted small">
                  {' '}({u.todayBreakdown.inbound}/{u.todayBreakdown.outbound}/{u.todayBreakdown.missed})
                </span>
              </td>
              <td className="muted small">{fmtPhone(u.didNumber) || '—'}</td>
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
// Phase 8 — Usage report (#205)
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
  if (loading && !data) return <div className="muted">Loading…</div>;
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
            <div key={d.date} className="liveops-bar-wrap" title={`${d.date} — ${d.inbound} in / ${d.outbound} out / ${d.missed} missed`}>
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
// Phase 8 — Quality report (#206)
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
  if (loading && !data) return <div className="muted">Loading…</div>;
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
            {data.totals.totalCalls} total calls · {data.totals.shortCalls} under 10s
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
                <div key={h} className="heatmap-cell" style={{ background: `rgba(10, 132, 255, ${0.05 + intensity * 0.85})` }} title={`${day} ${h}:00 — ${v} calls`} />
              );
            })}
          </React.Fragment>
        ))}
      </div>

      {/* v0.10.92 — Message quality + health section. Same time window as
          the call quality data above. Shows aggregate counts, outbound
          delivery rate, and a drill-down list of failure causes with
          sample messages so admin can see WHICH numbers failed. */}
      {data.messages && (
        <MessagesQualityBlock messages={data.messages} />
      )}
    </div>
  );
}

// v0.10.92 — Renders the message-side metrics of the Quality & Health
// report. Separated from QualitySection for readability; takes only the
// `messages` sub-object as a prop so it's easy to test in isolation.
function MessagesQualityBlock({ messages }: { messages: NonNullable<QualityReport['messages']> }) {
  const [expandedCause, setExpandedCause] = useState<string | null>(null);
  const deliveryPct = (messages.outboundDeliveryRate * 100).toFixed(1);
  const failureRatePct = messages.outboundCount > 0
    ? ((messages.outboundFailures / messages.outboundCount) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="quality-messages" style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid var(--border, #e2e8f0)' }}>
      <h4 style={{ marginBottom: 4 }}>Message quality &amp; health</h4>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
        SMS sent + received during the same window as the call data above.
      </p>

      {/* Aggregate counts by status */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <StatCard label="Total messages" value={messages.totalMessages} />
        <StatCard label="Outbound delivery rate" value={`${deliveryPct}%`} accent={Number(deliveryPct) >= 95 ? 'ok' : Number(deliveryPct) >= 85 ? 'warn' : 'err'} />
        <StatCard label="Sent" value={messages.byStatus.sent ?? 0} />
        <StatCard label="Delivered" value={messages.byStatus.delivered ?? 0} accent="ok" />
        <StatCard label="Failed" value={messages.byStatus.failed ?? 0} accent={messages.byStatus.failed > 0 ? 'err' : undefined} />
        <StatCard label="Undelivered" value={messages.byStatus.undelivered ?? 0} accent={messages.byStatus.undelivered > 0 ? 'warn' : undefined} />
        <StatCard label="Received (inbound)" value={messages.byStatus.received ?? 0} />
      </div>

      {/* Failure causes with drill-down */}
      {messages.failureCauses.length > 0 ? (
        <div>
          <h5 style={{ marginBottom: 6 }}>Top failure causes ({failureRatePct}% failure rate)</h5>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
            Click a cause to see specific failed messages and the recipient numbers.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {messages.failureCauses.map((c) => {
              const expanded = expandedCause === c.cause;
              return (
                <li key={c.cause} style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: 8 }}>
                  <button
                    type="button"
                    onClick={() => setExpandedCause(expanded ? null : c.cause)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      padding: '10px 14px',
                      background: expanded ? 'var(--bg-soft, #f8fafc)' : 'transparent',
                      border: 'none',
                      borderRadius: 8,
                      cursor: 'pointer',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 14,
                      textAlign: 'left',
                    }}
                  >
                    <span>
                      <strong style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                        {c.cause}
                      </strong>
                      <span className="muted small" style={{ marginLeft: 10 }}>
                        {telnyxErrorLabel(c.cause)}
                      </span>
                    </span>
                    <span>
                      <strong>{c.count}</strong> {c.count === 1 ? 'failure' : 'failures'}
                      <span style={{ marginLeft: 8, color: 'var(--text-muted, #64748b)' }}>{expanded ? '▾' : '▸'}</span>
                    </span>
                  </button>
                  {expanded && (
                    <div style={{ padding: '8px 14px 14px', borderTop: '1px solid var(--border, #e2e8f0)' }}>
                      <p className="muted small" style={{ marginTop: 0, marginBottom: 8 }}>
                        Showing up to 5 sample failures (most recent):
                      </p>
                      <table className="users-admin-table" style={{ fontSize: 13 }}>
                        <thead>
                          <tr>
                            <th>Recipient</th>
                            <th>Sent at</th>
                            <th>Error code</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.samples.map((s) => (
                            <tr key={s.id}>
                              <td>{s.toNumber}</td>
                              <td>{new Date(s.sentAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}</td>
                              <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{s.errorCode ?? '(none)'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="muted small">No outbound message failures in this period. Nice. ✓</div>
      )}
    </div>
  );
}

// Small reusable stat card used in MessagesQualityBlock above.
function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'ok' | 'warn' | 'err';
}) {
  const color = accent === 'ok' ? '#0a7d23'
    : accent === 'warn' ? '#ff9500'
    : accent === 'err' ? '#d70015'
    : 'var(--text, #0f172a)';
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 8,
        border: '1px solid var(--border, #e2e8f0)',
        minWidth: 130,
        background: 'var(--bg, #ffffff)',
      }}
    >
      <div className="muted small" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

// Maps known Telnyx error codes to human-readable descriptions so admin
// doesn't need to cross-reference Telnyx's error code reference every time.
// Extend this list as we encounter more codes in production.
function telnyxErrorLabel(code: string): string {
  const map: Record<string, string> = {
    '30001': 'Queue overflow / rate-limited',
    '30002': 'Account suspended',
    '30003': 'Unreachable destination handset',
    '30004': 'Message blocked by recipient',
    '30005': 'Unknown destination handset',
    '30006': 'Landline / unreachable carrier',
    '30007': 'Carrier filtering / message rejected by carrier',
    '30008': 'Unknown error from Telnyx',
    '30009': 'Missing inbound segment',
    '30010': 'Message price exceeds max price',
    '40002': 'Message body too long',
    '40003': 'Invalid sender / destination number',
    '40004': 'Invalid SMS encoding',
    '40005': 'Missing required parameter',
    '40010': 'Message blocked by content filter',
    '(no error code)': '(Telnyx returned no error code on this failure)',
  };
  return map[code] ?? '(see Telnyx error reference)';
}

// ---------------------------------------------------------------------------
// Phase 8.1 — Cost report (#207)
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
  if (loading && !data) return <div className="muted">Loading…</div>;
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
        Defaults: ${data.pricing.inboundPerMin}/min inbound · ${data.pricing.outboundPerMin}/min outbound · ${data.pricing.perSms}/SMS · ${data.pricing.didMonthly}/DID/mo. Override via env: <code>TELNYX_COST_INBOUND_PER_MIN</code> etc.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.1 — Recruiter metrics (#208)
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
  if (loading && !data) return <div className="muted">Loading…</div>;
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
// Phase 8.1 — Health alerts (#210)
// Polls every 60s. No cron yet — admin refreshes the page to recompute.
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
  if (loading && !data) return <div className="muted">Loading…</div>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return null;

  const sevIcon = (s: string) => s === 'critical' ? <Siren size={16} /> : s === 'warn' ? <AlertTriangle size={16} /> : <Activity size={16} />;

  return (
    <div className="alerts">
      <div className="liveops-header">
        <div>
          <h3 style={{ margin: 0 }}>Health alerts</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Refreshes every 60s · {data.alerts.length} alerts active
          </p>
        </div>
      </div>

      <div className="liveops-breakdown">
        <div className="liveops-pill missed">🔴 {data.counts.critical} critical</div>
        <div className="liveops-pill out" style={{ background: 'rgba(255,149,0,0.16)', color: '#ff9500' }}>⚠️ {data.counts.warn} warnings</div>
        <div className="liveops-pill in" style={{ background: 'rgba(118,118,128,0.16)', color: 'var(--text-muted)' }}>ℹ️ {data.counts.info} info</div>
      </div>

      {data.alerts.length === 0 ? (
        <div className="admin-empty">
          <p>🎉 <strong>All clear.</strong></p>
          <p className="muted small">No anomalies detected right now.</p>
        </div>
      ) : (
        <ul className="alerts-list">
          {data.alerts.map((a, i) => (
            <li key={i} className={`alert-row ${a.severity}`}>
              <span className="alert-icon">{sevIcon(a.severity)}</span>
              <div className="alert-text">
                <div className="alert-message">{a.message}</div>
                {a.userName && <div className="muted small">{a.userName} · {a.userEmail}</div>}
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

// ---------------------------------------------------------------------------
// v0.10.22 — Teams connection section (admin only).
//
// Tenant-wide setting: connects the ACE Bot service account
// (acebot@aptask.com) to Microsoft Graph via delegated OAuth. Once
// connected, all Teams DMs (line_assigned, missed_call, voicemail, SMS)
// flow through Graph API using the stored refresh token.
//
// Flow:
//   - GET /admin/microsoft/oauth/status → shows current connection state
//   - "Connect" button → opens /admin/microsoft/oauth/initiate in a popup
//   - Popup completes Microsoft sign-in, posts message back, popup closes
//   - We re-fetch status to show "Connected as acebot@aptask.com"
//   - "Disconnect" button → POSTs to /admin/microsoft/oauth/disconnect
// ---------------------------------------------------------------------------

function TeamsConnectionSection() {
  const [status, setStatus] = useState<MsGraphStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function refresh() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    try {
      const s = await getMsGraphStatus(token);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Listen for the popup's postMessage when OAuth completes.
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; success?: boolean } | null;
      if (d?.type === 'ms-oauth-result') {
        setConnecting(false);
        // Re-fetch status whether success or fail; status endpoint
        // will reflect the new state if tokens got stored.
        void refresh();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function handleConnect() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    setConnecting(true);
    try {
      const { redirectUrl } = await initiateMsGraphConnect(token);
      const popup = window.open(
        redirectUrl,
        'ms-oauth',
        'width=520,height=700',
      );
      if (!popup) {
        setError('Browser blocked the popup. Allow popups and try again.');
        setConnecting(false);
        return;
      }
      // Fallback: if user closes popup without completing, stop spinner
      // after 5 minutes max.
      window.setTimeout(() => {
        setConnecting((c) => (c ? false : c));
      }, 5 * 60_000);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to start sign-in');
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Disconnect ACE Bot from Microsoft Teams? Teams DMs will stop firing until you reconnect.')) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setDisconnecting(true);
    try {
      await disconnectMsGraph(token);
      await refresh();
    } catch (e) {
      setError((e as Error).message ?? 'Disconnect failed');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) return <div className="muted">Loading…</div>;

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Connect the <strong>ACE Bot</strong> service account
        (<code>acebot@aptask.com</code>) to Microsoft Teams. Once connected,
        the dialer sends Teams direct messages for line assignments, missed
        calls, voicemails, and SMS — directly from ACE Bot.
      </p>

      {error && (
        <div className="error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {status?.connected ? (
        <div
          style={{
            background: 'rgba(34, 197, 94, 0.10)',
            border: '1px solid rgba(34, 197, 94, 0.35)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Check size={18} />
            <strong>Connected as {status.account}</strong>
          </div>
          <div className="muted small">
            Access token expires:{' '}
            {status.expiresAt ? new Date(status.expiresAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '—'}
            <br />
            Last refresh:{' '}
            {status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '—'}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            The refresh token has a 90-day sliding window; regular notifications
            extend it indefinitely. If the bot account password changes or
            tenant policy revokes the grant, click Disconnect and reconnect.
          </p>
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={handleDisconnect}
            disabled={disconnecting}
            style={{ marginTop: 6 }}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <div
          style={{
            background: 'rgba(128, 128, 128, 0.08)',
            border: '1px solid rgba(128, 128, 128, 0.2)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 12,
          }}
        >
          <p style={{ margin: '0 0 10px' }}>
            <strong>Not connected.</strong> Click below to sign in as ACE Bot
            and grant the required Teams permissions.
          </p>
          <p className="muted small" style={{ margin: '0 0 12px' }}>
            A Microsoft sign-in window will pop up. Sign in as{' '}
            <code>acebot@aptask.com</code> (NOT your personal account) and
            click Accept on the permission prompt. The window will close
            automatically.
          </p>
          <button
            type="button"
            className="settings-btn"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? 'Waiting for sign-in…' : 'Connect to Microsoft Teams'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v0.10.26 — What's New section.
//
// User-facing release notes. Plain English, grouped by version. Three
// change types (new / improved / fixed) with distinct icons + colors.
// Data lives in apps/web/src/data/whatsNew.ts so adding a new version
// is a single-file edit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v0.10.51 — Admin view of all users' blocked numbers.
//
// Admin can see EVERY user's blocklist with reason + who blocked. Override
// (delete) any block. The override fires an audit log entry so the
// previously-blocking user can see in their personal blocklist later
// that the block was removed by an admin (we don't auto-notify, but the
// audit trail exists for accountability).
// ---------------------------------------------------------------------------

function BlockedNumbersAdminSection() {
  const [items, setItems] = useState<AdminBlockedNumber[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    try {
      const rows = await listAdminBlockedNumbers(token);
      setItems(rows);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function handleOverride(row: AdminBlockedNumber) {
    const userName = [row.user.firstName, row.user.lastName].filter(Boolean).join(' ').trim() || row.user.email;
    if (!confirm(
      `Remove ${userName}'s block on ${row.number}?\n` +
      `Reason given: "${row.reason ?? '(no reason)'}".\n\n` +
      `Future calls and SMS from this number will reach ${userName} again. The admin override is recorded in the audit log.`,
    )) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusy(row.id);
    setError(null);
    const r = await adminRemoveBlockedNumber(token, row.id);
    setBusy(null);
    if (r.ok) {
      setItems((prev) => (prev ?? []).filter((x) => x.id !== row.id));
    } else {
      setError(r.error ?? 'Failed to remove block');
    }
  }

  if (items === null && !error) {
    return <div className="muted">Loading…</div>;
  }

  const filtered = (items ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const userName = [r.user.firstName, r.user.lastName].filter(Boolean).join(' ').toLowerCase();
    if (userName.includes(q)) return true;
    if (r.user.email.toLowerCase().includes(q)) return true;
    if (r.number.toLowerCase().includes(q)) return true;
    if ((r.reason ?? '').toLowerCase().includes(q)) return true;
    return false;
  });

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Every block created by any user on the team, with the reason they gave
        and when. Click <strong>Override</strong> to remove a block on someone's
        behalf — the action is recorded in the audit log under your account.
      </p>

      <div className="search-bar" style={{ marginBottom: 12 }}>
        <input
          type="search"
          className="search-input"
          placeholder="Search by user, number, or reason"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {filtered.length === 0 ? (
        <div className="muted" style={{ padding: '2rem 0' }}>
          {(items ?? []).length === 0
            ? 'No blocks across the team yet.'
            : 'No blocks match that search.'}
        </div>
      ) : (
        <table className="users-admin-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>User</th>
              <th>Number</th>
              <th>Reason</th>
              <th>Blocked</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const name = [r.user.firstName, r.user.lastName].filter(Boolean).join(' ').trim();
              return (
                <tr key={r.id}>
                  <td>
                    <div>{name || r.user.email}</div>
                    {name && (
                      <div className="muted small">{r.user.email}</div>
                    )}
                    {!r.user.isActive && (
                      <div className="muted small" style={{ color: '#d70015' }}>inactive</div>
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.number}</td>
                  <td className="muted small">{r.reason ?? <em>(no reason)</em>}</td>
                  <td className="muted small">
                    {new Date(r.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="device-action danger"
                      onClick={() => handleOverride(r)}
                      disabled={busy === r.id}
                      title="Remove this block on the user's behalf"
                    >
                      {busy === r.id ? 'Removing…' : 'Override'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v0.10.52 — SMS Templates admin section.
//
// Admin-only. Lists all tenant SMS templates, allows create / edit /
// archive, and exposes a one-click "seed default playbook" button that
// loads the built-in 20-template recruiter playbook (idempotent — safe
// to re-run; only inserts templates that don't already exist).
// ---------------------------------------------------------------------------

const SMS_TEMPLATE_CATEGORY_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'outreach', label: 'Initial outreach' },
  { key: 'docs', label: 'Documents & profile' },
  { key: 'submission', label: 'Submission' },
  { key: 'interview', label: 'Interview' },
  { key: 'followup', label: 'Follow-ups & status' },
  { key: 'outcome', label: 'Outcomes' },
  { key: 'bgv', label: 'Onboarding & BGV' },
  { key: 'relationship', label: 'Relationship maintenance' },
  { key: 'custom', label: 'Custom' },
];

function SmsTemplatesAdminSection() {
  const [templates, setTemplates] = useState<SmsTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<SmsTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  async function reload() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const items = await listAdminSmsTemplates(token);
    setTemplates(items);
  }

  useEffect(() => { void reload(); }, []);

  async function handleSeed() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setBusy('seed');
    setSeedResult(null);
    const r = await seedSmsTemplateDefaults(token);
    setBusy(null);
    if (r.ok) {
      setSeedResult(
        `Inserted ${r.inserted ?? 0} new template${(r.inserted ?? 0) === 1 ? '' : 's'}` +
        (r.skipped ? `, skipped ${r.skipped} that already exist` : '') + '.',
      );
      await reload();
    } else {
      setSeedResult(`Failed: ${r.error ?? 'unknown error'}`);
    }
  }

  async function handleArchive(id: number) {
    if (!confirm('Archive this template? It will disappear from users\' picker. You can un-archive by editing.')) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    await archiveSmsTemplate(token, id);
    await reload();
  }

  if (templates === null) {
    return <div className="muted">Loading templates…</div>;
  }

  const grouped: Record<string, SmsTemplate[]> = {};
  for (const t of templates) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Templates appear in every user's SMS compose box as a picker. They
        can have <code>{`{firstName}`}</code> (auto-filled from the contact) and
        other <code>{`{placeholder}`}</code> variables that the user fills inline.
      </p>

      <div className="device-actions" style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          className="device-action primary"
          onClick={() => setShowCreate(true)}
        >
          New template
        </button>
        <button
          type="button"
          className="device-action"
          onClick={handleSeed}
          disabled={busy === 'seed'}
          title="Inserts the 20 built-in recruiter templates. Skips any already present."
        >
          {busy === 'seed' ? 'Seeding…' : 'Seed default playbook'}
        </button>
      </div>

      {seedResult && (
        <p className="muted small" style={{ marginBottom: '1rem' }}>{seedResult}</p>
      )}

      {templates.length === 0 ? (
        <div className="muted" style={{ padding: '2rem 0' }}>
          No templates yet. Click "Seed default playbook" to load the
          built-in 20 recruiter templates, or "New template" to write your own.
        </div>
      ) : (
        <>
          {SMS_TEMPLATE_CATEGORY_OPTIONS.map((cat) => {
            const list = grouped[cat.key];
            if (!list || list.length === 0) return null;
            return (
              <div key={cat.key} style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: 14, margin: '0 0 8px', opacity: 0.7 }}>{cat.label}</h3>
                <table className="users-admin-table" style={{ width: '100%' }}>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id} style={{ opacity: t.isActive === false ? 0.5 : 1 }}>
                        <td style={{ width: '30%', fontWeight: 600 }}>
                          {t.name}
                          {t.isActive === false && <span className="muted small"> · archived</span>}
                        </td>
                        <td className="muted small" style={{ fontSize: 12 }}>
                          {t.body.length > 100 ? t.body.slice(0, 100) + '…' : t.body}
                        </td>
                        <td style={{ width: 140, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className="device-action"
                            onClick={() => setEditing(t)}
                            style={{ marginRight: 6 }}
                          >
                            Edit
                          </button>
                          {t.isActive !== false && (
                            <button
                              type="button"
                              className="device-action danger"
                              onClick={() => handleArchive(t.id)}
                            >
                              Archive
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </>
      )}

      {(showCreate || editing) && (
        <SmsTemplateEditModal
          template={editing ?? undefined}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={() => { setShowCreate(false); setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
}

function SmsTemplateEditModal({
  template,
  onClose,
  onSaved,
}: {
  template?: SmsTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState(template?.category ?? 'custom');
  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [sortOrder, setSortOrder] = useState(String(template?.sortOrder ?? 100));
  const [isActive, setIsActive] = useState(template?.isActive !== false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!category.trim() || !name.trim() || !body.trim()) {
      setError('Category, name, and body are all required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const input = {
      category: category.trim(),
      name: name.trim(),
      body: body.trim(),
      sortOrder: parseInt(sortOrder, 10) || 100,
      isActive,
    };
    const r = template
      ? await updateSmsTemplate(token, template.id, input)
      : await createSmsTemplate(token, input);
    setSubmitting(false);
    if (r.ok) {
      onSaved();
    } else {
      setError(r.error ?? 'Save failed');
    }
  }

  return (
    <div className="compose-modal" onClick={submitting ? undefined : onClose}>
      <div
        className="fav-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="sms-tmpl-title"
        style={{ maxWidth: 640 }}
      >
        <div className="fav-modal-header">
          <MessageSquare size={18} className="fav-modal-icon" />
          <h3 id="sms-tmpl-title">{template ? 'Edit template' : 'New template'}</h3>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="fav-modal-row">
            <label className="fav-modal-field">
              <span className="fav-modal-label">Category</span>
              <select
                className="fav-modal-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={submitting}
                style={{ colorScheme: 'light dark' }}
              >
                {SMS_TEMPLATE_CATEGORY_OPTIONS.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </label>
            <label className="fav-modal-field">
              <span className="fav-modal-label">Name</span>
              <input
                type="text"
                className="fav-modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Cold outreach"
                disabled={submitting}
                required
              />
            </label>
          </div>

          <label className="fav-modal-field" style={{ marginTop: 8 }}>
            <span className="fav-modal-label">Body</span>
            <textarea
              className="fav-modal-input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Hi {firstName}, this is {recruiter} from ApTask..."
              disabled={submitting}
              required
              style={{ fontFamily: 'inherit', resize: 'vertical' }}
            />
            <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
              Variables in <code>{`{curlyBraces}`}</code> are placeholders.
              <code>{`{firstName}`}</code> auto-fills from the contact; others are filled inline by the user.
            </span>
          </label>

          <div className="fav-modal-row" style={{ marginTop: 8 }}>
            <label className="fav-modal-field">
              <span className="fav-modal-label">Sort order (within category)</span>
              <input
                type="number"
                inputMode="numeric"
                className="fav-modal-input"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                min={0}
                max={9999}
                disabled={submitting}
              />
            </label>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24, fontSize: '0.92rem' }}
            >
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                disabled={submitting}
              />
              Active (visible to users)
            </label>
          </div>

          {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" className="device-action" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="device-action primary" disabled={submitting}>
              {submitting ? 'Saving…' : (template ? 'Save changes' : 'Create template')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// v0.10.74 — Admin Praise / Announcements section.
//
// Admin composes a celebratory message: pick category, pick recipient
// (one user or broadcast), set the displayed recipient name (defaults to
// the picked user's name; editable for "Congrats Ankit Patel" style
// messages where the subject is external to ACE), write the body, send.
// History list below shows the last 100 praises this admin has sent
// with delete affordance per row.
// v0.10.76 — Admin Ringtones library section.
//
// Mirror of HoldMusicSection's upload pattern, but for a LIST of files
// instead of one. Admin picks an audio file, gives it a name, hits
// Upload — backend stores base64 in Ringtone.dataUrl. The full list
// renders below with rename / preview / activate-toggle / delete
// affordances per row.
function RingtonesAdminSection() {
  const [list, setList] = useState<UploadedRingtone[]>([]);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<number | null>(null);

  function refresh() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void listAdminRingtones(token).then(setList);
  }
  useEffect(refresh, []);

  async function fileToDataUrl(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(f);
    });
  }

  async function handleUpload() {
    setError(null);
    setOkMsg(null);
    if (!file) { setError('Pick an audio file first.'); return; }
    if (!name.trim()) { setError('Give this ringtone a name (e.g. "Office", "Phone Booth").'); return; }
    // Reject anything >400KB raw; base64 will inflate ~33% to ~530KB.
    if (file.size > 400_000) {
      setError(`File is ${Math.round(file.size / 1024)}KB — please use a shorter or more compressed clip (under 400KB raw).`);
      return;
    }
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setUploading(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await createRingtone(token, { name: name.trim(), dataUrl });
      if ('error' in r) {
        setError(r.error);
      } else {
        setOkMsg(`"${r.name}" uploaded. Every user can pick it from their Settings → Personal → Ringtone.`);
        setName('');
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function preview(r: UploadedRingtone) {
    // Stop any current preview.
    if (previewAudioRef.current) {
      try { previewAudioRef.current.pause(); } catch { /* noop */ }
      previewAudioRef.current = null;
    }
    if (previewingId === r.id) {
      setPreviewingId(null);
      return;
    }
    const audio = new Audio(r.dataUrl);
    audio.loop = false;
    previewAudioRef.current = audio;
    setPreviewingId(r.id);
    audio.onended = () => setPreviewingId((p) => (p === r.id ? null : p));
    void audio.play().catch((e) => {
      setError(`Preview failed: ${e.message}`);
      setPreviewingId(null);
    });
  }

  async function handleRename(id: number, current: string) {
    const next = prompt('Rename ringtone:', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const r = await updateRingtone(token, id, { name: trimmed });
    if ('error' in r) alert(`Rename failed: ${r.error}`);
    else refresh();
  }

  async function handleToggle(id: number, makeActive: boolean) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const r = await updateRingtone(token, id, { isActive: makeActive });
    if ('error' in r) alert(`Toggle failed: ${r.error}`);
    else refresh();
  }

  async function handleDelete(id: number, label: string) {
    if (!confirm(`Delete "${label}"? Anyone currently using it falls back to the default ring.`)) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const r = await deleteRingtone(token, id);
    if (!r.ok) alert(`Delete failed: ${r.error}`);
    else refresh();
  }

  return (
    <div className="settings-section">
      <p className="settings-blurb">
        Upload custom ringtones for everyone in the tenant. Each user picks
        their favorite from Settings → Personal → Ringtone. Short MP3 or
        WAV clips work best — keep them under 400KB (a 5-10 second clip
        at typical MP3 bitrates).
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, maxWidth: 520 }}>
        <label className="fav-modal-field">
          <span className="fav-modal-label">Name</span>
          <input
            type="text"
            className="fav-modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "Office", "Phone Booth", "Doorbell"'
            disabled={uploading}
          />
        </label>
        <label className="fav-modal-field">
          <span className="fav-modal-label">Audio file</span>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={uploading}
          />
          {file && (
            <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
              {file.name} ({Math.round(file.size / 1024)}KB)
            </span>
          )}
        </label>
        {error && <p className="error small">{error}</p>}
        {okMsg && <p className="muted small" style={{ color: '#34c759' }}>{okMsg}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="device-action primary"
            onClick={handleUpload}
            disabled={uploading || !file || !name.trim()}
          >
            {uploading ? 'Uploading…' : 'Upload ringtone'}
          </button>
        </div>
      </div>

      {list.length > 0 && (
        <>
          <h4 style={{ marginBottom: 8 }}>Library ({list.length})</h4>
          <ul className="ringtone-list">
            {list.map((r) => (
              <li key={r.id} className="ringtone-row" style={{ opacity: r.isActive === false ? 0.55 : 1 }}>
                <div className="ringtone-pick" style={{ cursor: 'default' }}>
                  <span className="ringtone-name">
                    {r.name}
                    {r.isActive === false && <span className="muted small" style={{ marginLeft: 8 }}>(hidden)</span>}
                  </span>
                  <span className="ringtone-hint muted">
                    {Math.round(r.dataUrl.length / 1024)}KB · sort {r.sortOrder}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="device-action" onClick={() => preview(r)}>
                    {previewingId === r.id ? '◼ Stop' : '▶ Play'}
                  </button>
                  <button type="button" className="device-action" onClick={() => handleRename(r.id, r.name)}>Rename</button>
                  <button
                    type="button"
                    className="device-action"
                    onClick={() => handleToggle(r.id, r.isActive === false)}
                  >
                    {r.isActive === false ? 'Show' : 'Hide'}
                  </button>
                  <button type="button" className="device-action" onClick={() => handleDelete(r.id, r.name)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PraiseAdminSection() {
  const [category, setCategory] = useState<PraiseCategoryUI>('new_offer');
  const [targetMode, setTargetMode] = useState<'one' | 'broadcast'>('one');
  const [targetUserId, setTargetUserId] = useState<string>('');
  const [recipientName, setRecipientName] = useState('');
  // v0.10.89 — Editable headline override. Admin can write whatever they
  // want (e.g. "Great work, Abdulla!" when praising a recruiter instead
  // of "Welcome aboard"). Blank = recipient modal falls back to the
  // category default.
  const [headline, setHeadline] = useState('');
  const [message, setMessage] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [history, setHistory] = useState<Praise[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Load active users + history once on mount.
  useEffect(() => {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void listAdminUsers(token).then((rows) => setUsers(rows.filter((u) => u.isActive)));
    void listAdminPraises(token).then(setHistory);
  }, []);

  // When admin picks a user from the dropdown, default recipientName to
  // their first+last. Admin can override (e.g. external candidate name).
  // v0.10.95 — Only auto-fill for Celebrations and Welcomes. Announcements,
  // Alerts, and Reminders don't have a "celebrated person" so we never
  // surface the field — auto-filling would leak a name into the payload.
  useEffect(() => {
    const group = BROADCAST_META[category]?.group;
    const needsName = group === 'Celebrations' || group === 'Welcomes';
    if (!needsName) return;
    if (targetMode === 'one' && targetUserId) {
      const u = users.find((x) => String(x.id) === targetUserId);
      if (u) {
        const joined = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
        if (joined) setRecipientName(joined);
      }
    }
  }, [targetUserId, targetMode, users, category]);

  async function handleSend() {
    setError(null);
    setOkMsg(null);
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    if (!message.trim()) {
      setError('Write something — the message can\'t be blank.');
      return;
    }
    if (targetMode === 'one' && !targetUserId) {
      setError('Pick a recipient (or switch to Broadcast).');
      return;
    }
    setSending(true);
    const r = await createPraise(token, {
      category,
      toUserId: targetMode === 'broadcast' ? null : Number(targetUserId),
      recipientName: recipientName.trim() || undefined,
      message: message.trim(),
      // v0.10.89 — send headline only if admin actually typed something
      // (blank → backend stores NULL → recipient modal uses category default).
      headline: headline.trim() || undefined,
    });
    setSending(false);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setHistory((prev) => [r, ...prev]);
    setOkMsg(targetMode === 'broadcast'
      ? 'Sent to everyone. They\'ll see it on their next dialer screen.'
      : 'Sent. The recipient will see it within ~60 seconds.');
    setMessage('');
    setHeadline('');
    // v0.10.74 — Poke the PraiseModal poller so the sender sees their own
    // broadcast immediately (when they're a recipient of broadcast too)
    // instead of waiting up to 60s.
    window.dispatchEvent(new CustomEvent('ace:praise-poke'));
    // Keep category + recipient so admin can quickly send another similar.
  }

  async function handleDelete(praiseId: number) {
    if (!confirm('Delete this broadcast? Anyone who hasn\'t seen it yet won\'t.')) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    const r = await deletePraise(token, praiseId);
    if (!r.ok) {
      alert(r.error ?? 'Delete failed');
      return;
    }
    setHistory((prev) => prev.filter((p) => p.id !== praiseId));
  }

  // v0.10.93 — Just pull from BROADCAST_META now that we have 15 categories.
  // Falls back gracefully if a row has an unknown category from a future
  // version (e.g. database has a category we don't recognize in this build).
  const categoryLabel = (c: PraiseCategoryUI | string): string => {
    return BROADCAST_META[c as PraiseCategoryUI]?.label ?? `(${c})`;
  };

  return (
    <div className="settings-section praise-admin">
      <p className="settings-blurb">
        Send a pop-up message to one user or broadcast to everyone.
        Recipients see a big modal next time they're idle in the dialer
        (mid-call recipients see it after the call ends). One-way — no
        replies. Use for celebrations (new hires, offers, birthdays,
        anniversaries), announcements (version updates, maintenance,
        office closures, policy changes), alerts (urgent notices,
        service outages), reminders (deadlines, training), and
        welcomes (onboarding).
      </p>

      <div className="praise-admin-form">
        {/* v0.10.93 — Category dropdown grouped by type. Five groups:
            Celebrations (existing praise), Announcements, Alerts,
            Reminders, Welcomes. Each option's default headline appears
            in the Headline field below the moment it's selected. */}
        <label className="fav-modal-field">
          <span className="fav-modal-label">Category</span>
          <select
            className="fav-modal-input"
            value={category}
            onChange={(e) => {
              const next = e.target.value as PraiseCategoryUI;
              setCategory(next);
              // Auto-clear headline so the new default shows in preview.
              setHeadline('');
              // v0.10.95 — Clear recipientName when switching to a category
              // where the field isn't even visible (Announcements / Alerts /
              // Reminders). Otherwise old "Ankit Patel" lingers in state
              // and would be sent on the wire — making the headline
              // accidentally include a name on an announcement modal.
              const newGroup = BROADCAST_META[next].group;
              if (newGroup !== 'Celebrations' && newGroup !== 'Welcomes') {
                setRecipientName('');
              }
            }}
            disabled={sending}
          >
            {(['Celebrations', 'Announcements', 'Alerts', 'Reminders', 'Welcomes'] as const).map((groupName) => {
              const optionsInGroup = (Object.entries(BROADCAST_META) as Array<[PraiseCategoryUI, BroadcastCategoryMeta]>)
                .filter(([, m]) => m.group === groupName);
              return (
                <optgroup key={groupName} label={groupName}>
                  {optionsInGroup.map(([value, m]) => (
                    <option key={value} value={value}>{m.label}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>

        <fieldset className="praise-admin-target">
          <legend className="fav-modal-label">Who sees this?</legend>
          <label>
            <input
              type="radio"
              name="praise-target"
              value="one"
              checked={targetMode === 'one'}
              onChange={() => setTargetMode('one')}
              disabled={sending}
            />
            <span>One user</span>
          </label>
          <label>
            <input
              type="radio"
              name="praise-target"
              value="broadcast"
              checked={targetMode === 'broadcast'}
              onChange={() => setTargetMode('broadcast')}
              disabled={sending}
            />
            <span>Everyone (broadcast)</span>
          </label>
        </fieldset>

        {targetMode === 'one' && (
          <label className="fav-modal-field">
            <span className="fav-modal-label">Recipient</span>
            <select
              className="fav-modal-input"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              disabled={sending}
            >
              <option value="">— Pick a user —</option>
              {users.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* v0.10.95 — Display Name field only makes sense for Celebrations
            and Welcomes (categories where there's a specific person being
            recognized). For Announcements, Alerts, and Reminders, there's
            no "person being celebrated" — these are general communications
            and the recipient modal won't append a name to the headline. So
            we hide the field entirely for those groups. */}
        {(() => {
          const g = BROADCAST_META[category].group;
          const needsName = g === 'Celebrations' || g === 'Welcomes';
          if (!needsName) return null;
          const isCeleb = g === 'Celebrations';
          return (
            <label className="fav-modal-field">
              <span className="fav-modal-label">
                {isCeleb ? "Display name (who's being celebrated)" : "Display name (who's being welcomed)"}
              </span>
              <input
                type="text"
                className="fav-modal-input"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder={
                  targetMode === 'broadcast'
                    ? 'e.g. Ankit Patel'
                    : '(defaults to recipient\'s name)'
                }
                disabled={sending}
              />
              <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
                {isCeleb
                  ? <>Shown after the headline, e.g. "Welcome aboard <strong>Ankit Patel</strong>". Leave blank to skip.</>
                  : <>Shown after the headline, e.g. "Welcome <strong>Ankit Patel</strong>". Leave blank to skip.</>}
              </span>
            </label>
          );
        })()}

        {/* v0.10.89 — Headline override. Admin can fully edit the big bold
            text that shows at the top of the recipient's praise modal.
            Default-suggested headlines now reflect the most common ApTask
            usage (praising a recruiter for a placement) instead of
            welcoming the new hire. Blank → recipient sees category default. */}
        <label className="fav-modal-field">
          <span className="fav-modal-label">Headline (the big bold text)</span>
          <input
            type="text"
            className="fav-modal-input"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            // v0.10.93 — Headline placeholder pulls the category's default
            // headline straight from BROADCAST_META. Admin can override
            // freely; blank → recipient sees the default.
            placeholder={`e.g. ${BROADCAST_META[category].defaultHeadline}${recipientName ? ' ' + recipientName.split(' ')[0] : ''}`}
            disabled={sending}
            maxLength={120}
          />
          <span className="muted small" style={{ marginTop: 4, display: 'block' }}>
            Leave blank to use the default headline for <strong>{BROADCAST_META[category].label}</strong>:
            "{BROADCAST_META[category].defaultHeadline}".
            Customize when the default doesn't fit.
          </span>
        </label>

        <label className="fav-modal-field">
          <span className="fav-modal-label">Message</span>
          <textarea
            className="fav-modal-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            // v0.10.93 — Message placeholder also from BROADCAST_META.
            placeholder={BROADCAST_META[category].messagePlaceholder}
            rows={3}
            disabled={sending}
          />
        </label>

        {/* v0.10.89 — Live preview of what the recipient will see. Updates
            in real time as admin edits headline / recipient / message.
            Renders a miniature version of PraiseModal's layout so admin
            sees exactly what's coming before they click Send. */}
        {(message.trim() || headline.trim()) && (
          <div className="praise-preview-pane" style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 10,
            background: 'var(--bg-soft, #f8fafc)',
            border: '1px dashed var(--border, #cbd5e1)',
          }}>
            <div className="muted small" style={{ marginBottom: 10, fontWeight: 600 }}>
              Live preview — this is what the recipient will see:
            </div>
            <div style={{
              padding: '18px 20px',
              borderRadius: 12,
              background: '#fff',
              boxShadow: '0 4px 18px rgba(15,23,42,0.08)',
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: 18,
                fontWeight: 700,
                color: '#0f172a',
                marginBottom: 8,
              }}>
                {headline.trim() || (() => {
                  // v0.10.93/95 — Match PraiseModal's fallback exactly.
                  // BROADCAST_META is the source of truth for default
                  // headline per category. We append recipientName ONLY for
                  // categories where it's semantically meaningful — that's
                  // Celebrations ("Welcome aboard Ankit") and Welcomes
                  // ("Welcome Ankit"). For announcements / alerts /
                  // reminders the Display Name field is hidden so this
                  // branch never has a name to append anyway.
                  const meta = BROADCAST_META[category];
                  const base = meta.defaultHeadline;
                  const appendsName = meta.group === 'Celebrations' || meta.group === 'Welcomes';
                  return appendsName && recipientName.trim()
                    ? `${base} ${recipientName.trim()}`
                    : base;
                })()}
              </div>
              <div style={{
                fontSize: 14,
                color: '#334155',
                marginBottom: 10,
                whiteSpace: 'pre-wrap',
              }}>
                {message.trim() || <em style={{ color: '#94a3b8' }}>(message body will appear here)</em>}
              </div>
              <div className="muted small">
                From you
              </div>
            </div>
          </div>
        )}

        {error && <div className="error small">{error}</div>}
        {okMsg && <div className="muted small" style={{ color: '#34c759' }}>{okMsg}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="device-action primary"
            onClick={handleSend}
            disabled={sending || !message.trim() || (targetMode === 'one' && !targetUserId)}
          >
            {(() => {
              if (sending) return 'Sending…';
              // v0.10.95 — Context-aware label. Different verb + emoji
              // per category group so the button reads sensibly for
              // whatever admin is actually sending.
              const group = BROADCAST_META[category].group;
              switch (group) {
                case 'Celebrations': return 'Send praise 🎉';
                case 'Announcements': return 'Send announcement 📢';
                case 'Alerts':       return 'Send alert ⚠️';
                case 'Reminders':    return 'Send reminder 🔔';
                case 'Welcomes':     return 'Send welcome 👋';
                default:             return 'Send';
              }
            })()}
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="praise-admin-history" style={{ marginTop: 24 }}>
          <h4 style={{ marginBottom: 8 }}>Recent broadcasts sent</h4>
          <ul className="praise-history-list">
            {history.map((p) => (
              <li key={p.id} className="praise-history-row">
                <div className="praise-history-row-text">
                  <div className="praise-history-row-headline">
                    <strong>{categoryLabel(p.category as PraiseCategoryUI)}</strong>
                    {' · '}
                    {p.toUserId === null
                      ? <em>Everyone</em>
                      : p.toUser
                        ? `${[p.toUser.firstName, p.toUser.lastName].filter(Boolean).join(' ')}`
                        : `User #${p.toUserId}`}
                    {p.recipientName && p.recipientName !== `${p.toUser?.firstName ?? ''} ${p.toUser?.lastName ?? ''}`.trim() &&
                      ` (about ${p.recipientName})`}
                  </div>
                  <div className="praise-history-row-message muted">{p.message}</div>
                  <div className="praise-history-row-meta muted small">
                    Sent {new Date(p.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}
                    {typeof p._count?.reads === 'number' && ` · Seen by ${p._count.reads}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => handleDelete(p.id)}
                  aria-label="Delete broadcast"
                  title="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Local type alias matching the API. Mirrored here so this file's imports
// stay tight; the source-of-truth is PraiseCategory in api.ts.
// v0.10.93 — Broadcast categories. Mirrors PraiseCategory from api.ts.
// Originally only celebration variants; now spans Celebrations, Announcements,
// Alerts, Reminders, and Welcomes.
type PraiseCategoryUI =
  | 'new_hire' | 'new_offer' | 'birthday' | 'anniversary' | 'custom'
  | 'announcement' | 'update_required' | 'maintenance' | 'holiday' | 'policy_update'
  | 'alert_urgent' | 'service_outage'
  | 'reminder' | 'training'
  | 'welcome';

// Metadata used by the admin Broadcast form: label, group, default
// headline, and placeholder message. The PraiseModal has the
// authoritative icon/accent map — this metadata is just for the admin
// composer dropdown + suggested copy.
type BroadcastCategoryMeta = {
  label: string;
  group: 'Celebrations' | 'Announcements' | 'Alerts' | 'Reminders' | 'Welcomes';
  defaultHeadline: string;
  messagePlaceholder: string;
};
const BROADCAST_META: Record<PraiseCategoryUI, BroadcastCategoryMeta> = {
  // Celebrations
  new_hire:    { label: 'New hire',         group: 'Celebrations', defaultHeadline: 'Welcome aboard',       messagePlaceholder: 'Welcome to ApTask! Excited to have you on the team.' },
  new_offer:   { label: 'New offer',        group: 'Celebrations', defaultHeadline: 'New offer!',           messagePlaceholder: 'on your offer with Mphasis — Puneeth' },
  birthday:    { label: 'Birthday',         group: 'Celebrations', defaultHeadline: 'Happy birthday',       messagePlaceholder: 'Hope you have an amazing day 🎂' },
  anniversary: { label: 'Work anniversary', group: 'Celebrations', defaultHeadline: 'Work anniversary',     messagePlaceholder: '3 years at ApTask today — thank you for everything!' },
  custom:      { label: 'Custom praise',    group: 'Celebrations', defaultHeadline: 'A note from the team', messagePlaceholder: 'Write a short, celebratory message…' },
  // Announcements
  announcement:    { label: 'General announcement', group: 'Announcements', defaultHeadline: 'Announcement',              messagePlaceholder: 'Share what the team needs to know.' },
  update_required: { label: 'Update required',      group: 'Announcements', defaultHeadline: 'Please update your dialer', messagePlaceholder: 'Quit and reopen ACE Dialer to install the latest version. Lots of fixes for connection stability — worth doing today.' },
  maintenance:     { label: 'Maintenance window',   group: 'Announcements', defaultHeadline: 'Scheduled maintenance',     messagePlaceholder: 'We\'ll be doing maintenance on the phone system from 9–10 PM tonight. Calls may briefly be unavailable.' },
  holiday:         { label: 'Holiday / office closure', group: 'Announcements', defaultHeadline: 'Office closed',         messagePlaceholder: 'The office will be closed on Monday for Memorial Day. Calls will continue to route normally.' },
  policy_update:   { label: 'Policy update',        group: 'Announcements', defaultHeadline: 'Policy update',             messagePlaceholder: 'New policy effective Monday — please read the updated SOP in the shared drive.' },
  // Alerts
  alert_urgent:   { label: 'Urgent alert',  group: 'Alerts', defaultHeadline: 'Important — please read', messagePlaceholder: 'Something urgent the team needs to know NOW.' },
  service_outage: { label: 'Service notice', group: 'Alerts', defaultHeadline: 'Service notice',         messagePlaceholder: 'Telnyx is experiencing a partial outage. Calls may be intermittent for the next hour.' },
  // Reminders
  reminder: { label: 'Generic reminder',  group: 'Reminders', defaultHeadline: 'Reminder',         messagePlaceholder: 'Don\'t forget timesheets are due by EOD Friday.' },
  training: { label: 'Training reminder', group: 'Reminders', defaultHeadline: 'Training session', messagePlaceholder: 'Training session at 3 PM EST today — Zoom link in your calendar.' },
  // Welcomes
  welcome: { label: 'Welcome', group: 'Welcomes', defaultHeadline: 'Welcome to the team', messagePlaceholder: 'A short welcome note for someone joining the team.' },
};

function WhatsNewSection() {
  return (
    <div className="settings-section whats-new">
      <p className="settings-blurb">
        See what's been added, improved, and fixed in recent updates.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '0.75rem' }}>
        {WHATS_NEW.map((release) => (
          <ReleaseCard key={release.version} release={release} />
        ))}
      </div>

      <p
        className="muted small"
        style={{ marginTop: '2rem', textAlign: 'center' }}
      >
        Suggestions or bug reports? Email{' '}
        <a href="mailto:support@aptask.com">support@aptask.com</a>.
      </p>
    </div>
  );
}

function ReleaseCard({ release }: { release: typeof WHATS_NEW[number] }) {
  return (
    <div
      style={{
        border: '1px solid var(--divider, rgba(128,128,128,0.2))',
        borderRadius: 10,
        padding: '14px 18px',
        background: 'var(--surface, rgba(128,128,128,0.04))',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: release.highlight ? 4 : 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>v{release.version}</h3>
        <span className="muted small">{release.date}</span>
      </div>

      {release.highlight && (
        <div
          style={{
            fontWeight: 600,
            color: 'var(--accent, #0a84ff)',
            marginBottom: 12,
          }}
        >
          {release.highlight}
        </div>
      )}

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        {release.changes.map((change, i) => (
          <ChangeRow key={i} type={change.type} text={change.text} />
        ))}
      </ul>
    </div>
  );
}

function ChangeRow({ type, text }: { type: ChangeType; text: string }) {
  const config = {
    new: {
      icon: <Zap size={14} />,
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.12)',
      label: 'NEW',
    },
    improved: {
      icon: <Sparkles size={14} />,
      color: '#0a84ff',
      bg: 'rgba(10, 132, 255, 0.12)',
      label: 'IMPROVED',
    },
    fixed: {
      icon: <Wrench size={14} />,
      color: '#a855f7',
      bg: 'rgba(168, 85, 247, 0.12)',
      label: 'FIXED',
    },
  }[type];

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        lineHeight: 1.45,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          background: config.bg,
          color: config.color,
          fontSize: '0.65rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          flexShrink: 0,
          marginTop: 2,
          minWidth: 70,
          justifyContent: 'center',
        }}
      >
        {config.icon}
        {config.label}
      </span>
      <span style={{ flex: 1 }}>{text}</span>
    </li>
  );
}

// ─── v0.10.92 — TipsAdminSection ───────────────────────────────────────────
//
// Admin-only management page for the floating tip banner. Lets admins:
//   * Toggle built-in tips on/off (default tips seeded at first API boot)
//   * Author custom tips (title, body, optional emoji, adminOnly flag)
//   * Edit / delete custom tips
//
// Built-in tips can be DISABLED (so admin can hide a tip without losing
// its content) but not deleted — keeping the curated content available.
// Custom tips are fully editable + deletable.
function TipsAdminSection() {
  const [tips, setTips] = useState<AdminTip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Custom-tip form state
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newIcon, setNewIcon] = useState('💡');
  const [newAdminOnly, setNewAdminOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function refresh() {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setLoading(true);
    void listAdminTips(token).then((rows) => {
      setTips(rows);
      setLoading(false);
    }).catch((e) => {
      setError((e as Error).message ?? 'Failed to load tips');
      setLoading(false);
    });
  }
  useEffect(() => { refresh(); }, []);

  async function handleToggleEnabled(id: number, isEnabled: boolean) {
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    const r = await updateTip(token, id, { isEnabled });
    if ('error' in r) { setError(r.error); return; }
    setTips((prev) => prev.map((t) => (t.id === id ? { ...t, isEnabled } : t)));
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this custom tip? Built-ins can\'t be deleted — disable instead.')) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setError(null);
    const r = await deleteTip(token, id);
    if (!r.ok) { setError(r.error ?? 'Delete failed'); return; }
    setTips((prev) => prev.filter((t) => t.id !== id));
  }

  async function handleCreate() {
    setError(null);
    setOkMsg(null);
    const title = newTitle.trim();
    const body = newBody.trim();
    if (!title || !body) {
      setError('Both Title and Body are required.');
      return;
    }
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    setSubmitting(true);
    const r = await createTip(token, {
      title,
      body,
      icon: newIcon.trim() || undefined,
      adminOnly: newAdminOnly,
    });
    setSubmitting(false);
    if ('error' in r) { setError(r.error); return; }
    setTips((prev) => [...prev, r]);
    setNewTitle('');
    setNewBody('');
    setNewIcon('💡');
    setNewAdminOnly(false);
    setOkMsg('Tip created. It\'ll appear in users\' rotation within ~5 minutes (or sooner if they refresh).');
    setTimeout(() => setOkMsg(null), 4000);
  }

  if (loading && tips.length === 0) {
    return <div className="muted">Loading tips…</div>;
  }

  const builtIns = tips.filter((t) => t.isBuiltIn);
  const customs = tips.filter((t) => !t.isBuiltIn);

  return (
    <div className="settings-section tips-admin">
      <p className="settings-blurb">
        These tips rotate in a floating card on every screen of the dialer.
        Each one stays visible for at least 10 seconds before auto-advancing.
        Built-in tips can be disabled but not deleted. Custom tips are
        fully editable.
      </p>

      {/* Custom-tip create form */}
      <div className="praise-admin-form" style={{ marginBottom: 28 }}>
        <h4 style={{ marginTop: 0, marginBottom: 12 }}>Add a custom tip</h4>
        <label className="fav-modal-field" style={{ marginBottom: 8 }}>
          <span className="fav-modal-label">Icon (single emoji, optional)</span>
          <input
            type="text"
            className="fav-modal-input"
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value.slice(0, 4))}
            placeholder="💡"
            maxLength={4}
            style={{ width: 80 }}
          />
        </label>
        <label className="fav-modal-field" style={{ marginBottom: 8 }}>
          <span className="fav-modal-label">Title</span>
          <input
            type="text"
            className="fav-modal-input"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Short headline (max 120 chars)"
            maxLength={120}
          />
        </label>
        <label className="fav-modal-field" style={{ marginBottom: 8 }}>
          <span className="fav-modal-label">Body</span>
          <textarea
            className="fav-modal-input"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="One-sentence explanation of the feature and where to find it."
            rows={3}
            maxLength={500}
          />
        </label>
        <label className="fav-modal-field" style={{ display: 'flex', flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={newAdminOnly}
            onChange={(e) => setNewAdminOnly(e.target.checked)}
          />
          <span>Admin only (hide from regular users)</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="device-action primary"
            onClick={handleCreate}
            disabled={submitting || !newTitle.trim() || !newBody.trim()}
          >
            {submitting ? 'Adding…' : 'Add tip'}
          </button>
        </div>
        {error && <div className="error small" style={{ marginTop: 8 }}>{error}</div>}
        {okMsg && <div className="muted small" style={{ marginTop: 8, color: '#34c759' }}>{okMsg}</div>}
      </div>

      {/* Built-in tips — list */}
      <div style={{ marginBottom: 24 }}>
        <h4 style={{ marginBottom: 8 }}>Built-in tips ({builtIns.length})</h4>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {builtIns.map((t) => (
            <TipsAdminRow
              key={t.id}
              tip={t}
              onToggleEnabled={(en) => handleToggleEnabled(t.id, en)}
            />
          ))}
        </ul>
      </div>

      {/* Custom tips — list */}
      {customs.length > 0 && (
        <div>
          <h4 style={{ marginBottom: 8 }}>Custom tips ({customs.length})</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {customs.map((t) => (
              <TipsAdminRow
                key={t.id}
                tip={t}
                onToggleEnabled={(en) => handleToggleEnabled(t.id, en)}
                onDelete={() => handleDelete(t.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TipsAdminRow({
  tip,
  onToggleEnabled,
  onDelete,
}: {
  tip: AdminTip;
  onToggleEnabled: (en: boolean) => void;
  onDelete?: () => void;
}) {
  return (
    <li
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: 12,
        borderRadius: 8,
        background: tip.isEnabled ? 'var(--bg-soft, #f8fafc)' : 'transparent',
        border: '1px solid var(--border, #e2e8f0)',
        opacity: tip.isEnabled ? 1 : 0.55,
      }}
    >
      <div style={{ flexShrink: 0, fontSize: 22, lineHeight: 1, paddingTop: 2 }}>
        {tip.icon || '💡'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {tip.title}
          {tip.adminOnly && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                padding: '2px 6px',
                background: 'rgba(176, 0, 191, 0.12)',
                color: '#9c1bb3',
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              ADMIN ONLY
            </span>
          )}
        </div>
        <div className="muted small">{tip.body}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={tip.isEnabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
          Enabled
        </label>
        {onDelete && (
          <button
            type="button"
            className="icon-btn"
            onClick={onDelete}
            aria-label="Delete tip"
            title="Delete custom tip"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#d70015' }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

// v0.10.100 - VoicemailMigrationModal - Per-user admin migration flow
// for the Call Control voicemail rollout. Loads the user's current
// migration state, lets the admin run migrate or rollback, and shows the
// per-DID outcome inline.
function VoicemailMigrationModal({
  user,
  onClose,
}: {
  user: AdminUserRow;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<VoicemailMigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<'migrate' | 'rollback' | null>(null);
  const [result, setResult] = useState<VoicemailMigrationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // v0.10.110 - admin-supplied EMAIL for the Telnyx DID tag.
  // Always empty - admin must type explicitly so the right person
  // gets tagged (no stale prefill).
  const [migrationTag, setMigrationTag] = useState<string>('');

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      const s = await getVoicemailMigrationStatus(token, user.id);
      setStatus(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function runMigrate() {
    if (!status) return;
    if (!status.ccAppConfigured) {
      setError('TELNYX_VOICEMAIL_CC_APP_ID is not configured on the API service. Set it in Render env vars and redeploy.');
      return;
    }
    const tagTrim = migrationTag.trim();
    if (!tagTrim) {
      setError('Enter the user email - required so the DID stays identifiable in Telnyx after migration.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tagTrim)) {
      setError('Enter a valid email address (e.g. user@example.com).');
      return;
    }
    if (!confirm(
      'Migrate ' + status.totalDids + ' DID(s) for ' + (status.user.name || status.user.email) + ' to the Call Control voicemail flow?\n\n' +
      'WHAT HAPPENS:\n' +
      ' \u2022 The DID(s) will move OFF the user\'s Credential Connection in Telnyx and onto the Voicemail Voice API app.\n' +
      ' \u2022 Inbound calls will route through our webhook server before reaching the user\'s dialer (one extra hop than the standard SIP-direct flow).\n' +
      ' \u2022 The DID(s) will be tagged "' + tagTrim + '" in Telnyx so admins can identify them in the Numbers panel.\n' +
      ' \u2022 The user\'s Credential Connection stays ENABLED (do not disable it) - it\'s still required for SIP registration and transferred call delivery.\n\n' +
      'You can roll back from this same modal at any time. Continue?',
    )) return;
    setError(null);
    setResult(null);
    setRunning('migrate');
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      const r = await migrateUserToCallControlVoicemail(token, user.id, tagTrim);
      setResult(r);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  }

  async function runRollback() {
    if (!status) return;
    if (!confirm(
      'Roll back ' + status.migratedDids + ' migrated DID(s) for ' + (status.user.name || status.user.email) + '?\n\n' +
      'This restores their previous SIP credential routing and re-enables Telnyx Hosted Voicemail. The custom greeting flow stops firing for these DIDs.',
    )) return;
    setError(null);
    setResult(null);
    setRunning('rollback');
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      const r = await rollbackUserFromCallControlVoicemail(token, user.id);
      setResult(r);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div
      className="compose-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        className="compose-modal"
        style={{
          background: 'var(--bg, #fff)',
          color: 'var(--fg, #111)',
          borderRadius: 12,
          maxWidth: 720,
          width: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border, #e2e8f0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 17 }}>
            <Mic size={18} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Voicemail migration - {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
          </h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ fontSize: 20, lineHeight: 1 }}
          >
            x
          </button>
        </div>
        <div
          ref={bodyRef}
          className="modal-body"
          style={{ padding: 18, overflowY: 'auto', flex: 1 }}
        >
          {loading && <div className="muted">Loading migration state...</div>}
          {!loading && status && (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                Migration switches this user's DID routing from the legacy
                SIP-credential / Hosted Voicemail path to the new Call Control
                flow (softphone rings for ~25s, then falls to their custom
                greeting). Rollback restores the previous routing exactly.
              </p>
              {!status.ccAppConfigured && (
                <div
                  className="error small"
                  style={{
                    padding: 10,
                    background: 'rgba(215, 0, 21, 0.08)',
                    border: '1px solid rgba(215, 0, 21, 0.3)',
                    borderRadius: 6,
                    color: '#dc2626',
                    marginBottom: 12,
                  }}
                >
                  <strong>TELNYX_VOICEMAIL_CC_APP_ID not set.</strong> Set the env
                  var on the API service in Render (the Application ID of your
                  ACE Voicemail Voice API app in Telnyx) and redeploy.
                </div>
              )}
              {!status.user.sipUsername && (
                <div
                  className="error small"
                  style={{
                    padding: 10,
                    background: 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                >
                  <strong>User has no SIP credential.</strong> Provision one first
                  via Manage lines.
                </div>
              )}
              <div style={{ marginBottom: 14 }}>
                <strong>DIDs ({status.totalDids} total, {status.migratedDids} migrated):</strong>
              </div>
              {status.dids.length === 0 ? (
                <p className="muted small">No DIDs assigned to this user.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 14 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-soft, #f8fafc)' }}>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>DID</th>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Label</th>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>State</th>
                      <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Migrated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.dids.map((d) => (
                      <tr key={d.id}>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                          <code>{d.didNumber}</code> {d.isDefault && <span className="muted small">(default)</span>}
                        </td>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>{d.label}</td>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                          {d.migratedAt ? (
                            <span style={{ color: '#0a7d23', fontWeight: 500 }}>Call Control</span>
                          ) : (
                            <span className="muted">Legacy SIP / Hosted VM</span>
                          )}
                        </td>
                        <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                          {d.migratedAt ? new Date(d.migratedAt).toLocaleString() : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {/* v0.10.109 - tag input + safety warning before Migrate */}
              {status.migratedDids < status.totalDids && (
                <>
                  <div
                    style={{
                      background: '#fef3c7',
                      border: '1px solid #fbbf24',
                      borderRadius: 8,
                      padding: '12px 14px',
                      marginBottom: 12,
                      fontSize: 13,
                      color: '#78350f',
                      lineHeight: 1.5,
                    }}
                  >
                    <strong>Before migrating:</strong> the DID(s) will move
                    off this user&apos;s Credential Connection in Telnyx
                    and onto the Voicemail Voice API app. The Credential
                    Connection itself stays enabled (don&apos;t disable
                    it - it&apos;s still needed for SIP registration).
                    Calls will route through our webhook server instead
                    of direct SIP delivery, so any webhook outage will
                    mean missed calls until rollback.
                  </div>
                  <label
                    style={{
                      display: 'block',
                      marginBottom: 12,
                      fontSize: 13,
                      fontWeight: 500,
                      color: '#374151',
                    }}
                  >
                    User email (required) - stamped onto the DID as a
                    Telnyx tag so the number stays identifiable in the
                    Numbers panel after it moves:
                    <input
                      type="email"
                      value={migrationTag}
                      onChange={(e) => setMigrationTag(e.target.value)}
                      placeholder="e.g. bhuvesh@aptask.com"
                      autoComplete="off"
                      maxLength={80}
                      style={{
                        display: 'block',
                        width: '100%',
                        marginTop: 6,
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid #d1d5db',
                        fontSize: 14,
                        boxSizing: 'border-box',
                      }}
                    />
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400 }}>
                      Type the user&apos;s email. No autofill - explicit
                      entry every time so the right person gets tagged.
                    </span>
                  </label>
                </>
              )}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="device-action primary"
                  disabled={
                    running !== null ||
                    !status.ccAppConfigured ||
                    !status.user.sipUsername ||
                    status.totalDids === 0 ||
                    status.migratedDids === status.totalDids
                  }
                  onClick={runMigrate}
                  style={{
                    background: '#2563eb',
                    color: '#fff',
                    borderColor: '#2563eb',
                  }}
                >
                  {running === 'migrate' ? 'Migrating...' : 'Migrate to Call Control'}
                </button>
                <button
                  type="button"
                  className="device-action"
                  disabled={running !== null || status.migratedDids === 0}
                  onClick={runRollback}
                >
                  {running === 'rollback' ? 'Rolling back...' : 'Roll back'}
                </button>
              </div>
              {error && (
                <div
                  className="error small"
                  style={{
                    marginTop: 14,
                    padding: 10,
                    background: 'rgba(215, 0, 21, 0.08)',
                    border: '1px solid rgba(215, 0, 21, 0.3)',
                    borderRadius: 6,
                    color: '#dc2626',
                    wordBreak: 'break-word',
                  }}
                >
                  {error}
                </div>
              )}
              {result && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    background: result.ok ? 'rgba(52, 199, 89, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid ' + (result.ok ? 'rgba(52, 199, 89, 0.3)' : 'rgba(245, 158, 11, 0.3)'),
                    borderRadius: 6,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    {result.ok ? 'Success: ' : 'Partial: '}
                    {result.summary.successCount} succeeded
                    {result.summary.failCount > 0 ? ', ' + result.summary.failCount + ' failed' : ''}
                    {result.summary.alreadyCount ? ', ' + result.summary.alreadyCount + ' already migrated' : ''}.
                  </div>
                  {result.message && <div className="muted small">{result.message}</div>}
                  {result.results.length > 0 && (
                    <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 12 }}>
                      {result.results.map((r) => (
                        <li key={r.didId}>
                          <code>{r.didNumber}</code>{' - '}
                          {r.status === 'failed'
                            ? <span style={{ color: '#dc2626' }}>{r.error}</span>
                            : r.status === 'already_migrated'
                              ? 'already migrated'
                              : r.status === 'rolled_back'
                                ? 'rolled back'
                                : 'migrated'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
          {!loading && !status && error && (
            <div className="error small" style={{ color: '#dc2626' }}>{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// v0.10.101 — Devices modal. Shows each device the user has signed into,
// with platform / appVersion / lastSeen, plus a "Force update" button
// that signals the client to run autoUpdater on its next heartbeat.
function UserDevicesModal({
  user,
  onClose,
}: {
  user: AdminUserRow;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<UserDeviceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      const list = await getUserDevices(token, user.id);
      setDevices(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleForceUpdate(deviceId: string) {
    if (!confirm('Send a force-update request to this device? It will trigger autoUpdater.checkForUpdatesAndNotify() on the user\'s next heartbeat (within 60 seconds).')) return;
    setError(null);
    setOkMsg(null);
    setBusyDeviceId(deviceId);
    try {
      const token = sessionStorage.getItem('ace_token');
      if (!token) { setError('Sign in again.'); return; }
      await requestDeviceForceUpdate(token, user.id, deviceId);
      setOkMsg('Force-update requested. The device will trigger an update check within ~60 seconds.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyDeviceId(null);
    }
  }

  function fmtAge(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || !Number.isFinite(ms)) return iso;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    return day + 'd ago';
  }

  return (
    <div
      className="compose-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        className="compose-modal"
        style={{
          background: 'var(--bg, #fff)',
          color: 'var(--fg, #111)',
          borderRadius: 12,
          maxWidth: 820,
          width: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border, #e2e8f0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 17 }}>
            <Stethoscope size={18} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Devices &mdash; {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
          </h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ fontSize: 20, lineHeight: 1 }}
          >
            x
          </button>
        </div>
        <div className="modal-body" style={{ padding: 18, overflowY: 'auto', flex: 1 }}>
          {loading && <div className="muted">Loading devices...</div>}
          {!loading && devices && devices.length === 0 && (
            <p className="muted small" style={{ marginTop: 0 }}>
              This user has not reported any devices yet. The first heartbeat will appear
              after they sign into the dialer with the v0.10.101 (or later) build.
            </p>
          )}
          {!loading && devices && devices.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-soft, #f8fafc)' }}>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Platform</th>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Version</th>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Last seen</th>
                  <th style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--border, #e2e8f0)' }}>First seen</th>
                  <th style={{ padding: 8, textAlign: 'right', borderBottom: '1px solid var(--border, #e2e8f0)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const reqAt = d.forceUpdateRequestedAt;
                  const ackAt = d.forceUpdateAckedAt;
                  const pending = !!reqAt && (!ackAt || new Date(ackAt) < new Date(reqAt));
                  return (
                    <tr key={d.id}>
                      <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                        <code>{d.platform}</code>
                        {d.osLabel && <div className="muted small" style={{ marginTop: 2, fontSize: 11 }}>{d.osLabel.slice(0, 60)}</div>}
                      </td>
                      <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                        <code>{d.appVersion}</code>
                      </td>
                      <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }} title={d.lastSeenAt}>
                        {fmtAge(d.lastSeenAt)}
                      </td>
                      <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)' }} title={d.firstSeenAt}>
                        {fmtAge(d.firstSeenAt)}
                      </td>
                      <td style={{ padding: 8, borderBottom: '1px solid var(--border, #e2e8f0)', textAlign: 'right' }}>
                        {pending ? (
                          <span style={{ color: '#d97706', fontSize: 12 }}>Update pending</span>
                        ) : (
                          <button
                            type="button"
                            className="device-action"
                            onClick={() => handleForceUpdate(d.deviceId)}
                            disabled={busyDeviceId !== null}
                            style={{ fontSize: 12 }}
                          >
                            {busyDeviceId === d.deviceId ? 'Sending...' : 'Force update'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {error && (
            <div className="error small" style={{ marginTop: 12, padding: 10, background: 'rgba(215, 0, 21, 0.08)', border: '1px solid rgba(215, 0, 21, 0.3)', borderRadius: 6, color: '#dc2626' }}>
              {error}
            </div>
          )}
          {okMsg && (
            <div className="muted small" style={{ marginTop: 12, padding: 10, background: 'rgba(52, 199, 89, 0.08)', border: '1px solid rgba(52, 199, 89, 0.3)', borderRadius: 6, color: '#0a7d23' }}>
              {okMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
