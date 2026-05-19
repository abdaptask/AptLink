import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PhoneOff,
  Mic,
  MicOff,
  Grid3x3,
  Volume2,
  UserPlus,
  Pause,
  Play,
  PhoneForwarded,
  MessageSquare,
  X,
  ArrowLeftRight,
  Merge,
  Check,
  SignalHigh,
  SignalMedium,
  SignalLow,
  Signal,
} from 'lucide-react';
import { useSip } from '../contexts/SipContext';
import { ringtone } from '../services/ringtone';
import { useJobDivaContact } from '../hooks/useJobDivaContact';
import { formatPhone } from '../lib/phone';
import type { CallQuality } from '../services/sip';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(n: string | undefined): string {
  return formatPhone(n);
}

const DTMF_KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export default function InCall() {
  const {
    callState,
    callQuality,
    hangup,
    hangupCall,
    toggleMute,
    toggleHold,
    transferCall,
    sendDTMF,
    hasSecondCall,
    secondCallNumber,
    secondCallId,
    swapCalls,
    mergeCalls,
    listAudioOutputs,
    setAudioOutput,
  } = useSip();
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showAudio, setShowAudio] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeAudioId, setActiveAudioId] = useState<string>(() =>
    localStorage.getItem('ace_speaker') ?? 'default',
  );
  const navigate = useNavigate();

  // Tick the duration once we're connected.
  useEffect(() => {
    if (callState.state !== 'connected') return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [callState.state]);

  // Local ringback while we're waiting for the other side to pick up.
  // Some VoIP destinations don't send early media so we'd otherwise hear silence.
  useEffect(() => {
    if (callState.state === 'calling' || callState.state === 'ringing') {
      ringtone.start();
      return () => ringtone.stop();
    }
    return undefined;
  }, [callState.state]);

  // Auto-return to keypad after the call ends.
  useEffect(() => {
    if (callState.state === 'ended' || callState.state === 'idle') {
      const t = setTimeout(() => navigate('/keypad'), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [callState.state, navigate]);

  // Auto-dismiss the toast after 2s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((msg: string) => setToast(msg), []);

  const handleMute = () => setMuted(toggleMute());
  const handleHold = () => setOnHold(toggleHold());
  const handleDTMF = (digit: string) => {
    sendDTMF(digit);
  };
  const handleOpenAudio = async () => {
    setShowAudio(true);
    const list = await listAudioOutputs();
    setAudioDevices(list);
  };
  const handlePickAudio = async (deviceId: string) => {
    await setAudioOutput(deviceId);
    setActiveAudioId(deviceId);
    setShowAudio(false);
    showToast('Audio output updated');
  };

  const handleTransfer = async () => {
    const t = transferTarget.trim();
    if (!t) return;
    showToast(`Transferring to ${t}…`);
    const res = await transferCall(t);
    if (res.ok) {
      setShowTransfer(false);
      setTransferTarget('');
    } else {
      showToast(res.hint ?? res.error ?? 'Transfer failed');
    }
  };

  const otherNumber =
    callState.direction === 'inbound'
      ? callState.fromNumber ?? callState.number
      : callState.toNumber ?? callState.number;
  const jd = useJobDivaContact(otherNumber);
  const callerLabel = jd?.name ?? (formatNumber(otherNumber) || 'Calling…');

  const subtitle =
    callState.state === 'calling' ? 'Calling…' :
    callState.state === 'ringing' ? 'Ringing…' :
    callState.state === 'connected' ? formatDuration(duration) :
    callState.state === 'ended' ? (callState.hangupCause ? `Ended (${callState.hangupCause})` : 'Ended') :
    '';

  const isConnected = callState.state === 'connected';

  return (
    <div className="in-call">
      {hasSecondCall ? (
        // Two-call mode: show BOTH calls as matching pill cards so the user
        // sees each number, knows which is active vs held, and can end either
        // independently. Tap the held card to swap.
        <div className="calls-strip">
          <div className="call-pill active">
            <div className="call-pill-info">
              <span className="call-pill-tag">Active</span>
              <span className="call-pill-num">{callerLabel}</span>
              <span className="call-pill-status">
                {subtitle}
                {isConnected && callQuality.level !== 'unknown' && (
                  <QualityIndicator quality={callQuality} />
                )}
              </span>
            </div>
            <button
              type="button"
              className="call-pill-end"
              onClick={hangup}
              title="End the active call"
              aria-label="End active call"
            >
              <PhoneOff size={16} />
            </button>
          </div>
          <div className="call-pill held">
            <button
              type="button"
              className="call-pill-info call-pill-tap"
              onClick={() => swapCalls()}
              title="Tap to swap to this call"
            >
              <span className="call-pill-tag">On hold</span>
              <span className="call-pill-num">
                {formatNumber(secondCallNumber ?? undefined)}
              </span>
              <span className="call-pill-status">
                <ArrowLeftRight size={12} /> Tap to swap
              </span>
            </button>
            <button
              type="button"
              className="call-pill-end"
              onClick={() => {
                if (secondCallId) {
                  hangupCall(secondCallId);
                  showToast('Ended held call');
                }
              }}
              title="End the held call"
              aria-label="End held call"
            >
              <PhoneOff size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="in-call-header">
          <div className="in-call-name">{callerLabel}</div>
          <div className="in-call-time">
            {subtitle}
            {isConnected && callQuality.level !== 'unknown' && (
              <QualityIndicator quality={callQuality} />
            )}
          </div>
        </div>
      )}

      {!showKeypad && !showTransfer && (
        <div className="in-call-grid">
          <ControlBtn
            icon={muted ? <MicOff size={26} /> : <Mic size={26} />}
            label={muted ? 'Unmute' : 'Mute'}
            active={muted}
            onClick={handleMute}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<Grid3x3 size={26} />}
            label="Keypad"
            onClick={() => setShowKeypad(true)}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<Volume2 size={26} />}
            label="Audio"
            onClick={handleOpenAudio}
          />
          {hasSecondCall ? (
            <ControlBtn
              icon={<Merge size={26} />}
              label="Merge"
              onClick={async () => {
                const ok = await mergeCalls();
                showToast(ok ? 'Merged into conference' : 'Merge failed');
              }}
              disabled={!isConnected}
            />
          ) : (
            <ControlBtn
              icon={<UserPlus size={26} />}
              label="Add Call"
              onClick={() => navigate('/keypad', { state: { addCall: true } })}
              disabled={!isConnected}
            />
          )}
          <ControlBtn
            icon={onHold ? <Play size={26} /> : <Pause size={26} />}
            label={onHold ? 'Resume' : 'Hold'}
            active={onHold}
            onClick={handleHold}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<PhoneForwarded size={26} />}
            label="Transfer"
            onClick={() => setShowTransfer(true)}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<MessageSquare size={26} />}
            label="Message"
            onClick={() => {
              const other =
                callState.direction === 'inbound'
                  ? callState.fromNumber ?? callState.number
                  : callState.toNumber ?? callState.number;
              if (other) navigate(`/messages?to=${encodeURIComponent(other)}`);
              else navigate('/messages');
            }}
          />
          {/* Two empty cells keep the 3x3 grid visually symmetric */}
          <div className="ic-ctrl-placeholder" aria-hidden="true" />
          <div className="ic-ctrl-placeholder" aria-hidden="true" />
        </div>
      )}

      {showAudio && (
        <div className="audio-picker" role="dialog" aria-label="Audio output">
          <div className="audio-picker-box">
            <div className="audio-picker-title">Audio output</div>
            {audioDevices.length === 0 ? (
              <div className="audio-picker-empty">
                No output devices detected.
                <br />
                <span className="muted" style={{ fontSize: 12 }}>
                  Grant microphone permission to enumerate audio devices.
                </span>
              </div>
            ) : (
              <ul className="audio-picker-list">
                {audioDevices.map((d) => {
                  const id = d.deviceId || 'default';
                  const active = activeAudioId === id;
                  return (
                    <li
                      key={id}
                      className={`audio-picker-item${active ? ' active' : ''}`}
                      onClick={() => handlePickAudio(id)}
                    >
                      <span className="audio-picker-label">
                        {d.label || (id === 'default' ? 'System default' : id.slice(0, 8))}
                      </span>
                      {active && <Check size={16} />}
                    </li>
                  );
                })}
              </ul>
            )}
            <button className="audio-picker-close" onClick={() => setShowAudio(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {showKeypad && (
        <div className="in-call-keypad">
          <div className="ick-grid">
            {DTMF_KEYS.map((k) => (
              <button
                key={k}
                className="ick-btn"
                onClick={() => handleDTMF(k)}
              >{k}</button>
            ))}
          </div>
          <button className="ick-close" onClick={() => setShowKeypad(false)} aria-label="Close keypad">
            <X size={20} /> Hide keypad
          </button>
        </div>
      )}

      {showTransfer && (
        <div className="in-call-transfer">
          <div className="ict-label">Transfer to</div>
          <input
            className="ict-input"
            placeholder="+1 555 123 4567"
            value={transferTarget}
            onChange={(e) => setTransferTarget(e.target.value)}
            autoFocus
          />
          <div className="ict-actions">
            <button className="ict-cancel" onClick={() => { setShowTransfer(false); setTransferTarget(''); }}>
              Cancel
            </button>
            <button
              className="ict-confirm"
              disabled={!transferTarget.trim()}
              onClick={handleTransfer}
            >
              Transfer
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        className="hangup-btn"
        onClick={hangup}
        aria-label="Hang up"
      >
        <PhoneOff size={28} />
      </button>

      {toast && <div className="in-call-toast">{toast}</div>}
    </div>
  );
}

function ControlBtn({
  icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ic-ctrl${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="ic-ctrl-icon">{icon}</span>
      <span className="ic-ctrl-label">{label}</span>
    </button>
  );
}

function QualityIndicator({ quality }: { quality: CallQuality }) {
  const Icon =
    quality.level === 'good' ? SignalHigh :
    quality.level === 'fair' ? SignalMedium :
    quality.level === 'poor' ? SignalLow :
    Signal;
  const label =
    quality.level === 'good' ? 'Good connection' :
    quality.level === 'fair' ? 'Fair connection' :
    quality.level === 'poor' ? 'Poor connection' :
    'Measuring…';
  const jitterMs = (quality.jitter * 1000).toFixed(0);
  const lossPct = (quality.loss * 100).toFixed(1);
  const rttMs = quality.rtt !== null ? (quality.rtt * 1000).toFixed(0) : '—';
  const title = `${label} · jitter ${jitterMs}ms · loss ${lossPct}% · rtt ${rttMs}ms`;
  return (
    <span className={`call-quality call-quality-${quality.level}`} title={title} aria-label={label}>
      <Icon size={14} />
    </span>
  );
}
