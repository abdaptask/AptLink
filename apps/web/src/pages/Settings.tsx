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
  { key: 'hold-music', label: 'Hold music', icon: Music, blurb: 'Play music when on hold', Component: HoldMusicSection },
  { key: 'voicemail-greeting', label: 'Voicemail greeting', icon: Mic, blurb: 'Personal greeting (coming soon)', Component: VoicemailGreetingSection },
  { key: 'call-forwarding', label: 'Call forwarding', icon: PhoneForwarded, blurb: 'Forward calls to another number', Component: CallForwardingSection },
  { key: 'blocked-numbers', label: 'Blocked numbers', icon: ShieldOff, blurb: 'Reject calls & SMS from specific numbers', Component: BlockedNumbersSection },
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

  function pickFile() { fileRef.current?.click(); }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name)) {
      setError('That doesn’t look like an audio file.');
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
        Play music to the other party when you put a call on hold. Without
        this, they hear silence (which usually makes them assume the call
        dropped). Pick any MP3, WAV, or M4A file under 2 MB — it will loop
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
// Call Forwarding — per-user, Pulse-pattern feature.
// Forwards inbound calls to a backup number (e.g. your cell) either always
// or only on no-answer. The Save button hits our API which provisions Telnyx
// (PATCH /v2/phone_numbers/{id}/voice → call_forwarding block).
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
