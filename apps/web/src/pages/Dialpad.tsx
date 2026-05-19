import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Phone, Delete, BookUser, Clock, X } from 'lucide-react';
import { AsYouType, parsePhoneNumberFromString, getCountryCallingCode } from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js/min';
import { useSip } from '../contexts/SipContext';
import { getCalls, type CallRecord } from '../api';
import { formatPhone } from '../lib/phone';
import { getCachedJobDivaName } from '../hooks/useJobDivaContact';

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

// Default country prefix used when the user hasn't typed anything yet.
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
// entered. We ONLY switch off the US default when the number explicitly
// starts with "+" — otherwise a US area code like 973 (NJ) would get
// misread as +973 (Bahrain) and yank the flag away mid-typing.
function detectCountry(num: string): { iso: CountryCode; callingCode: string } {
  const fallback = {
    iso: DEFAULT_COUNTRY,
    callingCode: getCountryCallingCode(DEFAULT_COUNTRY),
  };
  if (!num || !num.startsWith('+')) return fallback;
  try {
    const parsed = parsePhoneNumberFromString(num);
    if (parsed?.country) {
      return { iso: parsed.country, callingCode: getCountryCallingCode(parsed.country) };
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

// As-you-type normalizer: if the raw input looks like a complete international
// number (e.g., "918850415617" = India), auto-prepend "+" so the display
// shows proper E.164 ("+91 88504 15617"). US numbers stay in national format.
function smartNormalize(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('*') || raw.startsWith('#')) return raw; // DTMF probe
  const digits = raw.replace(/[^\d]/g, '');
  // Leave short / US-style entries alone — they'll resolve to +1 at dial time
  // but we don't want to surprise users who are typing a US number.
  if (digits.length <= 10) return raw;
  if (digits.length === 11 && digits.startsWith('1')) return raw;
  // 11+ digits not starting with 1: probe as international. Only auto-add +
  // if libphonenumber agrees it's a valid number with a country code.
  try {
    const parsed = parsePhoneNumberFromString('+' + digits);
    if (parsed?.isValid() && parsed.country) {
      return '+' + digits;
    }
  } catch {
    /* fall through */
  }
  return raw;
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
  // Default to empty so the "Enter phone number" placeholder is visible.
  // Country prefix (+1 by default) is rendered as a separate label to the
  // left of the input so it's always shown without occupying input space.
  const [number, setNumber] = useState('');
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

  const [showContacts, setShowContacts] = useState(false);
  const [recentNumbers, setRecentNumbers] = useState<{ phone: string; label: string; when: string }[]>([]);

  // Lazy-load recents the first time the user opens the contacts panel.
  useEffect(() => {
    if (!showContacts) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    getCalls(token)
      .then((calls: CallRecord[]) => {
        // Dedupe by the other party's number, keep latest per contact.
        const seen = new Map<string, { phone: string; label: string; when: string }>();
        for (const c of calls) {
          const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
          if (!other) continue;
          const key = other.replace(/[^\d]/g, '').slice(-10);
          if (seen.has(key)) continue;
          const name = getCachedJobDivaName(other);
          seen.set(key, {
            phone: other,
            label: name ?? formatPhone(other) ?? other,
            when: c.startedAt,
          });
          if (seen.size >= 15) break;
        }
        setRecentNumbers(Array.from(seen.values()));
      })
      .catch(() => { /* ignore */ });
  }, [showContacts]);

  const append = useCallback((d: string) => setNumber((n) => n + d), []);
  const backspace = useCallback(() => setNumber((n) => n.slice(0, -1)), []);
  // Esc clears the input. The country flag/prefix remains visible on the
  // left as a static label (US default), so the user always sees it.
  const clear = useCallback(() => setNumber(''), []);

  // Anything with at least one dialable digit counts as ready to call.
  const hasDialableInput = number.replace(/[^\d]/g, '').length > 0;

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

      {(() => {
        const country = detectCountry(number);
        return (
          <div className="number-display" aria-live="polite">
            <img
              className="number-display-flag-img"
              src={flagImageUrl(country.iso)}
              alt={country.iso}
              title={country.iso}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
            <span className="number-display-prefix-label">+{country.callingCode}</span>
            <input
              ref={inputRef}
              type="tel"
              inputMode="tel"
              className="number-display-input"
              value={formatNumber(number)}
              placeholder="Enter phone number"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                // Store raw chars; let formatter re-format on next render.
                // smartNormalize prepends '+' when a complete international
                // number is recognized (e.g., 12 digits starting with 91 → India).
                const raw = e.target.value.replace(/[^\d*#+]/g, '');
                setNumber(smartNormalize(raw) || '');
              }}
              onPaste={(e) => {
                // Intercept paste to do smart country-code detection so things
                // like "918850415617" become "+918850415617" with the India flag.
                const text = e.clipboardData?.getData('text');
                if (text) {
                  e.preventDefault();
                  setNumber(parsePastedNumber(text));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleCall();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  clear();
                }
              }}
            />
          </div>
        );
      })()}

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

      <div className="dialpad-actions">
        <button
          type="button"
          className="contacts-btn"
          onClick={() => setShowContacts(true)}
          aria-label="Contacts"
          title="Recent calls"
        >
          <BookUser size={28} />
        </button>
        <button
          type="button"
          className="call-btn"
          onClick={handleCall}
          disabled={!hasDialableInput || sipState !== 'registered'}
          aria-label="Call"
        >
          <Phone size={32} strokeWidth={2} fill="white" />
        </button>
        {hasDialableInput ? (
          <button
            type="button"
            className="backspace-btn"
            onClick={backspace}
            aria-label="Delete"
          >
            <Delete size={26} />
          </button>
        ) : (
          <span className="contacts-btn-spacer" aria-hidden="true" />
        )}
      </div>

      {showContacts && (
        <div className="contacts-quickpick" role="dialog" aria-label="Contacts">
          <div className="contacts-quickpick-box">
            <div className="contacts-quickpick-header">
              <span>Quick pick</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowContacts(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="contacts-quickpick-section">
              <Clock size={12} /> Recent
            </div>
            <ul className="contacts-quickpick-list">
              {recentNumbers.length === 0 && (
                <li className="muted small" style={{ padding: '0.5rem 0.75rem' }}>
                  No recent calls yet.
                </li>
              )}
              {recentNumbers.map((r) => (
                <li key={r.phone}>
                  <button
                    type="button"
                    className="contacts-quickpick-item"
                    onClick={() => {
                      setNumber(r.phone);
                      setShowContacts(false);
                      setTimeout(() => inputRef.current?.focus(), 0);
                    }}
                  >
                    <span className="contacts-quickpick-name">{r.label}</span>
                    <span className="contacts-quickpick-phone">{formatPhone(r.phone)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
