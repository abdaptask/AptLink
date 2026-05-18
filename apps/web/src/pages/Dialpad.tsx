import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Phone, Delete } from 'lucide-react';
import { useSip } from '../contexts/SipContext';

interface DialpadLocationState {
  addCall?: boolean;
}

const KEYS: Array<{ digit: string; letters?: string }> = [
  { digit: '1' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*' },
  { digit: '0', letters: '+' },
  { digit: '#' },
];

const ALLOWED_KEYS = new Set(['0','1','2','3','4','5','6','7','8','9','*','#','+']);

function formatNumber(raw: string): string {
  const d = raw.replace(/[^\d*#+]/g, '');
  if (d.length === 0) return '';
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  if (d.length <= 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `+${d.slice(0, d.length - 10)} ${d.slice(-10, -7)} ${d.slice(-7, -4)} ${d.slice(-4)}`;
}

export default function Dialpad() {
  const [number, setNumber] = useState('');
  const { sipState, callState, call, addCall } = useSip();
  const navigate = useNavigate();
  const location = useLocation();
  const isAddCall =
    !!(location.state as DialpadLocationState | null)?.addCall &&
    callState.state !== 'idle';

  const append = useCallback((d: string) => setNumber((n) => n + d), []);
  const backspace = useCallback(() => setNumber((n) => n.slice(0, -1)), []);
  const clear = useCallback(() => setNumber(''), []);

  const handleCall = useCallback(async () => {
    if (!number) return;
    if (sipState !== 'registered') {
      alert(`Can't call yet — SIP state: ${sipState}. Wait for "Registered" badge above keypad.`);
      return;
    }
    if (isAddCall) {
      // Server-originated Leg B via Telnyx Call Control. Auto-bridges to
      // Leg A on answer so the user hears the new party.
      const res = await addCall(number);
      if (!res.ok) {
        alert(`Add Call failed: ${res.hint ?? res.error ?? 'unknown error'}`);
        return;
      }
    } else {
      call(number);
    }
    navigate('/in-call');
  }, [number, sipState, isAddCall, call, addCall, navigate]);

  // Keyboard input — listen at the document level so the dialpad is "always focused".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing into form fields (e.g., login screen).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (ALLOWED_KEYS.has(e.key)) {
        e.preventDefault();
        append(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        clear();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleCall();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clear();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [append, backspace, clear, handleCall]);

  const statusLabel =
    sipState === 'registered' ? 'Registered' :
    sipState === 'connecting' ? 'Connecting…' :
    sipState === 'failed' ? 'Connection failed' :
    'Disconnected';

  const statusClass =
    sipState === 'registered' ? 'sip-status ok' :
    sipState === 'failed' ? 'sip-status err' :
    'sip-status warn';

  const heldDisplay = (() => {
    const n = callState.toNumber ?? callState.fromNumber ?? callState.number;
    if (!n) return '';
    const d = n.replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return n;
  })();

  return (
    <div className="dialpad">
      {isAddCall && (
        <button
          type="button"
          className="addcall-banner"
          onClick={() => navigate('/in-call')}
          title="Back to active call"
        >
          <span className="addcall-tag">On hold</span>
          <span className="addcall-num">{heldDisplay}</span>
          <span className="addcall-back">Tap to return</span>
        </button>
      )}
      <div className={statusClass}>{statusLabel}</div>

      <div className="number-display" aria-live="polite">
        {formatNumber(number) || ' '}
      </div>

      <div className="keypad">
        {KEYS.map(({ digit, letters }) => (
          <button
            key={digit}
            type="button"
            className="keypad-btn"
            onClick={() => append(digit)}
          >
            <span className="digit">{digit}</span>
            {letters && <span className="letters">{letters}</span>}
          </button>
        ))}
      </div>

      <div className="call-row">
        <span />
        <button
          type="button"
          className="call-btn"
          onClick={handleCall}
          disabled={!number || sipState !== 'registered'}
          aria-label="Call"
        >
          <Phone size={32} strokeWidth={2} fill="white" />
        </button>
        {number && (
          <button
            type="button"
            className="backspace-btn"
            onClick={backspace}
            aria-label="Delete"
          >
            <Delete size={26} />
          </button>
        )}
      </div>

      <div className="keyboard-hint">
        Type digits with your keyboard · Enter to call · Backspace to delete · Esc to clear
      </div>
    </div>
  );
}
