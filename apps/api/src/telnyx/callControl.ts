// Thin wrapper around the Telnyx Voice API v2 actions we use.
// Docs: https://developers.telnyx.com/api/call-control
import { config } from '../config.js';

const BASE = 'https://api.telnyx.com/v2';

export interface TelnyxResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: unknown;
}

async function call<T = unknown>(path: string, init: RequestInit): Promise<TelnyxResult<T>> {
  if (!config.telnyxApiKey) {
    return { ok: false, status: 0, error: 'TELNYX_API_KEY not set' };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.telnyxApiKey}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, ...(res.ok ? { data: body } : { error: body }) };
}

// Encode an arbitrary JSON-able value into Telnyx's base64 `client_state` slot.
// Telnyx echoes this back on every webhook for the call, so we use it to carry
// "what to do when this leg answers" instructions (e.g. bridge to leg A).
export function encodeClientState(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

// Normalize a user-typed phone number (or SIP URI) into the +E.164 format
// Telnyx Voice API requires (error code 10016 otherwise).
//   "9737270611"     → "+19737270611"
//   "(973) 727-0611" → "+19737270611"
//   "1-973-727-0611" → "+19737270611"
//   "+44 20 1234..." → "+44201234..."
//   "sip:bob@..."    → "sip:bob@..." (untouched)
export function normalizeToE164(raw: string): string {
  const s = (raw ?? '').trim();
  if (s.toLowerCase().startsWith('sip:')) return s;
  const cleaned = s.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

export function decodeClientState<T = Record<string, unknown>>(s: string | undefined | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

// Originate a new outbound call via Call Control. Returns the new call's
// call_control_id, which is available *immediately* (unlike SDK-originated
// calls where we have to wait for the webhook to fire).
export function dial(opts: {
  to: string;
  from: string;
  connectionId: string;
  clientState?: string;
  // 'normal' (default) | 'tollfree' | 'special'
  webhookUrl?: string;
}): Promise<TelnyxResult<{ data: { call_control_id: string; call_leg_id: string; call_session_id: string } }>> {
  return call('/calls', {
    method: 'POST',
    body: JSON.stringify({
      to: opts.to,
      from: opts.from,
      connection_id: opts.connectionId,
      ...(opts.clientState ? { client_state: opts.clientState } : {}),
      ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
    }),
  });
}

// Bridge two existing legs together (legacy 2-leg pattern — limited:
// when one leg hangs up, the other ends too).
export function bridge(legA: string, legB: string): Promise<TelnyxResult> {
  return call(`/calls/${encodeURIComponent(legA)}/actions/bridge`, {
    method: 'POST',
    body: JSON.stringify({ call_control_id: legB }),
  });
}

// Create a Telnyx Conference with one initial participant. Returns the
// conference id, which subsequent legs can join via conferenceJoin().
// Use this for proper N-way conferences where each leg can hang up
// independently without ending the whole call.
export function conferenceCreate(
  name: string,
  initialCallControlId: string,
  opts: { endConfOnExit?: boolean; beepEnabled?: 'always' | 'on_enter' | 'on_exit' | 'never' } = {},
): Promise<TelnyxResult<{ data: { id: string; name: string; status: string } }>> {
  return call('/conferences', {
    method: 'POST',
    body: JSON.stringify({
      name,
      call_control_id: initialCallControlId,
      end_conference_on_exit: opts.endConfOnExit ?? false,
      beep_enabled: opts.beepEnabled ?? 'never',
    }),
  });
}

// Add an existing leg to an active conference.
export function conferenceJoin(
  conferenceId: string,
  callControlId: string,
  opts: { endConfOnExit?: boolean } = {},
): Promise<TelnyxResult> {
  return call(`/conferences/${encodeURIComponent(conferenceId)}/actions/join`, {
    method: 'POST',
    body: JSON.stringify({
      call_control_id: callControlId,
      end_conference_on_exit: opts.endConfOnExit ?? false,
    }),
  });
}

// Blind transfer the call to a new destination. The original WebRTC leg drops
// off and the third party is connected directly to the transfer target.
export function transfer(legControlId: string, opts: { to: string; from: string }): Promise<TelnyxResult> {
  return call(`/calls/${encodeURIComponent(legControlId)}/actions/transfer`, {
    method: 'POST',
    body: JSON.stringify({ to: opts.to, from: opts.from }),
  });
}

export function recordStart(legControlId: string): Promise<TelnyxResult> {
  return call(`/calls/${encodeURIComponent(legControlId)}/actions/record_start`, {
    method: 'POST',
    body: JSON.stringify({ format: 'mp3', channels: 'dual' }),
  });
}

export function recordStop(legControlId: string): Promise<TelnyxResult> {
  return call(`/calls/${encodeURIComponent(legControlId)}/actions/record_stop`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function hangupCall(legControlId: string): Promise<TelnyxResult> {
  return call(`/calls/${encodeURIComponent(legControlId)}/actions/hangup`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
