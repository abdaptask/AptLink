import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Phone, Delete } from 'lucide-react';
import { AsYouType, parsePhoneNumberFromString, getCountryCallingCode } from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js/min';
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

// Default country prefix shown on first load — users typically dial US numbers.
// Backspace can still erase past this; Esc resets to it.
const DEFAULT_PREFIX = '+1';
const DEFAULT_COUNTRY: CountryCode = 'US';

// SVG flag URL from flagcdn.com (free, no key needed). Works on every OS —
// Windows doesn't render Unicode regional-indicator flags as colored emoji,
// so we use raster/SVG images instead.
function flagImageUrl(iso2: string | undefined | null): string {
  const code = (iso2 ?? 'us').toLowerCase();
  return `https://flagcdn.com/h20/${code}.png`;
}

// Detect the country (and its calling code) from the current number being
// entered. Uses AsYouType so it works on partial input — country is
// determined as soon as enough digits are typed to disambiguate.
function detectCountry(num: string): { iso: CountryCode; callingCode: string } {
  const fallback = {
    iso: DEFAULT_COUNTRY,
    callingCode: getCountryCallingCode(DEFAULT_COUNTRY),
  };
  if (!num) return fallback;
  try {
    const ayt = new AsYouType(DEFAULT_COUNTRY);
    ayt.input(num);
    const iso = ayt.getCountry();
    if (iso) {
      return { iso, callingCode: getCountryCallingCode(iso) };
    }
    if (num.startsWith('+')) {
      const parsed = parsePhoneNumberFromString(num);
      if (parsed?.country) {
        return { iso: parsed.country, callingCode: getCountryCallingCode(parsed.country) };
      }
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

// Progressive phone number formatter using libphonenumber-js's AsYouType.
// Handles "+1 (973) 727-0611", "+44 20 1234 5678", etc. — formats as you type.
function formatNumber(raw: string): string {
  const cleaned = raw.replace(/[^\d*#+]/g, '');
  if (cleaned.length === 0) return '';
  // Allow DTMF chars (* #) only when typed alone; AsYouType drops them.
  if (cleaned === '*' || cleaned === '#' || /^[*#]+$/.test(cleaned)) return cleaned;
  try {
    const fmt = new AsYouType('US');
    const out = fmt.input(cleaned);
    return out || cleaned;
  } catch {
    return cleaned;
  }
}

// Smart paste handler — given clipboard text, returns the best-guess E.164
// representation. Detects country code by trying international parsing first
// (so 12+ digit strings like "918850415617" land as +91 India), then falls
// back to US national if that doesn't validate.
function parsePastedNumber(raw: string): string {
  if (!raw) return DEFAULT_PREFIX;
  const trimmed = raw.trim();
  // If it looks like a SIP URI, extract the user part.
  const sipMatch = /sip:([^@]+)@/i.exec(trimmed);
  const subject = sipMatch ? sipMatch[1] : trimmed;
  // Keep digits and the leading + (if any). Drop everything else.
  let digits = subject.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = '+' + digits.slice(1).replace(/\+/g, '');
  } else {
    digits = digits.replace(/\+/g, '');
  }

  // 1. Already has + prefix → trust it and validate.
  if (digits.startsWith('+')) {
    try {
      const parsed = parsePhoneNumberFromString(digits);
      if (parsed?.isValid()) return parsed.number;
    } catch {
      /* fall through */
    }
    return digits;
  }

  // 2. No prefix — try parsing as INTERNATIONAL by prepending "+".
  // This catches things like "918850415617" (India) or "447911123456" (UK)
  // where the country code is baked into the digits.
  if (digits.length >= 11) {
    try {
      const intl = parsePhoneNumberFromString('+' + digits);
      if (intl?.isValid()) return intl.number;
    } catch {
      /* fall through */
    }
  }

  // 3. Try parsing as US national (10 digits → +1XXXXXXXXXX).
  if (digits.length === 10) {
    try {
      const us = parsePhoneNumberFromString(digits, 'US');
      if (us?.isValid()) return us.number;
    } catch {
      /* fall through */
    }
    return '+1' + digits;
  }

  // 4. 11 digits starting with 1 → US/Canada.
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;

  // 5. Anything else: keep digits, prepend + so the user can see/edit.
  if (digits.length > 0) return '+' + digits;
  return DEFAULT_PREFIX;
}

export default function Dialpad() {
  const [number, setNumber] = useState(DEFAULT_PREFIX);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { sipState, callState, call, addCall } = useSip();
  const navigate = useNavigate();
  const location = useLocation();
  const isAddCall =
    !!(location.state as DialpadLocationState | null)?.addCall &&
    callState.state !== 'idle';

  // Inline status for Add Call. While we wait for Telnyx to register the
  // active leg (so we have a callControlId to bridge with), we show this
  // to the user instead of blocking with an alert.
  const [addCallStatus, setAddCallStatus] = useState<
    | { state: 'idle' }
    | { state: 'preparing' }
    | { state: 'error'; message: string }
  >({ state: 'idle' });

  const append = useCallback((d: string) => setNumber((n) => n + d), []);
  const backspace = useCallback(() => setNumber((n) => n.slice(0, -1)), []);
  // Esc resets to the country-code prefix so users don't have to retype "+1"
  // every time. Use long-press / repeated backspace to wipe completely.
  const clear = useCallback(() => setNumber(DEFAULT_PREFIX), []);

  // Treat "+1" (or just "+") alone as no number entered.
  const hasDialableInput = number.replace(/[^\d]/g, '').length > 0 && number !== DEFAULT_PREFIX;

  const handleCall = useCallback(async () => {
    if (!hasDialableInput) return;
    if (sipState !== 'registered') {
      alert(`Can't call yet — SIP state: ${sipState}. Wait for "Registered" badge above keypad.`);
      return;
    }
    if (isAddCall) {
      // Server-originated Leg B via Telnyx Call Control. addCall() waits up
      // to 15s for the leg's callControlId to arrive before failing, so we
      // show an inline "Preparing…" state during that window.
      setAddCallStatus({ state: 'preparing' });
      const res = await addCall(number);
      if (!res.ok) {
        setAddCallStatus({
          state: 'error',
          message: res.hint ?? res.error ?? 'Add Call failed.',
        });
        return;
      }
      setAddCallStatus({ state: 'idle' });
    } else {
      call(number);
    }
    navigate('/in-call');
  }, [number, hasDialableInput, sipState, isAddCall, call, addCall, navigate]);

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
    // Paste: clipboard → smart-parse → set as number. Handles things like
    // "+1 (973) 727-0611", "973.727.0611", "tel:+15555550100", SIP URIs.
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return; // let the form field handle it
      }
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      setNumber(parsePastedNumber(text));
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
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

      {addCallStatus.state === 'preparing' && (
        <div className="addcall-status preparing" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="addcall-status-text">
            Preparing call via Telnyx Call Control…
          </span>
          <button
            type="button"
            className="addcall-status-cancel"
            onClick={() => setAddCallStatus({ state: 'idle' })}
          >
            Cancel
          </button>
        </div>
      )}
      {addCallStatus.state === 'error' && (
        <div className="addcall-status error" role="alert">
          <span className="addcall-status-text">{addCallStatus.message}</span>
          <button
            type="button"
            className="addcall-status-cancel"
            onClick={() => setAddCallStatus({ state: 'idle' })}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="dialpad-top">
        <div className={statusClass}>{statusLabel}</div>
        <div className="keyboard-hint top">
          Type · Paste · Enter to call · Backspace to delete · Esc to clear
        </div>
      </div>

      <div className="number-display" aria-live="polite">
        <img
          className="number-display-flag-img"
          src={flagImageUrl(detectCountry(number).iso)}
          alt={detectCountry(number).iso}
          title={detectCountry(number).iso}
          onError={(e) => {
            // If the flag CDN is unreachable, hide the broken image gracefully.
            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
          }}
        />
        <input
          ref={inputRef}
          type="tel"
          inputMode="tel"
          className="number-display-input"
          value={formatNumber(number)}
          placeholder="(000) 000-0000"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            // Store the raw chars (digits + + * #) and let the formatter
            // re-format on next render. Keeps cursor reasonably stable.
            const raw = e.target.value.replace(/[^\d*#+]/g, '');
            setNumber(raw || '');
          }}
        />
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
          disabled={!hasDialableInput || sipState !== 'registered'}
          aria-label="Call"
        >
          <Phone size={32} strokeWidth={2} fill="white" />
        </button>
        {hasDialableInput && (
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
    </div>
  );
}
