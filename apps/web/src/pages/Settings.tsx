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
} from 'lucide-react';
import { getMe, updateMe } from '../api';
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
} from '../lib/userPrefs';

interface AudioDevice {
  deviceId: string;
  label: string;
}

interface SectionDef {
  key: string;
  label: string;
  icon: typeof Mic;
  blurb: string;
  Component: React.FC;
}

const SECTIONS: SectionDef[] = [
  { key: 'account', label: 'Account', icon: UserCircle, blurb: 'Name, DID, SIP', Component: AccountSection },
  { key: 'appearance', label: 'Appearance', icon: Palette, blurb: 'Light / dark / system', Component: AppearanceSection },
  { key: 'telnyx', label: 'Telnyx', icon: Phone, blurb: 'SIP credentials', Component: TelnyxSection },
  { key: 'microphone', label: 'Microphone', icon: Mic, blurb: 'Input device', Component: MicrophoneSection },
  { key: 'speaker', label: 'Speaker', icon: Volume2, blurb: 'Output device', Component: SpeakerSection },
  { key: 'notifications', label: 'Notifications', icon: Bell, blurb: 'Calls + SMS alerts', Component: NotificationsSection },
  { key: 'quick-replies', label: 'Quick replies', icon: MessageSquare, blurb: 'SMS templates', Component: QuickRepliesSection },
  { key: 'data', label: 'Data', icon: Database, blurb: 'Backup & restore', Component: DataSection },
];

const DEFAULT_SECTION = SECTIONS[0].key;

export default function Settings() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

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
        <nav className="settings-nav-list">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.key}
              to={`/settings/${s.key}`}
              className={({ isActive }) =>
                `settings-nav-item ${isActive ? 'active' : ''}`
              }
            >
              <span className="settings-nav-icon"><s.icon size={18} /></span>
              <span className="settings-nav-label">
                <span className="settings-nav-title">{s.label}</span>
                <span className="settings-nav-blurb">{s.blurb}</span>
              </span>
              <ChevronRight size={14} className="settings-nav-chev" />
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="settings-pane">
        <header className="settings-pane-header">
          <span className="settings-pane-icon"><active.icon size={20} /></span>
          <h2>{active.label}</h2>
        </header>
        <div className="settings-pane-body">
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
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
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
          setStatus('That doesn’t look like an ACE Dialer backup file.');
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
                    ↑
                  </button>
                  <button
                    type="button"
                    className="quick-reply-action"
                    onClick={() => move(idx, 1)}
                    disabled={idx === replies.length - 1}
                    aria-label="Move down"
                    title="Move down"
                  >
                    ↓
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
