// Shared phone-number formatting helper.
// Uses libphonenumber-js so we render +44, +91, +52, etc. correctly instead
// of the homegrown US-only formatter that each page used to inline.
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Default region for numbers without a country code. Tweak per deployment. */
const DEFAULT_COUNTRY: CountryCode = 'US';

/**
 * Format a phone for display.
 *   US 10-digit "9737270611"     → "(973) 727-0611"
 *   US E.164 "+19737270611"      → "(973) 727-0611"
 *   UK "+442012345678"           → "020 1234 5678"
 *   India "+919876543210"        → "098765 43210"
 *   SIP URI "sip:bob@x.com"      → "sip:bob@x.com" (untouched)
 * Falls back to the input string if parsing fails.
 */
export function formatPhone(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  // Untouched: SIP URIs, anything containing alpha chars before parsing.
  if (/^sip:/i.test(trimmed)) return trimmed;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
    if (!parsed) return trimmed;
    if (parsed.country === DEFAULT_COUNTRY) {
      // National format for the user's home country looks more natural
      // ("(973) 727-0611" rather than "+1 973-727-0611").
      return parsed.formatNational();
    }
    return parsed.formatInternational();
  } catch {
    return trimmed;
  }
}

/** Normalize to +E.164. Used before sending to the server. */
export function toE164(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (/^sip:/i.test(trimmed)) return trimmed;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
    if (parsed?.isValid()) return parsed.number; // already +E.164
  } catch {
    // fall through
  }
  // Fallback that matches our pre-existing logic for US 10/11-digit input.
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

/** Last 10 digits — used for cross-table matching tolerant of formatting. */
export function last10Digits(raw: string | undefined | null): string {
  return String(raw ?? '').replace(/[^\d]/g, '').slice(-10);
}
