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
  CircleDot,
  Video,
  MessageSquare,
  X,
} from 'lucide-react';
import { useSip } from '../contexts/SipContext';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(n: string | undefined): string {
  if (!n) return '';
  const d = n.replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return n;
}

const DTMF_KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export default function InCall() {
  const { callState, hangup, toggleMute, toggleHold, transferCall, sendDTMF } = useSip();
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const navigate = useNavigate();

  // Tick the duration once we're connected.
  useEffect(() => {
    if (callState.state !== 'connected') return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
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
  const handleTransfer = () => {
    const t = transferTarget.trim();
    if (!t) return;
    const ok = transferCall(t);
    if (ok) {
      showToast(`Transferring to ${t}…`);
      setShowTransfer(false);
      setTransferTarget('');
    } else {
      showToast('Transfer failed');
    }
  };

  // Caller display: outbound shows toNumber; inbound shows fromNumber.
  const callerLabel =
    formatNumber(
      callState.direction === 'inbound'
        ? callState.fromNumber ?? callState.number
        : callState.toNumber ?? callState.number,
    ) || 'Calling…';

  const subtitle =
    callState.state === 'calling' ? 'Calling…' :
    callState.state === 'ringing' ? 'Ringing…' :
    callState.state === 'connected' ? formatDuration(duration) :
    callState.state === 'ended' ? (callState.hangupCause ? `Ended (${callState.hangupCause})` : 'Ended') :
    '';

  const isConnected = callState.state === 'connected';

  return (
    <div className="in-call">
      <div className="in-call-header">
        <div className="in-call-name">{callerLabel}</div>
        <div className="in-call-time">{subtitle}</div>
      </div>

      {/* 3x3 control grid */}
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
            onClick={() => navigate('/settings')}
          />
          <ControlBtn
            icon={<UserPlus size={26} />}
            label="Add Call"
            onClick={() => showToast('Add Call — coming soon')}
            disabled={!isConnected}
          />
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
            icon={<CircleDot size={26} />}
            label="Record"
            onClick={() => showToast('Recording — Phase 5.7')}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<Video size={26} />}
            label="Meet"
            onClick={() => showToast('Meet — coming soon')}
            disabled={!isConnected}
          />
          <ControlBtn
            icon={<MessageSquare size={26} />}
            label="Message"
            onClick={() => showToast('Messages — Phase 5.3')}
          />
        </div>
      )}

      {/* In-call DTMF keypad */}
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

      {/* Transfer dialog */}
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
