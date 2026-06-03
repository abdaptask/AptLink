// v0.10.72 — User-friendly explanations for Telnyx SMS error codes.
//
// When a message fails (either at send time or later via a delivery_failed
// webhook), Telnyx returns a numeric error code in the `errors` payload.
// Users see codes like "30007" or "40002" with no context. This module
// maps the common ones to plain-English explanations: what happened, why
// it might have happened, what to do about it.
//
// The blurbs are intentionally short — one or two sentences — so they fit
// inline next to a failed-message bubble without overwhelming the UI.
//
// Coverage:
//   * 30xxx range — Carrier-level delivery errors (the common ones)
//   * 40xxx range — Telnyx API validation errors
//   * Generic "unknown" fallback that still gives the user something useful
//     ("the carrier rejected this message") instead of a bare code.
//
// Reference: https://developers.telnyx.com/docs/messaging/error-codes

export interface TelnyxErrorBlurb {
  /** Short label suitable for an inline pill / icon tooltip. */
  short: string;
  /** Longer explanation for click-to-expand UI. */
  detail: string;
  /** Whether the user can usefully retry. False for "wrong number" / opt-out;
   *  true for transient issues like rate-limit. */
  retryable: boolean;
}

const BLURBS: Record<string, TelnyxErrorBlurb> = {
  // 30001 — Queue overflow / too many messages
  '30001': {
    short: 'Too many messages too fast',
    detail: 'The carrier is rate-limiting your number. Wait a few minutes and try again. If this keeps happening, contact admin to check your DID\'s daily/hourly throughput cap.',
    retryable: true,
  },
  // 30002 — Account suspended
  '30002': {
    short: 'Account suspended on Telnyx',
    detail: 'Telnyx has suspended messaging on your sending number. This usually means a billing or compliance issue. Contact admin.',
    retryable: false,
  },
  // 30003 — Unreachable destination handset
  '30003': {
    short: 'Phone is off or out of coverage',
    detail: 'The recipient\'s phone is currently unreachable — turned off, out of coverage, or has a dead battery. Try again later.',
    retryable: true,
  },
  // 30004 — Message blocked
  '30004': {
    short: 'Recipient blocked you',
    detail: 'The recipient has texted STOP at some point or otherwise opted out. Their carrier is blocking all SMS from your DID to their number until they send START.',
    retryable: false,
  },
  // 30005 — Unknown destination handset
  '30005': {
    short: 'Number doesn\'t exist',
    detail: 'The number you sent to isn\'t in service — disconnected, never existed, or ported out and reassigned. Double-check the digits.',
    retryable: false,
  },
  // 30006 — Landline or unreachable carrier
  '30006': {
    short: 'Landline — can\'t receive SMS',
    detail: 'This number is a landline (not a mobile phone) and can\'t receive text messages. Call them instead, or ask for their cell.',
    retryable: false,
  },
  // 30007 — Carrier violation (10DLC / spam filter)
  '30007': {
    short: 'Carrier filtered as spam',
    detail: 'The destination carrier (typically T-Mobile, Verizon, or AT&T) blocked this message — usually because your DID isn\'t registered for 10DLC application-to-person messaging, or the message content triggered a spam filter. Contact admin; this needs 10DLC brand/campaign registration to fix.',
    retryable: false,
  },
  // 30008 — Unknown error
  '30008': {
    short: 'Carrier rejected — reason unknown',
    detail: 'The destination carrier rejected the message but didn\'t say why. Often transient. Try again in a few minutes; if it keeps happening, the recipient\'s carrier may be filtering your DID.',
    retryable: true,
  },
  // 30010 — Missing message body
  '30010': {
    short: 'Empty message',
    detail: 'The message body was empty. Telnyx requires text content (or an MMS attachment) — can\'t send a fully blank SMS.',
    retryable: false,
  },
  // 30011 — Invalid number
  '30011': {
    short: 'Bad recipient number format',
    detail: 'The recipient number isn\'t in a valid format. Make sure it has the country code (e.g. +1 for US, +91 for India).',
    retryable: false,
  },
  // 30022 — Toll-free violation
  '30022': {
    short: 'Toll-free number not verified',
    detail: 'The sending DID is a toll-free number that hasn\'t completed Telnyx\'s toll-free verification. Contact admin to register it.',
    retryable: false,
  },
  // 40002 — Invalid 'to' parameter
  '40002': {
    short: 'Invalid recipient number',
    detail: 'The recipient number was malformed when we sent it to Telnyx. Re-enter the number with country code.',
    retryable: false,
  },
  // 40005 — Missing 'from' parameter
  '40005': {
    short: 'No sending number on your account',
    detail: 'Your account has no DID assigned, so we can\'t send from anywhere. Ask admin to assign you a number in Users → your row → Manage lines.',
    retryable: false,
  },
  // 40010 — Messaging profile not configured
  '40010': {
    short: 'SMS routing not set up',
    detail: 'The Telnyx Messaging Profile isn\'t configured for your DID. Admin needs to bind your number to the ACE messaging profile in Telnyx Portal.',
    retryable: false,
  },
};

/**
 * Convert a Telnyx error payload to a friendly blurb.
 *
 * Accepts:
 *  - A plain error code string ("30007")
 *  - A code number (30007)
 *  - The full Telnyx error envelope ({ errors: [{ code, title, detail }] })
 *  - The status string itself ("delivery_failed", "failed") with no code
 *
 * Returns a blurb regardless — we always say something useful, even if it's
 * generic. Never returns null; null-handling at the call site is unnecessary.
 */
export function telnyxErrorBlurb(input: unknown): TelnyxErrorBlurb {
  // Pull out the first error code we can find.
  let code: string | null = null;

  if (typeof input === 'string') {
    // Either a bare code or a status string. Telnyx codes are all-digit.
    if (/^\d+$/.test(input)) code = input;
  } else if (typeof input === 'number') {
    code = String(input);
  } else if (input && typeof input === 'object') {
    // Telnyx error envelope shapes:
    //   { errors: [{ code: '30007', title: '...', detail: '...' }] }
    //   { code: '30007', ... }
    //   { detail: 'Foo', code: '40002' }
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const first = obj.errors[0] as Record<string, unknown>;
      if (first?.code !== undefined) code = String(first.code);
    } else if (obj.code !== undefined) {
      code = String(obj.code);
    }
  }

  if (code && BLURBS[code]) return BLURBS[code];

  // Generic fallbacks — distinguish "we know nothing" from "we know it's a
  // delivery problem" from "we know it's a send problem".
  if (typeof input === 'string') {
    if (input === 'delivery_failed') {
      return {
        short: 'Carrier didn\'t deliver',
        detail: 'Telnyx accepted the message but the recipient\'s carrier refused to deliver it. Most common reasons: the number is wrong, the recipient opted out, or your DID needs 10DLC registration. Check the recipient number is valid and try again.',
        retryable: true,
      };
    }
    if (input === 'failed') {
      return {
        short: 'Couldn\'t send',
        detail: 'Telnyx rejected the message before sending. Check that the recipient number has a country code and try again. If this keeps happening, contact admin.',
        retryable: true,
      };
    }
  }

  return {
    short: code ? `Error ${code}` : 'Send failed',
    detail: code
      ? `Telnyx returned error code ${code} — we don\'t have a friendly explanation for that specific code yet. The carrier rejected the message. Try again in a few minutes, and if it keeps happening, tell admin to look up code ${code} in Telnyx\'s error reference.`
      : 'Something went wrong sending this message. Try again, and if it keeps happening, contact admin.',
    retryable: true,
  };
}
